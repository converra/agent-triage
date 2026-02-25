import { appendFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Report } from "./evaluation/types.js";

export interface HistoryEntry {
  timestamp: string;
  totalConversations: number;
  overallCompliance: number;
  totalFailures: number;
  criticalCount: number;
  worstPolicy: { id: string; name: string; compliance: number } | null;
  metricSummary: Record<string, number>;
  cost: { totalTokens: number; estimatedCost: number };
  runDuration: number;
  llmModel: string;
  policiesHash: string;
}

const HISTORY_FILE = ".triage-history.jsonl";

export function extractHistoryEntry(report: Report): HistoryEntry {
  const criticalCount = report.conversations.filter(
    (c) => c.diagnosis?.severity === "critical",
  ).length;

  const worst = report.policies
    .filter((p) => p.failing > 0)
    .sort((a, b) => a.complianceRate - b.complianceRate)[0];

  return {
    timestamp: report.generatedAt,
    totalConversations: report.totalConversations,
    overallCompliance: report.overallCompliance,
    totalFailures: report.failurePatterns?.totalFailures ?? 0,
    criticalCount,
    worstPolicy: worst
      ? { id: worst.id, name: worst.name, compliance: worst.complianceRate }
      : null,
    metricSummary: report.metricSummary,
    cost: report.cost,
    runDuration: report.runDuration,
    llmModel: report.llmModel,
    policiesHash: report.policiesHash,
  };
}

export async function appendHistory(
  report: Report,
  outputDir: string,
): Promise<void> {
  const entry = extractHistoryEntry(report);
  const historyPath = resolve(outputDir, HISTORY_FILE);
  await appendFile(historyPath, JSON.stringify(entry) + "\n", "utf-8");
}

export async function readHistory(dir: string): Promise<HistoryEntry[]> {
  const historyPath = resolve(dir, HISTORY_FILE);
  if (!existsSync(historyPath)) return [];

  const raw = await readFile(historyPath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as HistoryEntry);
}

export function getLastEntry(dir: string): HistoryEntry | null {
  const historyPath = resolve(dir, HISTORY_FILE);
  if (!existsSync(historyPath)) return null;

  const raw = readFileSync(historyPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]) as HistoryEntry;
}
