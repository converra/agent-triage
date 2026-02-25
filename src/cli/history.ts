import { resolve } from "node:path";
import { readHistory, type HistoryEntry } from "../history.js";

export async function historyCommand(options: {
  report?: string;
  format?: string;
  last?: string;
}): Promise<void> {
  const dir = resolve(process.cwd(), options.report ?? ".");
  const entries = await readHistory(dir);

  if (entries.length === 0) {
    console.log("No history found. Run `agent-triage analyze` to start tracking.");
    return;
  }

  const limit = options.last ? parseInt(options.last, 10) : undefined;
  if (limit !== undefined && isNaN(limit)) {
    throw new Error(`Invalid --last value: "${options.last}". Expected a number.`);
  }

  const shown = limit ? entries.slice(-limit) : entries;

  if (options.format === "json") {
    console.log(JSON.stringify(shown));
    return;
  }

  console.log(`\n  Run History (${shown.length} of ${entries.length} runs)\n`);

  for (let i = 0; i < shown.length; i++) {
    const entry = shown[i];
    const prev = i > 0 ? shown[i - 1] : null;
    printEntry(entry, prev);
  }

  console.log();
}

function printEntry(entry: HistoryEntry, prev: HistoryEntry | null): void {
  const date = new Date(entry.timestamp);
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const complianceDelta = prev
    ? entry.overallCompliance - prev.overallCompliance
    : null;
  const deltaStr = complianceDelta !== null
    ? complianceDelta > 0
      ? ` (+${complianceDelta.toFixed(1)}%)`
      : complianceDelta < 0
        ? ` (${complianceDelta.toFixed(1)}%)`
        : " (no change)"
    : "";

  const failureDelta = prev
    ? entry.totalFailures - prev.totalFailures
    : null;
  const failureStr = failureDelta !== null && failureDelta !== 0
    ? failureDelta > 0
      ? ` (+${failureDelta})`
      : ` (${failureDelta})`
    : "";

  const worst = entry.worstPolicy
    ? `  worst: ${entry.worstPolicy.name} (${entry.worstPolicy.compliance}%)`
    : "";

  console.log(
    `  ${dateStr}  ` +
    `compliance: ${entry.overallCompliance}%${deltaStr}  ` +
    `failures: ${entry.totalFailures}${failureStr}  ` +
    `convs: ${entry.totalConversations}  ` +
    `cost: $${entry.cost.estimatedCost.toFixed(4)}` +
    worst,
  );
}
