import { vi } from "vitest";
import type { LlmCallOptions, LlmResponse, TokenUsage } from "../src/llm/client.js";
import type { NormalizedConversation } from "../src/ingestion/types.js";
import type { MetricScores, ConversationResult } from "../src/evaluation/types.js";
import type { Policy } from "../src/policy/types.js";

/**
 * Create a mock LlmClient that returns controlled responses.
 * Pass a function that receives the prompt and returns the content string.
 */
export function createMockLlm(
  responder: (prompt: string) => string,
) {
  return {
    call: vi.fn(async (prompt: string, _options?: LlmCallOptions): Promise<LlmResponse> => ({
      content: responder(prompt),
      inputTokens: 100,
      outputTokens: 50,
    })),
    getUsage: vi.fn((): TokenUsage => ({ inputTokens: 100, outputTokens: 50, calls: 1 })),
    getModel: vi.fn(() => "mock-model"),
    getProvider: vi.fn(() => "openai"),
  };
}

export const VALID_METRICS: MetricScores = {
  successScore: 85,
  aiRelevancy: 80,
  sentiment: 75,
  hallucinationScore: 90,
  repetitionScore: 70,
  consistencyScore: 80,
  naturalLanguageScore: 85,
  contextRetentionScore: 75,
  verbosityScore: 80,
  taskCompletion: 90,
  clarity: 85,
  truncationScore: 0,
};

export function makeConversation(
  id: string,
  overrides?: Partial<NormalizedConversation>,
): NormalizedConversation {
  return {
    id,
    messages: [
      { role: "user", content: "I need help with my order" },
      { role: "assistant", content: "I'd be happy to help with your order." },
    ],
    metadata: { source: "json" },
    timestamp: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makePolicy(id: string, name: string): Policy {
  return {
    id,
    name,
    description: `Policy: ${name}`,
    complexity: 2,
    category: "behavior",
  };
}

export function makeResult(
  id: string,
  overrides?: Partial<ConversationResult>,
): ConversationResult {
  return {
    id,
    metrics: { ...VALID_METRICS },
    policyResults: [
      { policyId: "greet", passed: true, evidence: "OK" },
    ],
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    ...overrides,
  };
}
