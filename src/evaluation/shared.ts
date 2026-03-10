import type { NormalizedConversation } from "../ingestion/types.js";

export function formatTranscript(conversation: Pick<NormalizedConversation, "messages">): string {
  return conversation.messages
    .map((msg, i) => `Turn ${i + 1} [${msg.role}]: ${msg.content}`)
    .join("\n\n");
}

/** Excluded from average: binary flags that skew quality scores. */
const EXCLUDED_FROM_AVERAGE = new Set(["truncationScore"]);

export function averageMetrics(metrics: Record<string, number>): number {
  const values = Object.entries(metrics)
    .filter(([k]) => !EXCLUDED_FROM_AVERAGE.has(k))
    .map(([, v]) => v);
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function validateEnum(val: unknown, valid: string[], fallback: string): string {
  const s = String(val).toLowerCase();
  return valid.includes(s) ? s : fallback;
}
