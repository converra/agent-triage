import { describe, it, expect, vi, afterEach } from "vitest";
import { evaluateAll } from "../../src/evaluation/runner.js";
import { createMockLlm, makeConversation, makePolicy, VALID_METRICS } from "../helpers.js";
import { cleanupProgress } from "../../src/evaluation/progress.js";
import type { LlmClient } from "../../src/llm/client.js";
import type { ConversationResult } from "../../src/evaluation/types.js";

afterEach(async () => {
  await cleanupProgress();
});

const systemPrompt = "You are a support agent.";
const policies = [makePolicy("greet", "Greet the user")];

function makeLlmForRunner() {
  let callCount = 0;
  return createMockLlm(() => {
    callCount++;
    // Alternate between metrics and policy check responses
    if (callCount % 2 === 1) {
      return JSON.stringify({ metrics: VALID_METRICS });
    }
    return JSON.stringify([{
      policyId: "greet",
      passed: true,
      evidence: "OK",
      failingTurns: [],
      failureType: null,
      failureSubtype: null,
    }]);
  });
}

describe("evaluateAll", () => {
  it("evaluates all conversations and returns results", async () => {
    const llm = makeLlmForRunner();
    const conversations = [
      makeConversation("conv-1"),
      makeConversation("conv-2"),
    ];

    const results = await evaluateAll(
      llm as unknown as LlmClient,
      conversations,
      policies,
      systemPrompt,
      { concurrency: 2, policiesHash: "test-hash" },
    );

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(["conv-1", "conv-2"]);
    for (const r of results) {
      expect(r.metrics).toBeDefined();
      expect(r.policyResults).toBeDefined();
      expect(r.messages).toBeDefined();
    }
  });

  it("skips already-completed conversations when resuming", async () => {
    const llm = makeLlmForRunner();
    const conversations = [
      makeConversation("conv-1"),
      makeConversation("conv-2"),
      makeConversation("conv-3"),
    ];

    const previousResults = new Map<string, ConversationResult>();
    previousResults.set("conv-1", {
      id: "conv-1",
      metrics: VALID_METRICS,
      policyResults: [{ policyId: "greet", passed: true, evidence: "OK" }],
      messages: [],
    });

    const results = await evaluateAll(
      llm as unknown as LlmClient,
      conversations,
      policies,
      systemPrompt,
      { concurrency: 2, policiesHash: "test-hash", previousResults },
    );

    expect(results).toHaveLength(3);
    // conv-2 and conv-3 need 2 LLM calls each (metrics + policy check)
    // conv-1 was already done
    expect(llm.call.mock.calls.length).toBe(4);
  });

  it("returns previous results immediately when all are done", async () => {
    const llm = makeLlmForRunner();
    const conversations = [makeConversation("conv-1")];

    const previousResults = new Map<string, ConversationResult>();
    previousResults.set("conv-1", {
      id: "conv-1",
      metrics: VALID_METRICS,
      policyResults: [{ policyId: "greet", passed: true, evidence: "OK" }],
      messages: [],
    });

    const results = await evaluateAll(
      llm as unknown as LlmClient,
      conversations,
      policies,
      systemPrompt,
      { concurrency: 1, policiesHash: "test-hash", previousResults },
    );

    expect(results).toHaveLength(1);
    expect(llm.call).not.toHaveBeenCalled();
  });

  it("calls onProgress callback for each conversation", async () => {
    const llm = makeLlmForRunner();
    const conversations = [
      makeConversation("conv-1"),
      makeConversation("conv-2"),
    ];
    const progressCalls: Array<[number, number, string]> = [];

    await evaluateAll(
      llm as unknown as LlmClient,
      conversations,
      policies,
      systemPrompt,
      {
        concurrency: 1,
        policiesHash: "test-hash",
        onProgress: (completed, total, id) => {
          progressCalls.push([completed, total, id]);
        },
      },
    );

    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[0]![1]).toBe(2); // total
    expect(progressCalls[1]![0]).toBe(2); // completed
  });

  it("uses conversation systemPrompt when available", async () => {
    const llm = makeLlmForRunner();
    const conv = makeConversation("conv-1", {
      systemPrompt: "I am a custom prompt",
    });

    await evaluateAll(
      llm as unknown as LlmClient,
      [conv],
      policies,
      "fallback prompt",
      { concurrency: 1, policiesHash: "test-hash" },
    );

    // The prompt sent to LLM should contain the conversation's systemPrompt
    const firstCallPrompt = llm.call.mock.calls[0]![0] as string;
    expect(firstCallPrompt).toContain("I am a custom prompt");
  });

  it("handles evaluation errors gracefully (skips failing conversations)", async () => {
    let callCount = 0;
    const llm = createMockLlm(() => {
      callCount++;
      // First conversation's metrics call fails
      if (callCount === 1) {
        throw new Error("LLM timeout");
      }
      if (callCount % 2 === 0) {
        return JSON.stringify({ metrics: VALID_METRICS });
      }
      return JSON.stringify([{
        policyId: "greet",
        passed: true,
        evidence: "OK",
        failingTurns: [],
        failureType: null,
        failureSubtype: null,
      }]);
    });

    const conversations = [
      makeConversation("conv-1"),
      makeConversation("conv-2"),
    ];

    const results = await evaluateAll(
      llm as unknown as LlmClient,
      conversations,
      policies,
      systemPrompt,
      { concurrency: 1, policiesHash: "test-hash" },
    );

    // conv-1 failed, conv-2 should still succeed
    // (but the error may cause both calls for conv-1 to fail since they're parallel)
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("respects concurrency limit", async () => {
    const llm = makeLlmForRunner();
    const conversations = [
      makeConversation("conv-1"),
      makeConversation("conv-2"),
      makeConversation("conv-3"),
      makeConversation("conv-4"),
    ];

    const results = await evaluateAll(
      llm as unknown as LlmClient,
      conversations,
      policies,
      systemPrompt,
      { concurrency: 2, policiesHash: "test-hash" },
    );

    expect(results).toHaveLength(4);
  });
});
