import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Report } from "../evaluation/types.js";
import { avgMetrics, conversationHealth, esc } from "./helpers.js";
import {
  renderAgentHealth,
  renderAllConversations,
  renderBehavioralRules,
  renderFailurePatterns,
  renderFooter,
  renderHeader,
  renderHealthSummary,
  renderMetricsBar,
  renderRecommendations,
  renderReproducibility,
} from "./sections.js";
import { CSS, JS } from "./styles.js";

/**
 * Generate self-contained HTML report from report.json.
 * All CSS and JS are inlined — the output is a single file.
 */
export async function generateHtmlReport(
  reportPath: string,
  outputPath?: string,
): Promise<string> {
  const raw = await readFile(resolve(process.cwd(), reportPath), "utf-8");
  const report: Report = JSON.parse(raw);
  const html = buildHtml(report);
  if (outputPath) {
    await writeFile(resolve(process.cwd(), outputPath), html, "utf-8");
  }
  return html;
}

export function buildHtml(report: Report): string {
  // Classify conversations by health (metrics + policy failures)
  const scored = report.conversations.map((c) => {
    const failures = c.policyResults.filter((pr) => !pr.passed).length;
    return { conv: c, health: conversationHealth(c.metrics, failures), avg: avgMetrics(c.metrics) };
  });
  const healthy = scored.filter((s) => s.health === "healthy").length;
  const needsAttention = scored.filter((s) => s.health === "attention").length;
  const critical = scored.filter((s) => s.health === "critical").length;

  // All conversations with issues, sorted by score (worst first)
  const issueConvs = scored
    .filter((s) => s.health !== "healthy" && s.conv.diagnosis)
    .sort((a, b) => a.avg - b.avg)
    .map((s) => s.conv);

  const date = new Date(report.generatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const agentCount = report.agents?.length ?? 0;
  const autoName = report.agents?.[0]?.name;
  const agentName = autoName && autoName !== "Unknown Agent" ? autoName : report.agent.name;
  const pageTitle = agentCount > 1
    ? `Agent Triage — ${agentCount} Agents`
    : agentName !== "AI Agent"
      ? `Agent Triage — ${esc(agentName)}`
      : `Agent Triage — ${report.totalConversations} Conversations`;
  const issues = needsAttention + critical;
  const ogDescription = issues > 0
    ? `${issues} of ${report.totalConversations} conversations have issues. ${report.failurePatterns.topRecommendations.length} recommendations.`
    : `All ${report.totalConversations} conversations healthy.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle}</title>
<meta property="og:title" content="${pageTitle}">
<meta property="og:description" content="${esc(ogDescription)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${pageTitle}">
<meta name="twitter:description" content="${esc(ogDescription)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="page">

  ${renderHeader(report, date)}
  ${renderHealthSummary(report, healthy, needsAttention, critical, issueConvs)}
  ${renderRecommendations(report)}
  ${renderAllConversations(issueConvs, report)}
  ${renderFailurePatterns(report)}
  ${renderAgentHealth(report)}
  ${renderMetricsBar(report)}
  ${renderBehavioralRules(report)}
  ${renderReproducibility(report)}

</div>

${renderFooter()}

<script>${JS}</script>
</body>
</html>`;
}
