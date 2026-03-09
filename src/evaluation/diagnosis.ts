import { LlmClient } from "../llm/client.js";
import { buildDiagnosisPrompt } from "../llm/prompts.js";
import { parseJsonResponse } from "../llm/json.js";
import type { Diagnosis, ConversationResult, MetricScores, PolicyResult } from "./types.js";
import type { NormalizedConversation } from "../ingestion/types.js";
import { formatTranscript, averageMetrics, validateEnum } from "./shared.js";
import { getLogger } from "../logger.js";

const TOP_N_WORST = 10;

/**
 * Patterns that should always be severity "critical" regardless of model opinion.
 * Applied as a post-processing floor after LLM diagnosis.
 */
const CRITICAL_FLOOR_PATTERNS: Array<{
  test: (conv: NormalizedConversation, policyResults: PolicyResult[]) => boolean;
}> = [
  // Hallucination detected — agent fabricated facts
  {
    test: (_conv, policyResults) =>
      policyResults.some(
        (pr) => !pr.passed && pr.failureSubtype === "hallucination",
      ),
  },
  // Customer explicitly requests escalation/supervisor
  {
    test: (conv) =>
      conv.messages.some(
        (m) =>
          m.role === "user" &&
          /\b(supervisor|manager|escalat|speak to (a |someone )?(human|person|agent|representative))\b/i.test(m.content),
      ),
  },
  // Customer threatens chargeback, legal action, or leaving
  {
    test: (conv) =>
      conv.messages.some(
        (m) =>
          m.role === "user" &&
          /\b(chargeback|charge.?back|lawyer|attorney|legal action|sue |BBB|better business|cancel|leaving|switching (to|provider))\b/i.test(m.content),
      ),
  },
  // Repeat contact — customer mentions prior calls/contacts about same issue
  {
    test: (conv) =>
      conv.messages.some(
        (m) =>
          m.role === "user" &&
          /\b(called (before|again|twice|three|multiple|several)|this is (my |the )?(2nd|3rd|4th|second|third|fourth|fifth) (time|call|contact)|already (called|contacted|reached out|spoken))\b/i.test(m.content),
      ),
  },
];

/** Defensively parse turnDescriptions from LLM output into Record<number, string>. */
export function parseTurnDescriptions(val: unknown): Record<number, string> | undefined {
  if (val == null || typeof val !== "object" || Array.isArray(val)) return undefined;

  const result: Record<number, string> = {};
  for (const [key, desc] of Object.entries(val as Record<string, unknown>)) {
    const num = Number(key);
    if (!Number.isFinite(num) || num < 1) continue;
    if (typeof desc !== "string" || desc.trim() === "") continue;
    result[num] = desc.trim();
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

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
      getLogger().warn(
        `  Warning: Could not generate diagnosis for ${result.id}: ${error}`,
      );
    }
  }
}

/** Enforce severity floor: some patterns must always be "critical". */
function applySeverityFloor(
  diagnosis: Diagnosis,
  conversation: NormalizedConversation,
  policyResults: PolicyResult[],
): Diagnosis {
  if (diagnosis.severity === "critical") return diagnosis;

  const shouldBeCritical = CRITICAL_FLOOR_PATTERNS.some((p) =>
    p.test(conversation, policyResults),
  );

  if (shouldBeCritical) {
    return { ...diagnosis, severity: "critical" };
  }
  return diagnosis;
}

async function diagnoseSingle(
  llm: LlmClient,
  conversation: NormalizedConversation,
  result: ConversationResult,
  systemPrompt: string,
): Promise<Diagnosis> {
  const transcript = formatTranscript(conversation);

  const prompt = buildDiagnosisPrompt(
    systemPrompt,
    transcript,
    result.policyResults,
  );

  const response = await llm.call(prompt, {
    temperature: 0.3,
    maxTokens: 1024,
  });

  const parsed = parseJsonResponse(response.content) as Record<string, unknown>;

  const diagnosis: Diagnosis = {
    rootCauseTurn: Number(parsed.rootCauseTurn ?? 1),
    rootCauseAgent: parsed.rootCauseAgent
      ? String(parsed.rootCauseAgent)
      : null,
    shortSummary: String(parsed.shortSummary ?? ""),
    summary: String(parsed.summary ?? ""),
    impact: String(parsed.impact ?? ""),
    cascadeChain: Array.isArray(parsed.cascadeChain)
      ? parsed.cascadeChain.map(String)
      : [],
    fix: String(parsed.fix ?? ""),
    severity: validateEnum(parsed.severity, ["critical", "major", "minor"], "major") as Diagnosis["severity"],
    confidence: validateEnum(parsed.confidence, ["high", "medium", "low"], "medium") as Diagnosis["confidence"],
    failureType: validateEnum(parsed.failureType, ["prompt_issue", "orchestration_issue", "model_limitation", "retrieval_rag_issue"], "prompt_issue") as Diagnosis["failureType"],
    failureSubtype: String(parsed.failureSubtype ?? ""),
    blastRadius: Array.isArray(parsed.blastRadius)
      ? parsed.blastRadius.map(String)
      : [],
    turnDescriptions: parseTurnDescriptions(parsed.turnDescriptions),
  };

  return applySeverityFloor(diagnosis, conversation, result.policyResults);
}

