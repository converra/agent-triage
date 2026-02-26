import { describe, it, expect } from "vitest";
import { buildHtml } from "../../src/report/generator.js";
import type { Report } from "../../src/evaluation/types.js";

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    agentTriageVersion: "0.1.0",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    policiesHash: "abc123",
    agent: { name: "Test Agent", promptPath: "prompt.txt" },
    agents: [],
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
        notApplicable: 0,
        evaluated: 5,
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
        policyResults: [{ policyId: "greet", verdict: "pass" as const, passed: true, evidence: "OK" }],
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

  it("includes health summary statistics", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("Conversations");
    expect(html).toContain("Healthy");
    expect(html).toContain("evaluated");
  });

  it("includes recommendations section", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("How to fix it");
    expect(html).toContain("Add explicit greeting rule");
  });

  it("includes failure patterns section", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("Root cause analysis");
    expect(html).toContain("Prompt Issue");
  });

  it("includes cost and model info", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("gpt-4o-mini");
    expect(html).toContain("$0.05");
  });

  it("shows all-healthy verdict when no failures", () => {
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
            notApplicable: 0,
            evaluated: 5,
            total: 5,
            complianceRate: 100,
            failingConversationIds: [],
          },
        ],
        failurePatterns: { byType: [], topRecommendations: [], totalFailures: 0 },
      }),
    );
    expect(html).toContain("conversations are healthy");
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
    expect(html).toContain("agent-triage analyze");
  });

  it("includes inlined CSS and JS", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });

  describe("deep dive timeline", () => {
    function makeDeepDiveReport(): Report {
      return makeReport({
        conversations: [
          {
            id: "conv-fail",
            metrics: {
              successScore: 20,
              aiRelevancy: 30,
              sentiment: 15,
              hallucinationScore: 10,
              repetitionScore: 50,
              consistencyScore: 40,
              naturalLanguageScore: 60,
              contextRetentionScore: 10,
              verbosityScore: 50,
              taskCompletion: 20,
              clarity: 40,
              truncationScore: 0,
            },
            policyResults: [
              {
                policyId: "greet",
                verdict: "fail" as const,
                passed: false,
                evidence: "Turn 3: Agent lost context",
                failingTurns: [3],
                failureType: "prompt_issue",
                failureSubtype: "context_loss",
              },
            ],
            diagnosis: {
              rootCauseTurn: 3,
              rootCauseAgent: "Orchestrator Agent",
              summary: "The agent lost context at turn 3.",
              impact: "Affected turns 4, 5. User became frustrated.",
              cascadeChain: [
                "Turn 3: Agent lost context and ignored user input",
                "Turn 4: User expressed confusion about the loop",
                "Turn 5: Agent continued down incorrect path",
              ],
              fix: "Add context retention instructions.",
              severity: "critical",
              confidence: "high",
              failureType: "prompt_issue",
              failureSubtype: "context_loss",
              blastRadius: ["other-policy"],
            },
            messages: [
              { role: "user", content: "Hi there" },
              { role: "assistant", content: "Hello! How can I help?" },
              { role: "user", content: "I need help with billing" },
              { role: "assistant", content: "Raw message content for turn 4" },
              { role: "user", content: "That is not what I asked" },
            ],
          },
        ],
      });
    }

    it("renders red dot for root cause turn", () => {
      const html = buildHtml(makeDeepDiveReport());
      // Turn 3 is root cause — should have red dot class "f"
      expect(html).toContain("Turn 3 — root cause");
      expect(html).toMatch(/tdot f/);
    });

    it("renders yellow dot for cascade turns after root cause", () => {
      const html = buildHtml(makeDeepDiveReport());
      // Turns 4 and 5 are after root cause but not direct policy failures — should get amber "w"
      expect(html).toMatch(/tdot w/);
    });

    it("renders green dot for passing turns before root cause", () => {
      const html = buildHtml(makeDeepDiveReport());
      // Turns 1 and 2 are before root cause — should get green "p"
      expect(html).toMatch(/tdot p/);
    });

    it("uses cascadeChain descriptions instead of raw message content", () => {
      const html = buildHtml(makeDeepDiveReport());
      // CascadeChain description for turn 3 should appear
      expect(html).toContain("Agent lost context and ignored user input");
      // CascadeChain description for turn 4 should appear instead of raw content
      expect(html).toContain("User expressed confusion about the loop");
      expect(html).not.toContain("Raw message content for turn 4");
    });

    it("falls back to raw content when no cascadeChain entry for a turn", () => {
      const html = buildHtml(makeDeepDiveReport());
      // Turns 1 and 2 have no cascadeChain entry — should show raw message
      expect(html).toContain("Hi there");
      expect(html).toContain("Hello! How can I help?");
    });
  });
});
