import type { NormalizedConversation } from "../ingestion/types.js";

export function formatTranscript(conversation: Pick<NormalizedConversation, "messages">): string {
  return conversation.messages
    .map((msg, i) => `Turn ${i + 1} [${msg.role}]: ${msg.content}`)
    .join("\n\n");
}

export function averageMetrics(metrics: Record<string, number>): number {
  const values = Object.values(metrics);
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function validateEnum(val: unknown, valid: string[], fallback: string): string {
  const s = String(val).toLowerCase();
  return valid.includes(s) ? s : fallback;
}
