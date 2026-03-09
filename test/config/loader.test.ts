import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig, resolveLlm } from "../../src/config/loader.js";
import type { Config } from "../../src/config/schema.js";

describe("loadConfig", () => {
  it("returns valid default config with prompt path override", async () => {
    const config = await loadConfig({ prompt: { path: "test.txt" } });
    expect(config.llm.provider).toBe("anthropic");
    expect(config.llm.model).toBe("claude-sonnet-4-6");
    expect(config.llm.maxConcurrency).toBe(5);
    expect(config.prompt.path).toBe("test.txt");
  });

  it("applies CLI overrides over defaults", async () => {
    const config = await loadConfig({
      prompt: { path: "test.txt" },
      llm: { provider: "openai", model: "gpt-4o" },
    });
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.model).toBe("gpt-4o");
  });

  it("deep merges nested objects", async () => {
    const config = await loadConfig({
      prompt: { path: "test.txt" },
      llm: { model: "gpt-4o" },
    });
    // provider should still default
    expect(config.llm.provider).toBe("anthropic");
    expect(config.llm.model).toBe("gpt-4o");
  });
});

describe("resolveLlm", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns explicit API key from config", async () => {
    const config: Config = {
      llm: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test-123", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    const resolved = await resolveLlm(config);
    expect(resolved.apiKey).toBe("sk-test-123");
    expect(resolved.provider).toBe("openai");
  });

  it("uses OPENAI_API_KEY for openai provider", async () => {
    process.env.OPENAI_API_KEY = "sk-env-456";
    const config: Config = {
      llm: { provider: "openai", model: "gpt-4o-mini", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    const resolved = await resolveLlm(config);
    expect(resolved.apiKey).toBe("sk-env-456");
    expect(resolved.provider).toBe("openai");
  });

  it("uses ANTHROPIC_API_KEY for anthropic provider", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-789";
    const config: Config = {
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    const resolved = await resolveLlm(config);
    expect(resolved.apiKey).toBe("sk-ant-789");
    expect(resolved.provider).toBe("anthropic");
  });

  it("auto-detects OPENAI_API_KEY when anthropic is configured but no ANTHROPIC_API_KEY", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-fallback";
    const config: Config = {
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    const resolved = await resolveLlm(config);
    expect(resolved.apiKey).toBe("sk-openai-fallback");
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-4o");
  });

  it("auto-detects ANTHROPIC_API_KEY when openai is configured but no OPENAI_API_KEY", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fallback";
    const config: Config = {
      llm: { provider: "openai", model: "gpt-4o", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    const resolved = await resolveLlm(config);
    expect(resolved.apiKey).toBe("sk-ant-fallback");
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-sonnet-4-6");
  });

  it("throws when no API key is available", async () => {
    const config: Config = {
      llm: { provider: "openai", model: "gpt-4o-mini", maxConcurrency: 5 },
      prompt: { path: "test.txt" },
    };
    await expect(resolveLlm(config)).rejects.toThrow("No API key found");
  });
});
