import { describe, it, expect } from "vitest";
import { diffReports, formatDiffTerminal } from "../../src/diff/diff.js";
import type { Report } from "../../src/evaluation/types.js";

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    converraTriageVersion: "0.1.0",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    policiesHash: "abc123",
    agent: { name: "Test Agent", promptPath: "prompt.txt" },
    generatedAt: "2025-01-01T00:00:00Z",
    runDuration: 60,
    totalConversations: 10,
    policies: [],
    conversations: [],
    failurePatterns: { byType: [], topRecommendations: [], totalFailures: 0 },
    metricSummary: {},
    overallCompliance: 80,
    cost: { totalTokens: 1000, estimatedCost: 0.01 },
    ...overrides,
  };
}

function makePolicy(id: string, complianceRate: number, passing: number, failing: number) {
  return {
    id,
    name: `Policy ${id}`,
    description: `Description of ${id}`,
    complexity: 2 as const,
    category: "behavior" as const,
    complianceRate,
    passing,
    failing,
    total: passing + failing,
    failingConversationIds: [] as string[],
  };
}

describe("diffReports", () => {
  it("detects improved policies", () => {
    const before = makeReport({
      policies: [makePolicy("p1", 50, 5, 5)],
    });
    const after = makeReport({
      overallCompliance: 90,
      policies: [makePolicy("p1", 80, 8, 2)],
    });

    const diff = diffReports(before, after);
    expect(diff.improved).toHaveLength(1);
    expect(diff.improved[0]!.policyId).toBe("p1");
    expect(diff.improved[0]!.delta).toBe(30);
    expect(diff.improved[0]!.status).toBe("improved");
  });

  it("detects regressed policies", () => {
    const before = makeReport({
      policies: [makePolicy("p1", 90, 9, 1)],
    });
    const after = makeReport({
      policies: [makePolicy("p1", 50, 5, 5)],
    });

    const diff = diffReports(before, after);
    expect(diff.regressed).toHaveLength(1);
    expect(diff.regressed[0]!.delta).toBe(-40);
    expect(diff.regressed[0]!.status).toBe("regressed");
  });

  it("detects unchanged policies (within threshold)", () => {
    const before = makeReport({
      policies: [makePolicy("p1", 80, 8, 2)],
    });
    const after = makeReport({
      policies: [makePolicy("p1", 83, 8, 2)],
    });

    const diff = diffReports(before, after);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.improved).toHaveLength(0);
    expect(diff.regressed).toHaveLength(0);
  });

  it("detects added policies", () => {
    const before = makeReport({ policies: [] });
    const after = makeReport({
      policies: [makePolicy("new-p", 75, 7, 3)],
    });

    const diff = diffReports(before, after);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.policyId).toBe("new-p");
  });

  it("detects removed policies", () => {
    const before = makeReport({
      policies: [makePolicy("old-p", 60, 6, 4)],
    });
    const after = makeReport({ policies: [] });

    const diff = diffReports(before, after);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.policyId).toBe("old-p");
  });

  it("calculates overall delta", () => {
    const before = makeReport({ overallCompliance: 60 });
    const after = makeReport({ overallCompliance: 85 });

    const diff = diffReports(before, after);
    expect(diff.overallDelta).toBe(25);
  });

  it("sorts improved by delta descending, regressed by delta ascending", () => {
    const before = makeReport({
      policies: [
        makePolicy("p1", 40, 4, 6),
        makePolicy("p2", 30, 3, 7),
        makePolicy("p3", 90, 9, 1),
        makePolicy("p4", 80, 8, 2),
      ],
    });
    const after = makeReport({
      policies: [
        makePolicy("p1", 80, 8, 2), // +40
        makePolicy("p2", 50, 5, 5), // +20
        makePolicy("p3", 60, 6, 4), // -30
        makePolicy("p4", 50, 5, 5), // -30
      ],
    });

    const diff = diffReports(before, after);
    expect(diff.improved[0]!.delta).toBeGreaterThanOrEqual(diff.improved[1]!.delta);
    expect(diff.regressed[0]!.delta).toBeLessThanOrEqual(diff.regressed[1]!.delta);
  });
});

describe("formatDiffTerminal", () => {
  it("produces readable terminal output", () => {
    const before = makeReport({
      overallCompliance: 60,
      totalConversations: 10,
      policies: [makePolicy("p1", 40, 4, 6)],
    });
    const after = makeReport({
      overallCompliance: 85,
      totalConversations: 15,
      policies: [makePolicy("p1", 80, 8, 2)],
    });

    const diff = diffReports(before, after);
    const output = formatDiffTerminal(diff);

    expect(output).toContain("Policy Compliance Diff");
    expect(output).toContain("60% → 85%");
    expect(output).toContain("+25pp");
    expect(output).toContain("Improved:");
    expect(output).toContain("Policy p1");
  });

  it("includes removed and added sections", () => {
    const before = makeReport({
      policies: [makePolicy("old", 50, 5, 5)],
    });
    const after = makeReport({
      policies: [makePolicy("new", 90, 9, 1)],
    });

    const diff = diffReports(before, after);
    const output = formatDiffTerminal(diff);

    expect(output).toContain("Removed policies:");
    expect(output).toContain("New policies:");
  });
});
