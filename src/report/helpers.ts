import type { Report } from "../evaluation/types.js";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function avgMetrics(m: Record<string, number>): number {
  const vals = Object.values(m);
  if (vals.length === 0) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

export function conversationHealth(metrics: Record<string, number>): "healthy" | "attention" | "critical" {
  const avg = avgMetrics(metrics);
  if (avg >= 75) return "healthy";
  if (avg >= 50) return "attention";
  return "critical";
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

export function formatFailureType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatSubtype(subtype: string): string {
  return subtype
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
