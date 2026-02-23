import { describe, it, expect } from "vitest";
import { buildHtml } from "../../src/report/generator.js";
import type { Report } from "../../src/evaluation/types.js";

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    converraTriageVersion: "0.1.0",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    policiesHash: "abc123",
    agent: { name: "Test Agent", promptPath: "prompt.txt" },
    generatedAt: "2025-06-15T12:00:00Z",
    runDuration: 45,
    totalConversations: 5,
    policies: [
      {
        id: "greet",
        name: "Greet user",
        description: "Greet the user",
        complexity: 1,
        category: "tone",
        passing: 4,
        failing: 1,
        total: 5,
        complianceRate: 80,
        failingConversationIds: ["conv-3"],
      },
    ],
    conversations: [
      {
        id: "conv-1",
        metrics: {
          successScore: 90,
          aiRelevancy: 85,
          sentiment: 80,
          hallucinationScore: 100,
          repetitionScore: 75,
          consistencyScore: 80,
          naturalLanguageScore: 85,
          contextRetentionScore: 70,
          verbosityScore: 80,
          taskCompletion: 90,
          clarity: 85,
          truncationScore: 0,
        },
        policyResults: [{ policyId: "greet", passed: true, evidence: "OK" }],
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
      },
    ],
    failurePatterns: {
      byType: [
        {
          type: "prompt_issue",
          count: 1,
          criticalCount: 0,
          subtypes: [{ name: "tone_violation", count: 1, percentage: 100 }],
        },
      ],
      topRecommendations: [
        {
          title: "Add explicit greeting rule",
          description: "Add a greeting instruction to the system prompt.",
          targetFailureTypes: ["prompt_issue"],
          targetSubtypes: ["tone_violation"],
          affectedConversations: 1,
          confidence: "high",
        },
      ],
      totalFailures: 1,
    },
    metricSummary: { successScore: 90, aiRelevancy: 85, sentiment: 80 },
    overallCompliance: 80,
    cost: { totalTokens: 5000, estimatedCost: 0.05 },
    ...overrides,
  };
}

describe("buildHtml", () => {
  it("generates valid HTML document", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("</html>");
  });

  it("includes agent name in title and header", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("Test Agent");
  });

  it("includes metric summary values", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("Success");
    expect(html).toContain("Relevancy");
    expect(html).toContain("Sentiment");
  });

  it("includes pipeline statistics", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("Policies extracted");
    expect(html).toContain("Conversations");
    expect(html).toContain("Failures found");
  });

  it("includes recommendations section", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("How to fix it");
    expect(html).toContain("Add explicit greeting rule");
  });

  it("includes failure patterns section", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("Where things break");
    expect(html).toContain("Prompt Issue");
  });

  it("includes cost and model info", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("gpt-4o-mini");
    expect(html).toContain("$0.05");
  });

  it("shows all-passing verdict when no failures", () => {
    const html = buildHtml(
      makeReport({
        policies: [
          {
            id: "greet",
            name: "Greet user",
            description: "Greet the user",
            complexity: 1,
            category: "tone",
            passing: 5,
            failing: 0,
            total: 5,
            complianceRate: 100,
            failingConversationIds: [],
          },
        ],
        failurePatterns: { byType: [], topRecommendations: [], totalFailures: 0 },
      }),
    );
    expect(html).toContain("All 1 policies are passing");
  });

  it("escapes HTML in agent name", () => {
    const html = buildHtml(
      makeReport({
        agent: { name: '<script>alert("xss")</script>', promptPath: "p.txt" },
      }),
    );
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes reproducibility section", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("How this report was generated");
    expect(html).toContain("converra-triage analyze");
  });

  it("includes inlined CSS and JS", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });
});
