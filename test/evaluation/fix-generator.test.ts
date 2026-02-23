import { describe, it, expect } from "vitest";
import { generateFixes, generateRecommendations } from "../../src/evaluation/fix-generator.js";
import { createMockLlm, makeResult, makePolicy, VALID_METRICS } from "../helpers.js";
import type { LlmClient } from "../../src/llm/client.js";
import type { FailurePattern } from "../../src/evaluation/types.js";

const failurePatterns: FailurePattern[] = [
  {
    type: "prompt_issue",
    count: 3,
    criticalCount: 1,
    subtypes: [{ name: "hallucination", count: 2, percentage: 67 }],
  },
];

describe("generateFixes", () => {
  it("generates fixes for failing policies only", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify({
        fix: "Add explicit refund policy to the prompt.",
        blastRadius: ["tone-policy"],
      }),
    );

    const policies = [
      makePolicy("greet", "Greet the user"),
      makePolicy("refund", "Follow refund policy"),
    ];

    const results = [
      makeResult("conv-1", {
        policyResults: [
          { policyId: "greet", passed: true, evidence: "OK" },
          { policyId: "refund", passed: false, evidence: "Fabricated policy", failureType: "prompt_issue" },
        ],
      }),
    ];

    const fixes = await generateFixes(
      llm as unknown as LlmClient,
      policies,
      results,
      failurePatterns,
    );

    // Only refund policy should have a fix (greet passes everywhere)
    expect(fixes.size).toBe(1);
    expect(fixes.has("refund")).toBe(true);
    expect(fixes.get("refund")!.fix).toContain("refund policy");
    expect(fixes.get("refund")!.blastRadius).toContain("tone-policy");
  });

  it("skips policies that pass everywhere", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify({ fix: "Test fix", blastRadius: [] }),
    );

    const policies = [makePolicy("greet", "Greet the user")];
    const results = [
      makeResult("conv-1", {
        policyResults: [{ policyId: "greet", passed: true, evidence: "OK" }],
      }),
    ];

    const fixes = await generateFixes(
      llm as unknown as LlmClient,
      policies,
      results,
      failurePatterns,
    );

    expect(fixes.size).toBe(0);
    expect(llm.call).not.toHaveBeenCalled();
  });

  it("calls onProgress for each failing policy", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify({ fix: "Fix it", blastRadius: [] }),
    );

    const policies = [
      makePolicy("p1", "Policy 1"),
      makePolicy("p2", "Policy 2"),
    ];

    const results = [
      makeResult("conv-1", {
        policyResults: [
          { policyId: "p1", passed: false, evidence: "Fail", failureType: "prompt_issue" },
          { policyId: "p2", passed: false, evidence: "Fail", failureType: "prompt_issue" },
        ],
      }),
    ];

    const progressCalls: Array<[number, number]> = [];
    await generateFixes(
      llm as unknown as LlmClient,
      policies,
      results,
      failurePatterns,
      (cur, total) => progressCalls.push([cur, total]),
    );

    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[0]).toEqual([1, 2]);
    expect(progressCalls[1]).toEqual([2, 2]);
  });

  it("handles LLM errors gracefully (skips failed fix)", async () => {
    let callCount = 0;
    const llm = createMockLlm(() => {
      callCount++;
      if (callCount === 1) throw new Error("LLM error");
      return JSON.stringify({ fix: "Fix p2", blastRadius: [] });
    });

    const policies = [
      makePolicy("p1", "Policy 1"),
      makePolicy("p2", "Policy 2"),
    ];

    const results = [
      makeResult("conv-1", {
        policyResults: [
          { policyId: "p1", passed: false, evidence: "Fail", failureType: "prompt_issue" },
          { policyId: "p2", passed: false, evidence: "Fail", failureType: "prompt_issue" },
        ],
      }),
    ];

    const fixes = await generateFixes(
      llm as unknown as LlmClient,
      policies,
      results,
      failurePatterns,
    );

    // p1 fix failed, p2 fix succeeded
    expect(fixes.size).toBe(1);
    expect(fixes.has("p2")).toBe(true);
  });
});

describe("generateRecommendations", () => {
  it("returns top 3 recommendations", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify({
        recommendations: [
          {
            title: "Add escalation rule",
            description: "Add a billing escalation rule.",
            targetFailureTypes: ["prompt_issue"],
            targetSubtypes: ["missing_escalation"],
            affectedConversations: 5,
            confidence: "high",
          },
          {
            title: "Improve greeting",
            description: "Improve greeting consistency.",
            targetFailureTypes: ["prompt_issue"],
            targetSubtypes: ["tone_violation"],
            affectedConversations: 3,
            confidence: "medium",
          },
        ],
      }),
    );

    const policies = [makePolicy("greet", "Greet the user")];
    const results = [
      makeResult("conv-1", {
        policyResults: [
          { policyId: "greet", passed: false, evidence: "No greeting", failureType: "prompt_issue" },
        ],
      }),
    ];

    const recs = await generateRecommendations(
      llm as unknown as LlmClient,
      failurePatterns,
      policies,
      results,
    );

    expect(recs).toHaveLength(2);
    expect(recs[0]!.title).toBe("Add escalation rule");
    expect(recs[0]!.confidence).toBe("high");
    expect(recs[0]!.affectedConversations).toBe(5);
    expect(recs[0]!.targetFailureTypes).toContain("prompt_issue");
  });

  it("limits to 3 recommendations max", async () => {
    const llm = createMockLlm(() =>
      JSON.stringify({
        recommendations: [
          { title: "R1", description: "D1", targetFailureTypes: [], targetSubtypes: [], affectedConversations: 5, confidence: "high" },
          { title: "R2", description: "D2", targetFailureTypes: [], targetSubtypes: [], affectedConversations: 4, confidence: "high" },
          { title: "R3", description: "D3", targetFailureTypes: [], targetSubtypes: [], affectedConversations: 3, confidence: "high" },
          { title: "R4", description: "D4", targetFailureTypes: [], targetSubtypes: [], affectedConversations: 2, confidence: "high" },
        ],
      }),
    );

    const recs = await generateRecommendations(
      llm as unknown as LlmClient,
      failurePatterns,
      [makePolicy("p1", "P1")],
      [makeResult("c1")],
    );

    expect(recs).toHaveLength(3);
  });

  it("handles missing recommendations field", async () => {
    const llm = createMockLlm(() => JSON.stringify({}));

    const recs = await generateRecommendations(
      llm as unknown as LlmClient,
      failurePatterns,
      [makePolicy("p1", "P1")],
      [makeResult("c1")],
    );

    expect(recs).toHaveLength(0);
  });
});
