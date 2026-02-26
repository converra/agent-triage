import { describe, it, expect } from "vitest";
import {
  aggregatePolicies,
  aggregateFailurePatterns,
  calculateMetricSummary,
  calculateOverallCompliance,
} from "../../src/aggregation/policy-aggregator.js";
import type { Policy } from "../../src/policy/types.js";
import type { ConversationResult, MetricScores } from "../../src/evaluation/types.js";

const makeMetrics = (overrides?: Partial<MetricScores>): MetricScores => ({
  successScore: 80,
  aiRelevancy: 80,
  sentiment: 80,
  hallucinationScore: 80,
  repetitionScore: 80,
  consistencyScore: 80,
  naturalLanguageScore: 80,
  contextRetentionScore: 80,
  verbosityScore: 80,
  taskCompletion: 80,
  clarity: 80,
  truncationScore: 0,
  ...overrides,
});

const policies: Policy[] = [
  { id: "greet", name: "Greet user", description: "Greet the user", complexity: 1, category: "tone" },
  { id: "escalate", name: "Escalate billing", description: "Escalate billing disputes", complexity: 3, category: "routing" },
];

const results: ConversationResult[] = [
  {
    id: "conv-1",
    metrics: makeMetrics(),
    policyResults: [
      { policyId: "greet", verdict: "pass", passed: true, evidence: "Greeted" },
      { policyId: "escalate", verdict: "pass", passed: true, evidence: "Escalated correctly" },
    ],
    messages: [],
  },
  {
    id: "conv-2",
    metrics: makeMetrics({ successScore: 30 }),
    policyResults: [
      { policyId: "greet", verdict: "pass", passed: true, evidence: "Greeted" },
      {
        policyId: "escalate",
        verdict: "fail",
        passed: false,
        evidence: "Did not escalate",
        failingTurns: [3],
        failureType: "prompt_issue",
        failureSubtype: "missing_escalation",
      },
    ],
    messages: [],
  },
  {
    id: "conv-3",
    metrics: makeMetrics({ successScore: 20, sentiment: 20 }),
    policyResults: [
      { policyId: "greet", verdict: "fail", passed: false, evidence: "No greeting", failureType: "prompt_issue", failureSubtype: "tone_violation" },
      { policyId: "escalate", verdict: "fail", passed: false, evidence: "Ignored billing", failureType: "orchestration_issue", failureSubtype: "wrong_routing" },
    ],
    messages: [],
  },
];

describe("aggregatePolicies", () => {
  it("calculates passing/failing/total counts per policy", () => {
    const agg = aggregatePolicies(policies, results);

    const greet = agg.find((p) => p.id === "greet")!;
    expect(greet.passing).toBe(2);
    expect(greet.failing).toBe(1);
    expect(greet.total).toBe(3);

    const escalate = agg.find((p) => p.id === "escalate")!;
    expect(escalate.passing).toBe(1);
    expect(escalate.failing).toBe(2);
    expect(escalate.total).toBe(3);
  });

  it("calculates compliance rates", () => {
    const agg = aggregatePolicies(policies, results);

    const greet = agg.find((p) => p.id === "greet")!;
    expect(greet.complianceRate).toBe(67); // 2/3

    const escalate = agg.find((p) => p.id === "escalate")!;
    expect(escalate.complianceRate).toBe(33); // 1/3
  });

  it("tracks failing conversation IDs", () => {
    const agg = aggregatePolicies(policies, results);

    const escalate = agg.find((p) => p.id === "escalate")!;
    expect(escalate.failingConversationIds).toEqual(["conv-2", "conv-3"]);
  });

  it("returns 100% compliance when no results exist", () => {
    const agg = aggregatePolicies(policies, []);
    for (const p of agg) {
      expect(p.complianceRate).toBe(100);
      expect(p.total).toBe(0);
    }
  });
});

describe("aggregateFailurePatterns", () => {
  it("groups failures by type", () => {
    const patterns = aggregateFailurePatterns(results);
    expect(patterns.length).toBeGreaterThan(0);

    const promptIssue = patterns.find((p) => p.type === "prompt_issue");
    expect(promptIssue).toBeDefined();
    expect(promptIssue!.count).toBe(2); // escalate in conv-2 + greet in conv-3

    const orchIssue = patterns.find((p) => p.type === "orchestration_issue");
    expect(orchIssue).toBeDefined();
    expect(orchIssue!.count).toBe(1);
  });

  it("extracts subtypes with percentages", () => {
    const patterns = aggregateFailurePatterns(results);
    const promptIssue = patterns.find((p) => p.type === "prompt_issue")!;

    expect(promptIssue.subtypes.length).toBe(2);
    const subtypeNames = promptIssue.subtypes.map((s) => s.name);
    expect(subtypeNames).toContain("missing_escalation");
    expect(subtypeNames).toContain("tone_violation");
  });

  it("sorts by count descending", () => {
    const patterns = aggregateFailurePatterns(results);
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i]!.count).toBeLessThanOrEqual(patterns[i - 1]!.count);
    }
  });

  it("returns empty array when no failures", () => {
    const noFails: ConversationResult[] = [
      {
        id: "clean",
        metrics: makeMetrics(),
        policyResults: [
          { policyId: "greet", verdict: "pass", passed: true, evidence: "OK" },
        ],
        messages: [],
      },
    ];
    expect(aggregateFailurePatterns(noFails)).toEqual([]);
  });
});

describe("calculateMetricSummary", () => {
  it("averages metrics across all conversations", () => {
    const summary = calculateMetricSummary(results);
    // successScore: (80+30+20)/3 = 43.3 → 43
    expect(summary.successScore).toBe(43);
    // sentiment: (80+80+20)/3 = 60
    expect(summary.sentiment).toBe(60);
  });

  it("returns empty object for empty results", () => {
    expect(calculateMetricSummary([])).toEqual({});
  });
});

describe("calculateOverallCompliance", () => {
  it("calculates percentage of passed policy checks", () => {
    // 6 total checks, 3 passed → 50%
    expect(calculateOverallCompliance(results)).toBe(50);
  });

  it("returns 100 for empty results", () => {
    expect(calculateOverallCompliance([])).toBe(100);
  });

  it("returns 100 when all pass", () => {
    const allPass: ConversationResult[] = [
      {
        id: "good",
        metrics: makeMetrics(),
        policyResults: [
          { policyId: "greet", verdict: "pass", passed: true, evidence: "OK" },
          { policyId: "escalate", verdict: "pass", passed: true, evidence: "OK" },
        ],
        messages: [],
      },
    ];
    expect(calculateOverallCompliance(allPass)).toBe(100);
  });
});
