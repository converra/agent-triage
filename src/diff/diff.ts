import type { Report } from "../evaluation/types.js";

export interface PolicyDiff {
  policyId: string;
  policyName: string;
  beforeRate: number;
  afterRate: number;
  delta: number;
  beforePassing: number;
  beforeFailing: number;
  afterPassing: number;
  afterFailing: number;
  status: "improved" | "regressed" | "unchanged";
}

export interface DiffResult {
  before: { generatedAt: string; totalConversations: number; overallCompliance: number };
  after: { generatedAt: string; totalConversations: number; overallCompliance: number };
  overallDelta: number;
  improved: PolicyDiff[];
  regressed: PolicyDiff[];
  unchanged: PolicyDiff[];
  added: Array<{ policyId: string; policyName: string; complianceRate: number }>;
  removed: Array<{ policyId: string; policyName: string; complianceRate: number }>;
}

const THRESHOLD = 5; // percentage points

export function diffReports(before: Report, after: Report): DiffResult {
  const beforeMap = new Map(before.policies.map((p) => [p.id, p]));
  const afterMap = new Map(after.policies.map((p) => [p.id, p]));

  const improved: PolicyDiff[] = [];
  const regressed: PolicyDiff[] = [];
  const unchanged: PolicyDiff[] = [];
  const added: DiffResult["added"] = [];
  const removed: DiffResult["removed"] = [];

  // Policies in both reports
  for (const [id, bp] of beforeMap) {
    const ap = afterMap.get(id);
    if (!ap) {
      removed.push({ policyId: id, policyName: bp.name, complianceRate: bp.complianceRate });
      continue;
    }

    const delta = ap.complianceRate - bp.complianceRate;
    const status = delta > THRESHOLD ? "improved" : delta < -THRESHOLD ? "regressed" : "unchanged";
    const diff: PolicyDiff = {
      policyId: id,
      policyName: bp.name,
      beforeRate: bp.complianceRate,
      afterRate: ap.complianceRate,
      delta,
      beforePassing: bp.passing,
      beforeFailing: bp.failing,
      afterPassing: ap.passing,
      afterFailing: ap.failing,
      status,
    };

    if (status === "improved") improved.push(diff);
    else if (status === "regressed") regressed.push(diff);
    else unchanged.push(diff);
  }

  // Policies only in after
  for (const [id, ap] of afterMap) {
    if (!beforeMap.has(id)) {
      added.push({ policyId: id, policyName: ap.name, complianceRate: ap.complianceRate });
    }
  }

  // Sort by magnitude of delta
  improved.sort((a, b) => b.delta - a.delta);
  regressed.sort((a, b) => a.delta - b.delta);

  return {
    before: {
      generatedAt: before.generatedAt,
      totalConversations: before.totalConversations,
      overallCompliance: before.overallCompliance,
    },
    after: {
      generatedAt: after.generatedAt,
      totalConversations: after.totalConversations,
      overallCompliance: after.overallCompliance,
    },
    overallDelta: after.overallCompliance - before.overallCompliance,
    improved,
    regressed,
    unchanged,
    added,
    removed,
  };
}

export function formatDiffTerminal(diff: DiffResult): string {
  const lines: string[] = [];

  lines.push("Policy Compliance Diff");
  lines.push("━".repeat(50));

  const sign = diff.overallDelta >= 0 ? "+" : "";
  lines.push(
    `Overall: ${diff.before.overallCompliance}% → ${diff.after.overallCompliance}% (${sign}${diff.overallDelta}pp)`,
  );
  lines.push(
    `Conversations: ${diff.before.totalConversations} → ${diff.after.totalConversations}`,
  );
  lines.push("");

  if (diff.improved.length > 0) {
    lines.push("Improved:");
    for (const p of diff.improved) {
      const name = `"${p.policyName}"`;
      const pad = ".".repeat(Math.max(2, 40 - name.length));
      lines.push(`  ✓ ${name} ${pad} ${p.beforeRate}% → ${p.afterRate}% (+${p.delta}pp)`);
    }
    lines.push("");
  }

  if (diff.regressed.length > 0) {
    lines.push("Regressed:");
    for (const p of diff.regressed) {
      const name = `"${p.policyName}"`;
      const pad = ".".repeat(Math.max(2, 40 - name.length));
      lines.push(`  ✗ ${name} ${pad} ${p.beforeRate}% → ${p.afterRate}% (${p.delta}pp)`);
    }
    lines.push("");
  }

  if (diff.unchanged.length > 0) {
    lines.push(`Unchanged: ${diff.unchanged.length} policies`);
    lines.push("");
  }

  if (diff.added.length > 0) {
    lines.push("New policies:");
    for (const p of diff.added) {
      lines.push(`  + "${p.policyName}" — ${p.complianceRate}%`);
    }
    lines.push("");
  }

  if (diff.removed.length > 0) {
    lines.push("Removed policies:");
    for (const p of diff.removed) {
      lines.push(`  - "${p.policyName}" — was ${p.complianceRate}%`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
