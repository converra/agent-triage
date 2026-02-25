import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { appendHistory, readHistory, extractHistoryEntry, getLastEntry } from "../src/history.js";
import type { Report } from "../src/evaluation/types.js";

const TMP_DIR = resolve(import.meta.dirname, ".tmp-history-test");

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    agentTriageVersion: "0.1.0",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    policiesHash: "abc123",
    agent: { name: "Test Agent", promptPath: "prompt.txt" },
    generatedAt: "2026-02-24T10:00:00Z",
    runDuration: 30,
    totalConversations: 10,
    policies: [
      {
        id: "p1", name: "Be helpful", description: "", category: "quality",
        complexity: "simple", criteria: [], passing: 8, failing: 2, total: 10,
        complianceRate: 80, failingConversationIds: ["c1", "c2"],
      },
    ],
    conversations: [
      {
        id: "c1",
        metrics: { success: 0.5 },
        policyResults: [{ policyId: "p1", passed: false, evidence: "not helpful", failingTurns: [2], failureType: "prompt_issue" }],
        messages: [{ role: "user", content: "help" }, { role: "assistant", content: "no" }],
        diagnosis: { severity: "critical", confidence: "high", rootCauseTurn: 2, rootCauseAgent: null, summary: "bad", impact: "high", cascadeChain: [], fix: "be nice", failureType: "prompt_issue", failureSubtype: "", blastRadius: [] },
      },
    ],
    failurePatterns: { byType: [], topRecommendations: [], totalFailures: 2 },
    metricSummary: { success: 0.7 },
    overallCompliance: 80,
    cost: { totalTokens: 5000, estimatedCost: 0.01 },
    ...overrides,
  } as Report;
}

describe("history", () => {
  beforeEach(async () => {
    if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true });
    await mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true });
  });

  it("extractHistoryEntry extracts summary fields", () => {
    const entry = extractHistoryEntry(makeReport());
    expect(entry.timestamp).toBe("2026-02-24T10:00:00Z");
    expect(entry.totalConversations).toBe(10);
    expect(entry.overallCompliance).toBe(80);
    expect(entry.totalFailures).toBe(2);
    expect(entry.criticalCount).toBe(1);
    expect(entry.worstPolicy).toEqual({ id: "p1", name: "Be helpful", compliance: 80 });
    expect(entry.cost.estimatedCost).toBe(0.01);
  });

  it("extractHistoryEntry returns null worstPolicy when all passing", () => {
    const report = makeReport({
      policies: [{
        id: "p1", name: "Be helpful", description: "", category: "quality",
        complexity: "simple", criteria: [], passing: 10, failing: 0, total: 10,
        complianceRate: 100, failingConversationIds: [],
      }],
    } as Partial<Report>);
    const entry = extractHistoryEntry(report);
    expect(entry.worstPolicy).toBeNull();
  });

  it("appendHistory creates file and appends entries", async () => {
    const report1 = makeReport();
    const report2 = makeReport({
      generatedAt: "2026-02-24T12:00:00Z",
      overallCompliance: 90,
    });

    await appendHistory(report1, TMP_DIR);
    await appendHistory(report2, TMP_DIR);

    const entries = await readHistory(TMP_DIR);
    expect(entries).toHaveLength(2);
    expect(entries[0].overallCompliance).toBe(80);
    expect(entries[1].overallCompliance).toBe(90);
  });

  it("readHistory returns empty array when no file exists", async () => {
    const entries = await readHistory(TMP_DIR);
    expect(entries).toEqual([]);
  });

  it("getLastEntry returns last entry", async () => {
    await appendHistory(makeReport({ overallCompliance: 75 }), TMP_DIR);
    await appendHistory(makeReport({ overallCompliance: 85 }), TMP_DIR);

    const last = getLastEntry(TMP_DIR);
    expect(last).not.toBeNull();
    expect(last!.overallCompliance).toBe(85);
  });

  it("getLastEntry returns null when no file exists", () => {
    const last = getLastEntry(resolve(TMP_DIR, "nonexistent"));
    expect(last).toBeNull();
  });
});
