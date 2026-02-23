import { describe, it, expect, vi } from "vitest";
import { checkPolicies } from "../../src/evaluation/policy-checker.js";
import { createMockLlm, makeConversation, makePolicy } from "../helpers.js";
import type { LlmClient } from "../../src/llm/client.js";

const systemPrompt = "You are a support agent.";
const policies = [
  makePolicy("greet", "Greet the user"),
  makePolicy("escalate", "Escalate billing disputes"),
];

describe("checkPolicies", () => {
  it("returns policy results from batch check", async () => {
    const batchResponse = JSON.stringify([
      {
        policyId: "greet",
        passed: true,
        evidence: "Agent greeted at Turn 1",
        failingTurns: [],
        failureType: null,
        failureSubtype: null,
      },
      {
        policyId: "escalate",
        passed: false,
        evidence: "Agent did not escalate at Turn 3",
        failingTurns: [3],
        failureType: "prompt_issue",
        failureSubtype: "missing_escalation",
      },
    ]);
    const llm = createMockLlm(() => batchResponse);

    const results = await checkPolicies(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      policies,
      systemPrompt,
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.policyId).toBe("greet");
    expect(results[0]!.passed).toBe(true);
    expect(results[1]!.policyId).toBe("escalate");
    expect(results[1]!.passed).toBe(false);
    expect(results[1]!.failingTurns).toEqual([3]);
    expect(results[1]!.failureType).toBe("prompt_issue");
    // Batch mode: only 1 LLM call
    expect(llm.call).toHaveBeenCalledOnce();
  });

  it("falls back to individual checks when batch fails", async () => {
    let callCount = 0;
    const llm = createMockLlm(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Batch parsing failed");
      }
      // Individual responses
      return JSON.stringify([{
        policyId: callCount === 2 ? "greet" : "escalate",
        passed: true,
        evidence: "OK",
        failingTurns: [],
        failureType: null,
        failureSubtype: null,
      }]);
    });

    const results = await checkPolicies(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      policies,
      systemPrompt,
    );

    expect(results).toHaveLength(2);
    // 1 batch call (failed) + 2 individual calls
    expect(llm.call).toHaveBeenCalledTimes(3);
  });

  it("marks policy as failing when individual check throws", async () => {
    let callCount = 0;
    const llm = createMockLlm(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Batch fail");
      }
      if (callCount === 2) {
        return JSON.stringify([{
          policyId: "greet",
          passed: true,
          evidence: "OK",
        }]);
      }
      // Individual check for escalate throws
      throw new Error("LLM error");
    });

    const results = await checkPolicies(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      policies,
      systemPrompt,
    );

    expect(results).toHaveLength(2);
    const escalate = results.find((r) => r.policyId === "escalate")!;
    expect(escalate.passed).toBe(false);
    expect(escalate.evidence).toContain("Error");
  });

  it("coerces failingTurns to numbers", async () => {
    const response = JSON.stringify([
      {
        policyId: "greet",
        passed: false,
        evidence: "Failure",
        failingTurns: ["1", "3"],
        failureType: "prompt_issue",
        failureSubtype: "tone_violation",
      },
    ]);
    const llm = createMockLlm(() => response);

    const results = await checkPolicies(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      [makePolicy("greet", "Greet the user")],
      systemPrompt,
    );

    expect(results[0]!.failingTurns).toEqual([1, 3]);
  });

  it("handles missing optional fields gracefully", async () => {
    const response = JSON.stringify([
      {
        policyId: "greet",
        passed: true,
        evidence: "OK",
      },
    ]);
    const llm = createMockLlm(() => response);

    const results = await checkPolicies(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      [makePolicy("greet", "Greet the user")],
      systemPrompt,
    );

    expect(results[0]!.failureType).toBeNull();
    expect(results[0]!.failureSubtype).toBeNull();
    expect(results[0]!.failingTurns).toBeUndefined();
  });

  it("includes all policies in the prompt", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify(policies.map((p) => ({
        policyId: p.id,
        passed: true,
        evidence: "OK",
      }))),
    );

    await checkPolicies(
      llm as unknown as LlmClient,
      makeConversation("conv-1"),
      policies,
      systemPrompt,
    );

    const prompt = llm.call.mock.calls[0]![0] as string;
    expect(prompt).toContain("greet");
    expect(prompt).toContain("escalate");
    expect(prompt).toContain("Greet the user");
    expect(prompt).toContain("Escalate billing disputes");
  });
});
