import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Report } from "../evaluation/types.js";

interface StatusOptions {
  report?: string;
  format?: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const jsonMode = options.format === "json";
  const reportDir = resolve(process.cwd(), options.report ?? ".");
  const reportPath = resolve(reportDir, "report.json");

  if (!existsSync(reportPath)) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: "no_report", message: "No report.json found." }));
    } else {
      console.log(
        "\n  No report.json found.\n" +
          "  Run `agent-triage analyze` to generate your first report.\n",
      );
    }
    return;
  }

  const report = JSON.parse(await readFile(reportPath, "utf-8")) as Report;

  if (jsonMode) {
    console.log(JSON.stringify({
      generatedAt: report.generatedAt,
      totalConversations: report.totalConversations,
      overallCompliance: report.overallCompliance,
      totalFailures: report.failurePatterns.totalFailures,
      worstPolicies: report.policies
        .filter((p) => p.failing > 0)
        .sort((a, b) => a.complianceRate - b.complianceRate)
        .slice(0, 5)
        .map((p) => ({
          id: p.id,
          name: p.name,
          compliance: p.complianceRate,
          failing: p.failing,
          total: p.total,
        })),
      metricSummary: report.metricSummary,
      recommendations: report.failurePatterns.topRecommendations.slice(0, 1),
    }));
    return;
  }

  // Check staleness
  const reportAge = Date.now() - new Date(report.generatedAt).getTime();
  const ageHours = Math.floor(reportAge / 3_600_000);
  const ageDays = Math.floor(reportAge / 86_400_000);
  const ageStr =
    ageDays > 0
      ? `${ageDays}d ago`
      : ageHours > 0
        ? `${ageHours}h ago`
        : "just now";

  console.log(`\n  Agent Health — ${report.generatedAt} (${ageStr})`);
  console.log(`  ${"─".repeat(46)}`);
  console.log(`  Overall Compliance: ${report.overallCompliance}%`);
  console.log(`  Conversations: ${report.totalConversations}`);

  const criticalCount = report.conversations.filter(
    (c) => c.diagnosis?.severity === "critical",
  ).length;
  console.log(`  Critical Issues: ${criticalCount}`);

  // Worst policies
  const failing = report.policies
    .filter((p) => p.failing > 0)
    .sort((a, b) => a.complianceRate - b.complianceRate);

  if (failing.length > 0) {
    console.log(`\n  Worst Policies:`);
    for (const p of failing.slice(0, 5)) {
      const icon = p.complianceRate < 50 ? "✗" : "⚠";
      console.log(
        `    ${icon} "${p.name}" — ${p.complianceRate}% (${p.failing}/${p.total} failing)`,
      );
    }
  } else {
    console.log(`\n  All policies passing.`);
  }

  // Top recommendation
  const recs = report.failurePatterns.topRecommendations;
  if (recs.length > 0) {
    console.log(`\n  Top Recommendation:`);
    console.log(`    ${recs[0].title}`);
    console.log(`    → ${recs[0].description.slice(0, 120)}`);
  }

  // Staleness warning
  if (ageDays >= 1) {
    console.log(
      `\n  Report is ${ageStr}. Run \`agent-triage analyze\` to refresh.`,
    );
  }

  // Next steps
  if (failing.length > 0) {
    console.log(
      `\n  Run \`agent-triage explain --worst\` to diagnose the worst failure.`,
    );
  }

  console.log("");
}
