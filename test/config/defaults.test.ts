import { describe, it, expect } from "vitest";
import {
  estimateCost,
  buildDefaultConfig,
  COST_PER_1K_TOKENS,
} from "../../src/config/defaults.js";

describe("estimateCost", () => {
  it("calculates cost for gpt-4o-mini", () => {
    const cost = estimateCost("gpt-4o-mini", 1000, 1000);
    const rates = COST_PER_1K_TOKENS["gpt-4o-mini"]!;
    expect(cost).toBeCloseTo(rates.input + rates.output, 6);
  });

  it("calculates cost for gpt-4o", () => {
    const cost = estimateCost("gpt-4o", 2000, 500);
    const rates = COST_PER_1K_TOKENS["gpt-4o"]!;
    expect(cost).toBeCloseTo(2 * rates.input + 0.5 * rates.output, 6);
  });

  it("falls back to gpt-4o-mini rates for unknown models", () => {
    const cost = estimateCost("unknown-model", 1000, 1000);
    const fallback = COST_PER_1K_TOKENS["gpt-4o-mini"]!;
    expect(cost).toBeCloseTo(fallback.input + fallback.output, 6);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCost("gpt-4o-mini", 0, 0)).toBe(0);
  });
});

describe("buildDefaultConfig", () => {
  it("returns a valid config with the given prompt path", () => {
    const config = buildDefaultConfig("my-prompt.txt");
    expect(config.prompt.path).toBe("my-prompt.txt");
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.model).toBe("gpt-4o-mini");
    expect(config.llm.maxConcurrency).toBe(5);
    expect(config.output?.maxConversations).toBe(500);
  });
});
