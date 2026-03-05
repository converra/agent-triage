import { LlmClient } from "../llm/client.js";
import { buildEvaluationPrompt } from "../llm/prompts.js";
import { parseJsonResponse } from "../llm/json.js";
import { MetricScoresSchema, type MetricScores } from "./types.js";
import type { NormalizedConversation } from "../ingestion/types.js";
import { formatTranscript } from "./shared.js";

/**
 * Evaluate a single conversation across 12 quality metrics.
 */
export async function evaluateConversation(
  llm: LlmClient,
  conversation: NormalizedConversation,
  systemPrompt: string,
): Promise<MetricScores> {
  const transcript = formatTranscript(conversation);
  const prompt = buildEvaluationPrompt(systemPrompt, transcript);

  const response = await llm.call(prompt, {
    temperature: 0.2,
    maxTokens: 1024,
  });

  const parsed = parseJsonResponse(response.content) as Record<string, unknown>;

  // Handle nested { metrics: { ... } } or flat { successScore: ... }
  const metricsObj = parsed.metrics ?? parsed;

  // Clamp all values to 0-100 range, coerce strings to numbers
  const clamped: Record<string, number> = {};
  for (const [key, val] of Object.entries(metricsObj as Record<string, unknown>)) {
    if (typeof val === "number") {
      clamped[key] = Math.max(0, Math.min(100, Math.round(val)));
    } else if (typeof val === "string") {
      const num = Number(val);
      if (!Number.isNaN(num)) {
        clamped[key] = Math.max(0, Math.min(100, Math.round(num)));
      }
    }
  }

  const result = MetricScoresSchema.safeParse(clamped);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Metrics validation failed. Missing or invalid: ${missing}`);
  }
  return result.data;
}
