import { LlmClient } from "../llm/client.js";
import { buildDiagnosisPrompt } from "../llm/prompts.js";
import { parseJsonResponse } from "../llm/json.js";
import type { Diagnosis, ConversationResult, MetricScores } from "./types.js";
import type { NormalizedConversation } from "../ingestion/types.js";

const TOP_N_WORST = 10;

/**
 * Generate step-level diagnosis for the worst conversations.
 * Selects bottom N by aggregate metric score, runs 1 LLM call per conversation.
 */
export async function generateDiagnoses(
  llm: LlmClient,
  results: ConversationResult[],
  conversations: NormalizedConversation[],
  systemPrompt: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  // Find worst conversations: policy failures OR low metric scores (< 75 avg)
  const scored = results
    .map((r) => ({
      result: r,
      avgScore: averageMetrics(r.metrics),
      failCount: r.policyResults.filter((pr) => !pr.passed).length,
    }))
    .filter((s) => s.failCount > 0 || s.avgScore < 75)
    .sort((a, b) => a.avgScore - b.avgScore);

  const worst = scored.slice(0, TOP_N_WORST);

  if (worst.length === 0) return;

  const convMap = new Map(conversations.map((c) => [c.id, c]));

  for (let i = 0; i < worst.length; i++) {
    const { result } = worst[i]!;
    const conv = convMap.get(result.id);
    if (!conv) continue;

    onProgress?.(i + 1, worst.length);

    try {
      const diagnosis = await diagnoseSingle(llm, conv, result, systemPrompt);
      result.diagnosis = diagnosis;
    } catch (error) {
      console.warn(
        `  Warning: Could not generate diagnosis for ${result.id}: ${error}`,
      );
    }
  }
}

async function diagnoseSingle(
  llm: LlmClient,
  conversation: NormalizedConversation,
  result: ConversationResult,
  systemPrompt: string,
): Promise<Diagnosis> {
  const transcript = conversation.messages
    .map((msg, i) => `Turn ${i + 1} [${msg.role}]: ${msg.content}`)
    .join("\n\n");

  const prompt = buildDiagnosisPrompt(
    systemPrompt,
    transcript,
    result.policyResults,
  );

  const response = await llm.call(prompt, {
    temperature: 0.3,
    maxTokens: 2048,
  });

  const parsed = parseJsonResponse(response.content) as Record<string, unknown>;

  return {
    rootCauseTurn: Number(parsed.rootCauseTurn ?? 1),
    rootCauseAgent: parsed.rootCauseAgent
      ? String(parsed.rootCauseAgent)
      : null,
    summary: String(parsed.summary ?? ""),
    impact: String(parsed.impact ?? ""),
    cascadeChain: Array.isArray(parsed.cascadeChain)
      ? parsed.cascadeChain.map(String)
      : [],
    fix: String(parsed.fix ?? ""),
    severity: validateSeverity(parsed.severity),
    confidence: validateConfidence(parsed.confidence),
    failureType: validateFailureType(parsed.failureType),
    failureSubtype: String(parsed.failureSubtype ?? ""),
    blastRadius: Array.isArray(parsed.blastRadius)
      ? parsed.blastRadius.map(String)
      : [],
  };
}

function averageMetrics(metrics: MetricScores): number {
  const values = Object.values(metrics);
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function validateSeverity(val: unknown): "critical" | "major" | "minor" {
  const s = String(val).toLowerCase();
  if (s === "critical" || s === "major" || s === "minor") return s;
  return "major";
}

function validateConfidence(val: unknown): "high" | "medium" | "low" {
  const s = String(val).toLowerCase();
  if (s === "high" || s === "medium" || s === "low") return s;
  return "medium";
}

function validateFailureType(
  val: unknown,
): Diagnosis["failureType"] {
  const s = String(val);
  const valid = [
    "prompt_issue",
    "orchestration_issue",
    "model_limitation",
    "retrieval_rag_issue",
  ];
  if (valid.includes(s)) return s as Diagnosis["failureType"];
  return "prompt_issue";
}
