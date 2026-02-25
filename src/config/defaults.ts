import type { Config, LlmProvider } from "./schema.js";

export const DEFAULT_PROVIDER = "openai" as const;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_MAX_CONVERSATIONS = 500;

const DEFAULT_MODEL_BY_PROVIDER: Record<LlmProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  "openai-compatible": "gpt-4o-mini",
};

export function getDefaultModel(provider?: string): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider as LlmProvider] ?? DEFAULT_MODEL_BY_PROVIDER.openai;
}

/** @deprecated Use getDefaultModel(provider) instead */
export const DEFAULT_MODEL = "gpt-4o-mini";

export const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4-turbo": { input: 0.01, output: 0.03 },
  "claude-haiku-4-5-20251001": { input: 0.0008, output: 0.004 },
  "claude-3-5-haiku-latest": { input: 0.0008, output: 0.004 },
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "claude-opus-4-20250514": { input: 0.015, output: 0.075 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = COST_PER_1K_TOKENS[model] ?? COST_PER_1K_TOKENS["gpt-4o-mini"]!;
  return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
}

export function buildDefaultConfig(promptPath: string): Config {
  return {
    llm: {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      maxConcurrency: DEFAULT_CONCURRENCY,
    },
    prompt: { path: promptPath },
    output: {
      dir: ".",
      includePrompt: false,
      summaryOnly: false,
      maxConversations: DEFAULT_MAX_CONVERSATIONS,
    },
  };
}
