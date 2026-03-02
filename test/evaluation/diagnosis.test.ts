import { describe, it, expect } from "vitest";
import { generateDiagnoses, parseTurnDescriptions } from "../../src/evaluation/diagnosis.js";
import { createMockLlm, makeConversation, makeResult, VALID_METRICS } from "../helpers.js";
import type { LlmClient } from "../../src/llm/client.js";
import type { ConversationResult } from "../../src/evaluation/types.js";

const systemPrompt = "You are a support agent.";

const diagnosisResponse = JSON.stringify({
  rootCauseTurn: 3,
  rootCauseAgent: "billing-agent",
  summary: "Agent fabricated a refund policy not in the system prompt.",
  impact: "User was given incorrect information at Turn 3, leading to frustration at Turn 5.",
  cascadeChain: ["Turn 3: fabricated policy", "Turn 5: user pushback"],
  fix: "Add explicit refund policy section to the system prompt.",
  severity: "critical",
  confidence: "high",
  failureType: "prompt_issue",
  failureSubtype: "hallucination",
  blastRadius: ["tone-policy", "escalation-policy"],
  turnDescriptions: {
    "1": "User asks about order refund",
    "2": "Agent acknowledges the request",
  },
});

describe("generateDiagnoses", () => {
  it("generates diagnosis for conversations with policy failures", async () => {
    const llm = createMockLlm(() => diagnosisResponse);
    const conversations = [makeConversation("conv-1")];
    const results: ConversationResult[] = [
      makeResult("conv-1", {
        metrics: { ...VALID_METRICS, successScore: 20 },
        policyResults: [
          {
            policyId: "escalate",
            passed: false,
            evidence: "Did not escalate",
            failingTurns: [3],
            failureType: "prompt_issue",
            failureSubtype: "hallucination",
          },
        ],
      }),
    ];

    await generateDiagnoses(
      llm as unknown as LlmClient,
      results,
      conversations,
      systemPrompt,
    );

    expect(results[0]!.diagnosis).toBeDefined();
    const d = results[0]!.diagnosis!;
    expect(d.rootCauseTurn).toBe(3);
    expect(d.rootCauseAgent).toBe("billing-agent");
    expect(d.summary).toContain("fabricated");
    expect(d.severity).toBe("critical");
    expect(d.confidence).toBe("high");
    expect(d.failureType).toBe("prompt_issue");
    expect(d.cascadeChain).toHaveLength(2);
    expect(d.blastRadius).toContain("tone-policy");
    expect(d.turnDescriptions).toEqual({
      1: "User asks about order refund",
      2: "Agent acknowledges the request",
    });
  });

  it("skips conversations with no policy failures and good scores", async () => {
    const llm = createMockLlm(() => diagnosisResponse);
    const conversations = [makeConversation("conv-1")];
    // All metrics at 80+ (avg well above 75) and no policy failures → should skip
    const highMetrics = { ...VALID_METRICS, truncationScore: 0, repetitionScore: 80, sentiment: 80, contextRetentionScore: 80 };
    const results: ConversationResult[] = [
      makeResult("conv-1", { metrics: highMetrics }),
    ];

    await generateDiagnoses(
      llm as unknown as LlmClient,
      results,
      conversations,
      systemPrompt,
    );

    expect(results[0]!.diagnosis).toBeUndefined();
    expect(llm.call).not.toHaveBeenCalled();
  });

  it("diagnoses low-scoring conversations even without policy failures", async () => {
    const llm = createMockLlm(() => diagnosisResponse);
    const conversations = [makeConversation("conv-1")];
    // Low scores but no policy failures → should still diagnose
    const results: ConversationResult[] = [
      makeResult("conv-1", {
        metrics: { ...VALID_METRICS, successScore: 40, sentiment: 30 },
        policyResults: [
          { policyId: "greet", verdict: "pass" as const, passed: true, evidence: "OK" },
        ],
      }),
    ];

    await generateDiagnoses(
      llm as unknown as LlmClient,
      results,
      conversations,
      systemPrompt,
    );

    expect(results[0]!.diagnosis).toBeDefined();
    expect(results[0]!.diagnosis!.summary).toContain("fabricated");
  });

  it("prioritizes worst conversations by average metric score", async () => {
    const llm = createMockLlm(() => diagnosisResponse);
    const conversations = [
      makeConversation("conv-good"),
      makeConversation("conv-bad"),
    ];
    const results: ConversationResult[] = [
      makeResult("conv-good", {
        metrics: { ...VALID_METRICS, successScore: 70 },
        policyResults: [
          { policyId: "p1", passed: false, evidence: "Minor issue", failureType: "prompt_issue" },
        ],
      }),
      makeResult("conv-bad", {
        metrics: { ...VALID_METRICS, successScore: 10, sentiment: 10 },
        policyResults: [
          { policyId: "p1", passed: false, evidence: "Major issue", failureType: "prompt_issue" },
        ],
      }),
    ];

    await generateDiagnoses(
      llm as unknown as LlmClient,
      results,
      conversations,
      systemPrompt,
    );

    // Both should get diagnosed since both have failures
    expect(results[0]!.diagnosis).toBeDefined();
    expect(results[1]!.diagnosis).toBeDefined();
  });

  it("calls onProgress callback", async () => {
    const llm = createMockLlm(() => diagnosisResponse);
    const conversations = [makeConversation("conv-1")];
    const results: ConversationResult[] = [
      makeResult("conv-1", {
        metrics: { ...VALID_METRICS, successScore: 20 },
        policyResults: [
          { policyId: "p1", passed: false, evidence: "Fail", failureType: "prompt_issue" },
        ],
      }),
    ];

    const progressCalls: Array<[number, number]> = [];
    await generateDiagnoses(
      llm as unknown as LlmClient,
      results,
      conversations,
      systemPrompt,
      (cur, total) => progressCalls.push([cur, total]),
    );

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]).toEqual([1, 1]);
  });

  it("validates severity to allowed values", async () => {
    const response = JSON.stringify({
      ...JSON.parse(diagnosisResponse),
      severity: "INVALID",
    });
    const llm = createMockLlm(() => response);
    const conversations = [makeConversation("conv-1")];
    const results: ConversationResult[] = [
      makeResult("conv-1", {
        metrics: { ...VALID_METRICS, successScore: 20 },
        policyResults: [
          { policyId: "p1", passed: false, evidence: "Fail", failureType: "prompt_issue" },
        ],
      }),
    ];

    await generateDiagnoses(
      llm as unknown as LlmClient,
      results,
      conversations,
      systemPrompt,
    );

    // Should default to "major" for invalid severity
    expect(results[0]!.diagnosis!.severity).toBe("major");
  });

  it("validates failureType to allowed values", async () => {
    const response = JSON.stringify({
      ...JSON.parse(diagnosisResponse),
      failureType: "unknown_type",
    });
    const llm = createMockLlm(() => response);
    const conversations = [makeConversation("conv-1")];
    const results: ConversationResult[] = [
      makeResult("conv-1", {
        metrics: { ...VALID_METRICS, successScore: 20 },
        policyResults: [
          { policyId: "p1", passed: false, evidence: "Fail", failureType: "prompt_issue" },
        ],
      }),
    ];

    await generateDiagnoses(
      llm as unknown as LlmClient,
      results,
      conversations,
      systemPrompt,
    );

    // Should default to "prompt_issue" for invalid type
    expect(results[0]!.diagnosis!.failureType).toBe("prompt_issue");
  });

  it("handles LLM errors gracefully (skips failed diagnosis)", async () => {
    const llm = createMockLlm(() => {
      throw new Error("LLM timeout");
    });
    const conversations = [makeConversation("conv-1")];
    const results: ConversationResult[] = [
      makeResult("conv-1", {
        metrics: { ...VALID_METRICS, successScore: 20 },
        policyResults: [
          { policyId: "p1", passed: false, evidence: "Fail", failureType: "prompt_issue" },
        ],
      }),
    ];

    // Should not throw
    await generateDiagnoses(
      llm as unknown as LlmClient,
      results,
      conversations,
      systemPrompt,
    );

    expect(results[0]!.diagnosis).toBeUndefined();
  });

  it("returns undefined turnDescriptions when LLM omits the field", async () => {
    const responseWithout = JSON.stringify({
      rootCauseTurn: 3,
      rootCauseAgent: null,
      summary: "Issue found.",
      impact: "User frustrated.",
      cascadeChain: [],
      fix: "Fix the prompt.",
      severity: "major",
      confidence: "medium",
      failureType: "prompt_issue",
      failureSubtype: "hallucination",
      blastRadius: [],
    });
    const llm = createMockLlm(() => responseWithout);
    const conversations = [makeConversation("conv-1")];
    const results: ConversationResult[] = [
      makeResult("conv-1", {
        metrics: { ...VALID_METRICS, successScore: 20 },
        policyResults: [
          { policyId: "p1", passed: false, evidence: "Fail", failureType: "prompt_issue" },
        ],
      }),
    ];

    await generateDiagnoses(llm as unknown as LlmClient, results, conversations, systemPrompt);

    expect(results[0]!.diagnosis).toBeDefined();
    expect(results[0]!.diagnosis!.turnDescriptions).toBeUndefined();
  });
});

describe("parseTurnDescriptions", () => {
  it("converts string keys to numeric keys", () => {
    const result = parseTurnDescriptions({ "1": "hello", "2": "world" });
    expect(result).toEqual({ 1: "hello", 2: "world" });
  });

  it("returns undefined for null/undefined input", () => {
    expect(parseTurnDescriptions(null)).toBeUndefined();
    expect(parseTurnDescriptions(undefined)).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(parseTurnDescriptions({})).toBeUndefined();
  });

  it("skips non-numeric keys", () => {
    const result = parseTurnDescriptions({ "1": "valid", "abc": "invalid", "2": "also valid" });
    expect(result).toEqual({ 1: "valid", 2: "also valid" });
  });

  it("skips entries with non-string values", () => {
    const result = parseTurnDescriptions({ "1": "valid", "2": 42, "3": "also valid" });
    expect(result).toEqual({ 1: "valid", 3: "also valid" });
  });

  it("skips empty string values", () => {
    const result = parseTurnDescriptions({ "1": "valid", "2": "  ", "3": "ok" });
    expect(result).toEqual({ 1: "valid", 3: "ok" });
  });

  it("returns undefined for arrays", () => {
    expect(parseTurnDescriptions(["a", "b"])).toBeUndefined();
  });
});
