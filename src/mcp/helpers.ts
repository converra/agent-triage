import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLogger } from "../logger.js";

/**
 * Ensure a resolved path stays within the CWD boundary.
 * Prevents MCP clients from reading/writing arbitrary files via path traversal.
 */
export function safePath(userPath: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, userPath);
  if (!resolved.startsWith(cwd + "/") && resolved !== cwd) {
    throw new Error(`Path "${userPath}" resolves outside the working directory.`);
  }
  return resolved;
}

import {
  readJsonTraces,
  readLangSmithTraces,
  readOtelTraces,
  readAxiomTraces,
  readLangfuseTraces,
  loadConfig,
  resolveLlm,
  createLlmClient,
  applyFilters,
  parseDuration,
  parseJsonResponse,
} from "../index.js";

import type {
  NormalizedConversation,
  Policy,
  LlmClient,
} from "../index.js";

import { PoliciesFileSchema } from "../policy/types.js";
import { buildDiagnosisPrompt } from "../llm/prompts.js";
import { parseTurnDescriptions } from "../evaluation/diagnosis.js";
import type { Diagnosis, ConversationResult } from "../evaluation/types.js";
import { formatTranscript, validateEnum } from "../evaluation/shared.js";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

// ---------------------------------------------------------------------------
// LLM / Config helpers
// ---------------------------------------------------------------------------

export async function createLlmFromOptions(overrides?: {
  provider?: string;
  model?: string;
  apiKey?: string;
}): Promise<LlmClient> {
  const config = await loadConfig({
    prompt: { path: "." },
    ...(overrides?.provider || overrides?.model || overrides?.apiKey
      ? {
          llm: {
            ...(overrides.provider ? { provider: overrides.provider } : {}),
            ...(overrides.model ? { model: overrides.model } : {}),
            ...(overrides.apiKey ? { apiKey: overrides.apiKey } : {}),
          },
        }
      : {}),
  });

  const resolved = await resolveLlm(config);
  return createLlmClient(
    resolved.provider,
    resolved.apiKey,
    resolved.model,
    config.llm.baseUrl,
  );
}

// ---------------------------------------------------------------------------
// Trace ingestion
// ---------------------------------------------------------------------------

export async function ingestTraces(params: {
  traces?: string;
  langsmith?: string;
  otel?: string;
  axiom?: string;
  axiom_org_id?: string;
  langfuse?: boolean;
  langfuse_public_key?: string;
  langfuse_secret_key?: string;
  langfuse_host?: string;
  since?: string;
  until?: string;
}): Promise<NormalizedConversation[]> {
  if (params.traces) {
    return readJsonTraces(safePath(params.traces));
  }

  if (params.langsmith) {
    const config = await loadConfig({ prompt: { path: "." } });
    const apiKey =
      process.env.LANGSMITH_API_KEY ?? config.traces?.apiKey;
    if (!apiKey) {
      throw new Error(
        "No LangSmith API key found. Set LANGSMITH_API_KEY environment variable.",
      );
    }
    return readLangSmithTraces({
      apiKey,
      project: params.langsmith,
      baseUrl: config.traces?.baseUrl,
      startTime: params.since ? parseDuration(params.since) : undefined,
      endTime: params.until ? parseDuration(params.until) : undefined,
    });
  }

  if (params.otel) {
    return readOtelTraces(safePath(params.otel));
  }

  if (params.axiom) {
    const apiKey = process.env.AXIOM_API_KEY;
    if (!apiKey) {
      throw new Error(
        "No Axiom API key found. Set AXIOM_API_KEY environment variable.",
      );
    }
    return readAxiomTraces({
      apiKey,
      dataset: params.axiom,
      orgId: params.axiom_org_id,
      startTime: params.since ? parseDuration(params.since) : undefined,
      endTime: params.until ? parseDuration(params.until) : undefined,
    });
  }

  if (params.langfuse) {
    const publicKey = params.langfuse_public_key ?? process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = params.langfuse_secret_key ?? process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey) {
      throw new Error(
        "Langfuse credentials required. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY environment variables.",
      );
    }
    return readLangfuseTraces({
      publicKey,
      secretKey,
      host: params.langfuse_host ?? process.env.LANGFUSE_HOST,
      startTime: params.since ? parseDuration(params.since) : undefined,
      endTime: params.until ? parseDuration(params.until) : undefined,
    });
  }

  throw new Error(
    "No trace source specified. Provide traces (path to a JSON file — recommended, instant, flexible format) or alternatively langsmith (project name), otel (OTLP/JSON file path), axiom (dataset name), or langfuse (boolean).",
  );
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function filterByQuery(
  conversations: NormalizedConversation[],
  query: string,
): NormalizedConversation[] {
  const lower = query.toLowerCase();
  return conversations.filter((c) =>
    c.messages.some((m) => m.content.toLowerCase().includes(lower)),
  );
}

export function loadPoliciesFromFile(path?: string): Policy[] {
  const policiesPath = safePath(path ?? "policies.json");
  if (!existsSync(policiesPath)) {
    throw new Error(
      `No policies.json found at ${policiesPath}. Run triage_init or triage_analyze first.`,
    );
  }

  const raw = readFileSync(policiesPath, "utf-8");
  return PoliciesFileSchema.parse(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// Diagnosis helpers
// ---------------------------------------------------------------------------

export { averageMetrics } from "../evaluation/shared.js";

export function formatExplanation(result: ConversationResult) {
  const d = result.diagnosis;
  const failingPolicies = result.policyResults
    .filter((pr) => !pr.passed)
    .map((pr) => ({
      policyId: pr.policyId,
      evidence: pr.evidence,
      failingTurns: pr.failingTurns,
      failureType: pr.failureType,
    }));

  return {
    conversationId: result.id,
    metrics: result.metrics,
    failingPolicies,
    diagnosis: d
      ? {
          severity: d.severity,
          confidence: d.confidence,
          rootCauseTurn: d.rootCauseTurn,
          rootCauseAgent: d.rootCauseAgent,
          summary: d.summary,
          impact: d.impact,
          cascadeChain: d.cascadeChain,
          failureType: d.failureType,
          failureSubtype: d.failureSubtype,
          fix: d.fix,
          blastRadius: d.blastRadius,
        }
      : null,
    turnCount: result.messages.length,
    timeline: result.messages.map((msg, i) => ({
      turn: i + 1,
      role: msg.role,
      content: msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content,
      isRootCause: d ? i + 1 === d.rootCauseTurn : false,
      isViolation: failingPolicies.some((fp) => fp.failingTurns?.includes(i + 1)),
    })),
  };
}

export async function generateDiagnosisForResult(
  llm: LlmClient,
  result: ConversationResult,
  systemPrompt: string,
): Promise<Diagnosis | undefined> {
  const transcript = formatTranscript(result);

  const prompt = buildDiagnosisPrompt(systemPrompt, transcript, result.policyResults);

  try {
    const response = await llm.call(prompt, { temperature: 0.3, maxTokens: 2048 });
    const parsed = parseJsonResponse(response.content) as Record<string, unknown>;

    const rawRootTurn = Number(parsed.rootCauseTurn ?? 1);
    const clampedRootTurn = Math.max(1, Math.min(rawRootTurn, result.messages.length || 1));

    return {
      rootCauseTurn: clampedRootTurn,
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
      turnDescriptions: parseTurnDescriptions(parsed.turnDescriptions),
    };
  } catch (error) {
    getLogger().error(`[agent-triage] Diagnosis generation failed: ${error}`);
    return undefined;
  }
}
