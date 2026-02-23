import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig, resolveApiKey } from "../../src/config/loader.js";
import type { Config } from "../../src/config/schema.js";

describe("loadConfig", () => {
  it("returns valid default config with prompt path override", async () => {
    const config = await loadConfig({ prompt: { path: "test.txt" } });
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.model).toBe("gpt-4o-mini");
    expect(config.llm.maxConcurrency).toBe(5);
    expect(config.prompt.path).toBe("test.txt");
  });

  it("applies CLI overrides over defaults", async () => {
    const config = await loadConfig({
      prompt: { path: "test.txt" },
      llm: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    });
    expect(config.llm.provider).toBe("anthropic");
    expect(config.llm.model).toBe("claude-sonnet-4-20250514");
  });

  it("deep merges nested objects", async () => {
    const config = await loadConfig({
      prompt: { path: "test.txt" },
      llm: { model: "gpt-4o" },
    });
    // provider should still default
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.model).toBe("gpt-4o");
  });
});

describe("resolveApiKey", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns explicit API key from config", () => {
    const config = {
      llm: { provider: "openai" as const, model: "gpt-4o-mini", apiKey: "sk-test-123", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    expect(resolveApiKey(config)).toBe("sk-test-123");
  });

  it("falls back to OPENAI_API_KEY env var for openai provider", () => {
    process.env.OPENAI_API_KEY = "sk-env-456";
    const config = {
      llm: { provider: "openai" as const, model: "gpt-4o-mini", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    expect(resolveApiKey(config)).toBe("sk-env-456");
  });

  it("falls back to ANTHROPIC_API_KEY for anthropic provider", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-789";
    const config = {
      llm: { provider: "anthropic" as const, model: "claude-sonnet-4-20250514", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    expect(resolveApiKey(config)).toBe("sk-ant-789");
  });

  it("throws when no API key is available", () => {
    delete process.env.OPENAI_API_KEY;
    const config = {
      llm: { provider: "openai" as const, model: "gpt-4o-mini", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    expect(() => resolveApiKey(config)).toThrow("No API key found");
  });
});
