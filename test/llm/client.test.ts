import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock OpenAI SDK
const mockOpenAICreate = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockOpenAICreate,
      },
    },
  })),
}));

// Mock Anthropic SDK
const mockAnthropicCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: mockAnthropicCreate,
    },
  })),
}));

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, LlmClient } from "../../src/llm/client.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createLlmClient", () => {
  it("returns an LlmClient instance", () => {
    const client = createLlmClient("openai", "sk-test", "gpt-4o-mini");
    expect(client).toBeInstanceOf(LlmClient);
  });
});

describe("LlmClient constructor", () => {
  it("creates an OpenAI client for openai provider", () => {
    createLlmClient("openai", "sk-test", "gpt-4o-mini");
    expect(OpenAI).toHaveBeenCalledWith({ apiKey: "sk-test" });
    expect(Anthropic).not.toHaveBeenCalled();
  });

  it("creates an OpenAI client for openai-compatible provider", () => {
    createLlmClient("openai-compatible", "sk-test", "my-model", "https://custom.api.com");
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://custom.api.com",
    });
    expect(Anthropic).not.toHaveBeenCalled();
  });

  it("creates an Anthropic client for anthropic provider", () => {
    createLlmClient("anthropic", "sk-ant-test", "claude-3-haiku-20240307");
    expect(Anthropic).toHaveBeenCalledWith({ apiKey: "sk-ant-test" });
    expect(OpenAI).not.toHaveBeenCalled();
  });

  it("passes baseURL to OpenAI when provided", () => {
    createLlmClient("openai", "sk-test", "gpt-4o-mini", "https://custom.api.com");
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://custom.api.com",
    });
  });

  it("omits baseURL from OpenAI when not provided", () => {
    createLlmClient("openai", "sk-test", "gpt-4o-mini");
    expect(OpenAI).toHaveBeenCalledWith({ apiKey: "sk-test" });
  });
});

describe("LlmClient accessors", () => {
  it("getModel returns the configured model", () => {
    const client = createLlmClient("openai", "sk-test", "gpt-4o-mini");
    expect(client.getModel()).toBe("gpt-4o-mini");
  });

  it("getProvider returns the configured provider", () => {
    const client = createLlmClient("anthropic", "sk-test", "claude-3-haiku-20240307");
    expect(client.getProvider()).toBe("anthropic");
  });

  it("getUsage returns zeros before any calls", () => {
    const client = createLlmClient("openai", "sk-test", "gpt-4o-mini");
    expect(client.getUsage()).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0 });
  });
});

describe("LlmClient.call with OpenAI", () => {
  it("calls OpenAI chat completions with correct params", async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Hello!" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const client = createLlmClient("openai", "sk-test", "gpt-4o-mini");
    const response = await client.call("Say hello");

    expect(mockOpenAICreate).toHaveBeenCalledWith({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say hello" }],
      temperature: 0.2,
      max_tokens: 4096,
    });
    expect(response.content).toBe("Hello!");
    expect(response.inputTokens).toBe(10);
    expect(response.outputTokens).toBe(5);
  });

  it("includes system message when systemPrompt is provided", async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Hi" } }],
      usage: { prompt_tokens: 15, completion_tokens: 3 },
    });

    const client = createLlmClient("openai", "sk-test", "gpt-4o-mini");
    await client.call("Hello", { systemPrompt: "You are helpful." });

    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
      }),
    );
  });

  it("uses custom temperature and maxTokens", async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });

    const client = createLlmClient("openai", "sk-test", "gpt-4o-mini");
    await client.call("test", { temperature: 0.8, maxTokens: 512 });

    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.8,
        max_tokens: 512,
      }),
    );
  });

  it("handles missing content gracefully", async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    });

    const client = createLlmClient("openai", "sk-test", "gpt-4o-mini");
    const response = await client.call("test");

    expect(response.content).toBe("");
  });
});

describe("LlmClient.call with Anthropic", () => {
  it("calls Anthropic messages.create with correct params", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hello from Claude!" }],
      usage: { input_tokens: 12, output_tokens: 8 },
    });

    const client = createLlmClient("anthropic", "sk-ant-test", "claude-3-haiku-20240307");
    const response = await client.call("Say hello");

    expect(mockAnthropicCreate).toHaveBeenCalledWith({
      model: "claude-3-haiku-20240307",
      max_tokens: 4096,
      temperature: 0.2,
      system: undefined,
      messages: [{ role: "user", content: "Say hello" }],
    });
    expect(response.content).toBe("Hello from Claude!");
    expect(response.inputTokens).toBe(12);
    expect(response.outputTokens).toBe(8);
  });

  it("passes systemPrompt as system parameter", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    const client = createLlmClient("anthropic", "sk-ant-test", "claude-3-haiku-20240307");
    await client.call("test", { systemPrompt: "Be concise." });

    expect(mockAnthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "Be concise.",
      }),
    );
  });

  it("concatenates multiple text blocks", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Part 1. " },
        { type: "text", text: "Part 2." },
      ],
      usage: { input_tokens: 10, output_tokens: 6 },
    });

    const client = createLlmClient("anthropic", "sk-ant-test", "claude-3-haiku-20240307");
    const response = await client.call("test");

    expect(response.content).toBe("Part 1. Part 2.");
  });
});

describe("LlmClient.call token tracking", () => {
  it("accumulates usage across multiple calls", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: "a" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: "b" } }],
        usage: { prompt_tokens: 20, completion_tokens: 15 },
      });

    const client = createLlmClient("openai", "sk-test", "gpt-4o-mini");
    await client.call("first");
    await client.call("second");

    const usage = client.getUsage();
    expect(usage.inputTokens).toBe(30);
    expect(usage.outputTokens).toBe(20);
    expect(usage.calls).toBe(2);
  });
});

describe("LlmClient.call error handling", () => {
  it("throws non-retryable errors immediately", async () => {
    mockOpenAICreate.mockRejectedValue(new Error("Invalid API key"));

    const client = createLlmClient("openai", "sk-test", "gpt-4o-mini");
    await expect(client.call("test")).rejects.toThrow("Invalid API key");

    // Should only be called once — no retries for non-retryable errors
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
  });
});
