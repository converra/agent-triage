import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import {
  readJsonTraces,
  readLangSmithTraces,
  readOtelTraces,
  loadConfig,
  resolveApiKey,
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
import type { Diagnosis, ConversationResult } from "../evaluation/types.js";

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

export async function resolveLlm(overrides?: {
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

  const apiKey = resolveApiKey(config);
  return createLlmClient(
    config.llm.provider,
    apiKey,
    config.llm.model,
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
  since?: string;
  until?: string;
}): Promise<NormalizedConversation[]> {
  if (params.traces) {
    return readJsonTraces(resolve(process.cwd(), params.traces));
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
    return readOtelTraces(resolve(process.cwd(), params.otel));
  }

  throw new Error(
    "No trace source specified. Provide one of: traces (JSON file path), langsmith (project name), or otel (OTLP/JSON file path).",
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
  const policiesPath = resolve(process.cwd(), path ?? "policies.json");
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

export function averageMetrics(metrics: Record<string, number>): number {
  const values = Object.values(metrics);
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

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

function validateEnum(val: unknown, valid: string[], fallback: string): string {
  const s = String(val).toLowerCase();
  return valid.includes(s) ? s : fallback;
}

export async function generateDiagnosisForResult(
  llm: LlmClient,
  result: ConversationResult,
  systemPrompt: string,
): Promise<Diagnosis | undefined> {
  const transcript = result.messages
    .map((msg, i) => `Turn ${i + 1} [${msg.role}]: ${msg.content}`)
    .join("\n\n");

  const prompt = buildDiagnosisPrompt(systemPrompt, transcript, result.policyResults);

  try {
    const response = await llm.call(prompt, { temperature: 0.3, maxTokens: 2048 });
    const parsed = parseJsonResponse(response.content) as Record<string, unknown>;

    return {
      rootCauseTurn: Number(parsed.rootCauseTurn ?? 1),
      rootCauseAgent: parsed.rootCauseAgent ? String(parsed.rootCauseAgent) : null,
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
  } catch {
    return undefined;
  }
}
