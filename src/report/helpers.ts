import type { Report } from "../evaluation/types.js";
import { averageMetrics } from "../evaluation/shared.js";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a string for safe use inside a JS string literal within an HTML attribute. */
export function escJs(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\x3c")
    .replace(/>/g, "\\x3e")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/** HTML-escape then convert **bold** markers to <strong> for agent name emphasis. */
export function escBold(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

export const avgMetrics = averageMetrics;

export function conversationHealth(
  metrics: Record<string, number>,
  policyFailures = 0,
): "healthy" | "attention" | "critical" {
  const avg = avgMetrics(metrics);
  if (avg < 50) return "critical";
  if (avg < 75) return "attention";
  // High-quality conversations with minor policy nits are healthy, not "attention".
  // Only flag as attention when there are meaningful failures (2+) or score is borderline.
  if (policyFailures >= 2) return "attention";
  if (policyFailures === 1 && avg < 85) return "attention";
  return "healthy";
}

export function buildConvAgentMap(report: Report): Map<string, string> {
  const map = new Map<string, string>();
  for (const conv of report.conversations) {
    for (const agent of report.agents ?? []) {
      const agentPolicies = report.policies.filter((p) => p.sourceAgent === agent.name);
      const hasMatch = conv.policyResults.some((pr) =>
        agentPolicies.some((p) => p.id === pr.policyId),
      );
      if (hasMatch) {
        map.set(conv.id, agent.name);
        break;
      }
    }
  }
  return map;
}

const METRIC_LABELS: Record<string, string> = {
  successScore: "Success",
  aiRelevancy: "Relevancy",
  sentiment: "Sentiment",
  hallucinationScore: "Hallucination",
  contextRetentionScore: "Context retention",
  verbosityScore: "Verbosity",
  taskCompletion: "Task completion",
  clarity: "Clarity",
  consistencyScore: "Consistency",
  naturalLanguageScore: "Language quality",
  repetitionScore: "Repetition",
};

/** Describe which metrics are low for a conversation — replaces generic "Low quality scores detected". */
export function describeWeakMetrics(metrics: Record<string, number>): string {
  const weak = Object.entries(metrics)
    .filter(([k, v]) => v < 70 && k !== "truncationScore")
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([k, v]) => `${METRIC_LABELS[k] ?? k} ${v}`);
  if (weak.length === 0) return "Borderline quality scores";
  return `Low ${weak.join(", ")}`;
}

/** Strip HTML tags and decode common entities so content renders as plain text. */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&rsquo;/gi, "\u2019")
    .replace(/&lsquo;/gi, "\u2018")
    .replace(/&rdquo;/gi, "\u201C")
    .replace(/&ldquo;/gi, "\u201D")
    .replace(/&mdash;/gi, "\u2014")
    .replace(/&ndash;/gi, "\u2013")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}


const FAILURE_TYPE_LABELS: Record<string, string> = {
  retrieval_rag_issue: "RAG Issue",
};

export function formatFailureType(type: string): string {
  if (FAILURE_TYPE_LABELS[type]) return FAILURE_TYPE_LABELS[type];
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatSubtype(subtype: string): string {
  return subtype
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
