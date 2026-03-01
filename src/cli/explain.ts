import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveApiKey } from "../config/loader.js";
import { createLlmClient } from "../llm/client.js";
import { readLangSmithTraces } from "../ingestion/langsmith.js";
import { readJsonTraces } from "../ingestion/json.js";
import { readOtelTraces } from "../ingestion/otel.js";
import type { NormalizedConversation } from "../ingestion/types.js";
import { PoliciesFileSchema, type Policy } from "../policy/types.js";
import { evaluateConversation } from "../evaluation/evaluator.js";
import { checkPolicies } from "../evaluation/policy-checker.js";
import { buildDiagnosisPrompt } from "../llm/prompts.js";
import { parseJsonResponse } from "../llm/json.js";
import type { ConversationResult, Diagnosis, Report } from "../evaluation/types.js";
import { parseDuration, createLogger } from "./filters.js";

interface ExplainOptions {
  langsmith?: string;
  traces?: string;
  otel?: string;
  policies?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  langsmithApiKey?: string;
  worst?: boolean;
  since?: string;
  agent?: string;
  format?: string;
}

export async function explainCommand(
  conversationId: string | undefined,
  options: ExplainOptions,
): Promise<void> {
  const jsonMode = options.format === "json";
  const log = createLogger(jsonMode);

  // If --worst, find the worst conversation from an existing report
  if (options.worst || !conversationId) {
    return explainWorst(options, log, jsonMode);
  }

  // Try to find the conversation in an existing report first (zero LLM cost)
  const reportPath = resolve(process.cwd(), "report.json");
  if (existsSync(reportPath)) {
    const report = JSON.parse(await readFile(reportPath, "utf-8")) as Report;
    const existing = report.conversations.find((c) => c.id === conversationId);

    if (existing?.diagnosis) {
      log.log(`Found diagnosis in existing report.\n`);
      const conv = findConversationMessages(report, conversationId);
      outputExplanation(existing, conv, jsonMode);
      return;
    }

    // Conversation is in report but has no diagnosis — generate one
    if (existing) {
      log.log(`Conversation found in report but not diagnosed. Generating diagnosis...\n`);
      const conv = findConversationMessages(report, conversationId);
      if (conv) {
        const diagnosis = await diagnoseOnDemand(existing, conv, report, options, log);
        if (diagnosis) existing.diagnosis = diagnosis;
        outputExplanation(existing, conv, jsonMode);
        return;
      }
    }
  }

  // Not in report — fetch from trace source, evaluate, diagnose
  if (!options.langsmith && !options.traces && !options.otel) {
    console.error(
      `Error: Conversation "${conversationId}" not found in report.json.\n` +
        "Provide a trace source to fetch it: --langsmith, --traces, or --otel.",
    );
    process.exit(1);
  }

  log.log(`Conversation not in report. Fetching and evaluating...\n`);
  const conv = await fetchConversation(conversationId, options, log);
  if (!conv) {
    console.error(`Error: Conversation "${conversationId}" not found.`);
    process.exit(1);
  }

  const result = await evaluateAndDiagnose(conv, options, log);
  outputExplanation(result, conv, jsonMode);
}

async function explainWorst(
  options: ExplainOptions,
  log: ReturnType<typeof createLogger>,
  jsonMode: boolean,
): Promise<void> {
  const reportPath = resolve(process.cwd(), "report.json");
  if (!existsSync(reportPath)) {
    console.error(
      "Error: No report.json found. Run `agent-triage analyze` first,\n" +
        "or provide a conversation ID: `agent-triage explain <id>`.",
    );
    process.exit(1);
  }

  const report = JSON.parse(await readFile(reportPath, "utf-8")) as Report;

  // Find the worst conversation (most policy failures, lowest avg metrics)
  const scored = report.conversations
    .map((c) => ({
      result: c,
      failCount: c.policyResults.filter((pr) => !pr.passed).length,
      avgScore: averageMetrics(c.metrics),
    }))
    .filter((s) => s.failCount > 0)
    .sort((a, b) => b.failCount - a.failCount || a.avgScore - b.avgScore);

  if (scored.length === 0) {
    log.log("No failing conversations found. All policies passing.");
    return;
  }

  const worst = scored[0].result;
  log.log(`Worst conversation: ${worst.id}\n`);

  // If it already has a diagnosis, show it
  if (worst.diagnosis) {
    const conv = findConversationMessages(report, worst.id);
    outputExplanation(worst, conv, jsonMode);
    return;
  }

  // Generate diagnosis on demand
  const conv = findConversationMessages(report, worst.id);
  if (conv) {
    const diagnosis = await diagnoseOnDemand(worst, conv, report, options, log);
    if (diagnosis) worst.diagnosis = diagnosis;
  }
  outputExplanation(worst, conv, jsonMode);
}

function findConversationMessages(
  report: Report,
  id: string,
): NormalizedConversation | undefined {
  const result = report.conversations.find((c) => c.id === id);
  if (!result || result.messages.length === 0) return undefined;

  return {
    id,
    messages: result.messages,
    metadata: { source: "json" },
    timestamp: report.generatedAt,
  };
}

async function diagnoseOnDemand(
  result: ConversationResult,
  conv: NormalizedConversation,
  report: Report,
  options: ExplainOptions,
  log: ReturnType<typeof createLogger>,
): Promise<Diagnosis | undefined> {
  const config = await loadConfig({
    prompt: { path: options.prompt ?? "." },
    ...(options.provider || options.model || options.apiKey
      ? {
          llm: {
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          },
        }
      : {}),
  });

  const apiKey = resolveApiKey(config);
  const llm = createLlmClient(config.llm.provider, apiKey, config.llm.model, config.llm.baseUrl);

  const systemPrompt = report.agent.promptContent ?? "";
  const transcript = conv.messages
    .map((msg, i) => `Turn ${i + 1} [${msg.role}]: ${msg.content}`)
    .join("\n\n");

  const prompt = buildDiagnosisPrompt(systemPrompt, transcript, result.policyResults);

  try {
    log.log("Generating diagnosis...");
    const response = await llm.call(prompt, { temperature: 0.3, maxTokens: 2048 });
    const parsed = parseJsonResponse(response.content) as Record<string, unknown>;

    return {
      rootCauseTurn: Number(parsed.rootCauseTurn ?? 1),
      rootCauseAgent: parsed.rootCauseAgent ? String(parsed.rootCauseAgent) : null,
      shortSummary: String(parsed.shortSummary ?? ""),
      summary: String(parsed.summary ?? ""),
      impact: String(parsed.impact ?? ""),
      cascadeChain: Array.isArray(parsed.cascadeChain) ? parsed.cascadeChain.map(String) : [],
      fix: String(parsed.fix ?? ""),
      severity: validateEnum(parsed.severity, ["critical", "major", "minor"], "major") as Diagnosis["severity"],
      confidence: validateEnum(parsed.confidence, ["high", "medium", "low"], "medium") as Diagnosis["confidence"],
      failureType: validateEnum(parsed.failureType, ["prompt_issue", "orchestration_issue", "model_limitation", "retrieval_rag_issue"], "prompt_issue") as Diagnosis["failureType"],
      failureSubtype: String(parsed.failureSubtype ?? ""),
      blastRadius: Array.isArray(parsed.blastRadius) ? parsed.blastRadius.map(String) : [],
    };
  } catch (error) {
    log.warn(`Warning: Could not generate diagnosis: ${error}`);
    return undefined;
  }
}

async function fetchConversation(
  id: string,
  options: ExplainOptions,
  log: ReturnType<typeof createLogger>,
): Promise<NormalizedConversation | undefined> {
  let conversations: NormalizedConversation[] = [];

  if (options.langsmith) {
    const config = await loadConfig({ prompt: { path: "." } });
    const apiKey = options.langsmithApiKey ?? process.env.LANGSMITH_API_KEY ?? config.traces?.apiKey;
    if (!apiKey) {
      console.error("Error: No LangSmith API key found.");
      process.exit(1);
    }
    log.log(`Fetching from LangSmith project: ${options.langsmith}...`);
    conversations = await readLangSmithTraces({
      apiKey,
      project: options.langsmith,
      baseUrl: config.traces?.baseUrl,
      limit: 200,
    });
  } else if (options.traces) {
    conversations = await readJsonTraces(options.traces);
  } else if (options.otel) {
    conversations = await readOtelTraces(options.otel);
  }

  return conversations.find((c) => c.id === id);
}

async function evaluateAndDiagnose(
  conv: NormalizedConversation,
  options: ExplainOptions,
  log: ReturnType<typeof createLogger>,
): Promise<ConversationResult> {
  const config = await loadConfig({
    prompt: { path: options.prompt ?? "." },
    ...(options.provider || options.model || options.apiKey
      ? {
          llm: {
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          },
        }
      : {}),
  });

  const apiKey = resolveApiKey(config);
  const llm = createLlmClient(config.llm.provider, apiKey, config.llm.model, config.llm.baseUrl);

  // Load policies
  const policiesPath = resolve(process.cwd(), options.policies ?? "policies.json");
  let policies: Policy[] = [];
  if (existsSync(policiesPath)) {
    const policiesRaw = await readFile(policiesPath, "utf-8");
    policies = PoliciesFileSchema.parse(JSON.parse(policiesRaw));
  }

  const systemPrompt = conv.systemPrompt ?? "";

  log.log(`Evaluating conversation ${conv.id}...`);
  const [metrics, policyResults] = await Promise.all([
    evaluateConversation(llm, conv, systemPrompt),
    policies.length > 0
      ? checkPolicies(llm, conv, policies, systemPrompt)
      : Promise.resolve([]),
  ]);

  const result: ConversationResult = {
    id: conv.id,
    metrics,
    policyResults,
    messages: conv.messages,
  };

  // Always diagnose in explain mode
  const hasFailures = policyResults.some((pr) => !pr.passed);
  if (hasFailures) {
    log.log("Generating diagnosis...");
    const transcript = conv.messages
      .map((msg, i) => `Turn ${i + 1} [${msg.role}]: ${msg.content}`)
      .join("\n\n");

    const prompt = buildDiagnosisPrompt(systemPrompt, transcript, policyResults);
    try {
      const response = await llm.call(prompt, { temperature: 0.3, maxTokens: 2048 });
      const parsed = parseJsonResponse(response.content) as Record<string, unknown>;
      result.diagnosis = {
        rootCauseTurn: Number(parsed.rootCauseTurn ?? 1),
        rootCauseAgent: parsed.rootCauseAgent ? String(parsed.rootCauseAgent) : null,
        shortSummary: String(parsed.shortSummary ?? ""),
        summary: String(parsed.summary ?? ""),
        impact: String(parsed.impact ?? ""),
        cascadeChain: Array.isArray(parsed.cascadeChain) ? parsed.cascadeChain.map(String) : [],
        fix: String(parsed.fix ?? ""),
        severity: validateEnum(parsed.severity, ["critical", "major", "minor"], "major") as Diagnosis["severity"],
        confidence: validateEnum(parsed.confidence, ["high", "medium", "low"], "medium") as Diagnosis["confidence"],
        failureType: validateEnum(parsed.failureType, ["prompt_issue", "orchestration_issue", "model_limitation", "retrieval_rag_issue"], "prompt_issue") as Diagnosis["failureType"],
        failureSubtype: String(parsed.failureSubtype ?? ""),
        blastRadius: Array.isArray(parsed.blastRadius) ? parsed.blastRadius.map(String) : [],
      };
    } catch (error) {
      log.warn(`Warning: Could not generate diagnosis: ${error}`);
    }
  }

  return result;
}

function outputExplanation(
  result: ConversationResult,
  conv: NormalizedConversation | undefined,
  jsonMode: boolean,
): void {
  if (jsonMode) {
    console.log(JSON.stringify(result));
    return;
  }

  const d = result.diagnosis;
  const failCount = result.policyResults.filter((pr) => !pr.passed).length;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Conversation: ${result.id}`);
  if (d) {
    console.log(`  Severity: ${d.severity.toUpperCase()}`);
    console.log(`  Root Cause: Step ${d.rootCauseTurn}${d.rootCauseAgent ? ` (${d.rootCauseAgent})` : ""}`);
  }
  console.log(`${"─".repeat(60)}`);

  // Show conversation timeline with annotations
  if (conv && conv.messages.length > 0) {
    const failingTurns = new Set<number>();
    for (const pr of result.policyResults) {
      if (!pr.passed && pr.failingTurns) {
        for (const t of pr.failingTurns) failingTurns.add(t);
      }
    }

    console.log(`\n  Timeline:`);
    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      const turnNum = i + 1;
      const content = msg.content.length > 120
        ? msg.content.slice(0, 120) + "..."
        : msg.content;

      let annotation = "";
      if (d && turnNum === d.rootCauseTurn) annotation = " ← ROOT CAUSE";
      else if (failingTurns.has(turnNum)) annotation = " ← VIOLATION";

      console.log(`    Step ${turnNum} [${msg.role}]: ${content}${annotation}`);
    }
  }

  // Diagnosis details
  if (d) {
    console.log(`\n  Summary: ${d.summary}`);

    if (d.cascadeChain.length > 0) {
      console.log(`\n  Cascade Chain:`);
      for (const step of d.cascadeChain) {
        console.log(`    → ${step}`);
      }
    }

    console.log(`\n  Impact: ${d.impact}`);
  }

  // Policy results
  const failing = result.policyResults.filter((pr) => !pr.passed);
  if (failing.length > 0) {
    console.log(`\n  Policies Failed (${failing.length}):`);
    for (const pr of failing) {
      console.log(`    ✗ ${pr.policyId} — ${pr.evidence}`);
    }
  } else {
    console.log(`\n  All policies passing.`);
  }

  // Suggested fix
  if (d?.fix) {
    console.log(`\n  Suggested Fix:`);
    console.log(`    ${d.fix}`);
    if (d.blastRadius.length > 0) {
      console.log(`\n  Blast Radius:`);
      for (const p of d.blastRadius) {
        console.log(`    ⚠ ${p}`);
      }
    }
  }

  console.log("");
}

function averageMetrics(metrics: Record<string, number>): number {
  const values = Object.values(metrics);
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function validateEnum(val: unknown, valid: string[], fallback: string): string {
  const s = String(val).toLowerCase();
  return valid.includes(s) ? s : fallback;
}
