import { describe, it, expect } from "vitest";
import { evaluateConversation } from "../../src/evaluation/evaluator.js";
import { createMockLlm, makeConversation, VALID_METRICS } from "../helpers.js";
import type { LlmClient } from "../../src/llm/client.js";

describe("evaluateConversation", () => {
  const systemPrompt = "You are a helpful support agent.";

  it("parses a valid metrics response", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify({ metrics: VALID_METRICS }),
    );

    const result = await evaluateConversation(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      systemPrompt,
    );

    expect(result.successScore).toBe(85);
    expect(result.hallucinationScore).toBe(90);
    expect(result.truncationScore).toBe(0);
    expect(llm.call).toHaveBeenCalledOnce();
  });

  it("handles flat response format (no metrics wrapper)", async () => {
    const llm = createMockLlm(() => JSON.stringify(VALID_METRICS));

    const result = await evaluateConversation(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      systemPrompt,
    );

    expect(result.successScore).toBe(85);
  });

  it("clamps values to 0-100 range", async () => {
    const metrics = { ...VALID_METRICS, successScore: 150, sentiment: -20 };
    const llm = createMockLlm(() => JSON.stringify({ metrics }));

    const result = await evaluateConversation(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      systemPrompt,
    );

    expect(result.successScore).toBe(100);
    expect(result.sentiment).toBe(0);
  });

  it("coerces string values to numbers", async () => {
    const metrics = { ...VALID_METRICS, successScore: "92" };
    const llm = createMockLlm(() =>
      JSON.stringify({ metrics }),
    );

    const result = await evaluateConversation(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      systemPrompt,
    );

    expect(result.successScore).toBe(92);
  });

  it("throws on missing required metric fields", async () => {
    const incomplete = { successScore: 80, aiRelevancy: 75 };
    const llm = createMockLlm(() => JSON.stringify({ metrics: incomplete }));

    await expect(
      evaluateConversation(
        llm as unknown as LlmClient,
        makeConversation("conv-1"),
        systemPrompt,
      ),
    ).rejects.toThrow("Metrics validation failed");
  });

  it("passes temperature and maxTokens to LLM", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify({ metrics: VALID_METRICS }),
    );

    await evaluateConversation(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      systemPrompt,
    );

    expect(llm.call).toHaveBeenCalledWith(
      expect.any(String),
      { temperature: 0.2, maxTokens: 1024 },
    );
  });

  it("includes conversation turns in prompt", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify({ metrics: VALID_METRICS }),
    );
    const conv = makeConversation("conv-1", {
      messages: [
        { role: "user", content: "What is your return policy?" },
        { role: "assistant", content: "We offer 30-day returns." },
      ],
    });

    await evaluateConversation(
      llm as unknown as LlmClient,
      conv,
      systemPrompt,
    );

    const prompt = llm.call.mock.calls[0]![0] as string;
    expect(prompt).toContain("What is your return policy?");
    expect(prompt).toContain("We offer 30-day returns.");
    expect(prompt).toContain("Turn 1 [user]");
    expect(prompt).toContain("Turn 2 [assistant]");
  });

  it("includes system prompt in evaluation prompt", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify({ metrics: VALID_METRICS }),
    );

    await evaluateConversation(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      "You are a billing support agent. Never discuss pricing.",
    );

    const prompt = llm.call.mock.calls[0]![0] as string;
    expect(prompt).toContain("Never discuss pricing");
  });
});
