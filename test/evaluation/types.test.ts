import { describe, it, expect } from "vitest";
import { MetricScoresSchema, FailureTypeSchema, PolicyResultSchema } from "../../src/evaluation/types.js";

describe("MetricScoresSchema", () => {
  it("accepts valid metric scores", () => {
    const valid = {
      successScore: 80,
      aiRelevancy: 75,
      sentiment: 90,
      hallucinationScore: 100,
      repetitionScore: 65,
      consistencyScore: 70,
      naturalLanguageScore: 85,
      contextRetentionScore: 60,
      verbosityScore: 75,
      taskCompletion: 95,
      clarity: 88,
      truncationScore: 0,
    };
    expect(MetricScoresSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects scores below 0", () => {
    const invalid = {
      successScore: -1,
      aiRelevancy: 75,
      sentiment: 90,
      hallucinationScore: 100,
      repetitionScore: 65,
      consistencyScore: 70,
      naturalLanguageScore: 85,
      contextRetentionScore: 60,
      verbosityScore: 75,
      taskCompletion: 95,
      clarity: 88,
      truncationScore: 0,
    };
    expect(MetricScoresSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects scores above 100", () => {
    const invalid = {
      successScore: 101,
      aiRelevancy: 75,
      sentiment: 90,
      hallucinationScore: 100,
      repetitionScore: 65,
      consistencyScore: 70,
      naturalLanguageScore: 85,
      contextRetentionScore: 60,
      verbosityScore: 75,
      taskCompletion: 95,
      clarity: 88,
      truncationScore: 0,
    };
    expect(MetricScoresSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects missing fields", () => {
    const incomplete = { successScore: 80 };
    expect(MetricScoresSchema.safeParse(incomplete).success).toBe(false);
  });
});

describe("FailureTypeSchema", () => {
  it("accepts valid failure types", () => {
    expect(FailureTypeSchema.safeParse("prompt_issue").success).toBe(true);
    expect(FailureTypeSchema.safeParse("orchestration_issue").success).toBe(true);
    expect(FailureTypeSchema.safeParse("model_limitation").success).toBe(true);
    expect(FailureTypeSchema.safeParse("retrieval_rag_issue").success).toBe(true);
  });

  it("rejects invalid failure types", () => {
    expect(FailureTypeSchema.safeParse("invalid").success).toBe(false);
    expect(FailureTypeSchema.safeParse("").success).toBe(false);
  });
});

describe("PolicyResultSchema", () => {
  it("accepts a passing result", () => {
    const result = {
      policyId: "greet",
      verdict: "pass",
      passed: true,
      evidence: "Agent greeted the user.",
    };
    expect(PolicyResultSchema.safeParse(result).success).toBe(true);
  });

  it("accepts a failing result with all fields", () => {
    const result = {
      policyId: "escalate",
      verdict: "fail",
      passed: false,
      evidence: "Did not escalate billing dispute",
      failingTurns: [3, 5],
      failureType: "prompt_issue",
      failureSubtype: "missing_escalation",
    };
    expect(PolicyResultSchema.safeParse(result).success).toBe(true);
  });

  it("allows null failureType and failureSubtype", () => {
    const result = {
      policyId: "test",
      verdict: "pass",
      passed: true,
      evidence: "OK",
      failureType: null,
      failureSubtype: null,
    };
    expect(PolicyResultSchema.safeParse(result).success).toBe(true);
  });
});
