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

  it("includes health summary verdict", () => {
    const html = buildHtml(makeReport());
    expect(html).toContain("verdict");
    expect(html).toContain("conversations are healthy");
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
    expect(html).toContain("Reproduce this report");
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
                evidence: "Turn 4: Agent lost context",
                failingTurns: [4],
                failureType: "prompt_issue",
                failureSubtype: "context_loss",
              },
            ],
            diagnosis: {
              rootCauseTurn: 4,
              rootCauseAgent: "Orchestrator Agent",
              summary: "The agent lost context at turn 4.",
              impact: "Affected turns 4, 5. User became frustrated.",
              cascadeChain: [
                "Turn 4: Agent lost context and ignored user input",
                "Turn 5: User expressed confusion about the loop",
              ],
              fix: "Add context retention instructions.",
              severity: "critical",
              confidence: "high",
              failureType: "prompt_issue",
              failureSubtype: "context_loss",
              blastRadius: ["other-policy"],
              turnDescriptions: {
                1: "Friendly user greeting",
                2: "Agent responds with standard welcome",
                3: "User states billing support need",
                4: "Agent lost context and gave irrelevant response",
                5: "Frustrated user pushback",
              },
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
      // Root cause turn should have red dot class "f" and root cause label
      expect(html).toContain("root cause");
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

    it("shows both message content and cascadeChain diagnosis note", () => {
      const html = buildHtml(makeDeepDiveReport());
      // Root cause turn uses diagnosis summary, not cascade chain entry
      expect(html).toContain("The agent lost context at turn 4.");
      // Cascade descriptions for non-root turns appear as diagnosis notes
      expect(html).toContain("User expressed confusion about the loop");
      // Raw message content should ALSO appear (not replaced)
      expect(html).toContain("Raw message content for turn 4");
    });

    it("falls back to raw content when no cascadeChain entry for a turn", () => {
      const report = makeDeepDiveReport();
      // Remove turnDescriptions to test pure fallback
      report.conversations[0]!.diagnosis!.turnDescriptions = undefined;
      const html = buildHtml(report);
      // Turns 1 and 2 have no cascadeChain entry — should show raw message
      expect(html).toContain("Hi there");
      expect(html).toContain("Hello! How can I help?");
    });

    it("renders OK turns with tc-narrative when turnDescriptions present", () => {
      const html = buildHtml(makeDeepDiveReport());
      // Turn 1 ("Hi there") is an OK turn before root cause — should use turnDescription
      expect(html).toContain("Friendly user greeting");
      expect(html).toContain("Agent responds with standard welcome");
    });

    it("falls back to tc-text when turnDescriptions absent", () => {
      const report = makeDeepDiveReport();
      report.conversations[0]!.diagnosis!.turnDescriptions = undefined;
      const html = buildHtml(report);
      // Without turnDescriptions, OK turns should use tc-text with raw content
      expect(html).toContain("tc-text");
      expect(html).toContain("Hi there");
    });
  });
});
