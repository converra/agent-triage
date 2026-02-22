import type { Policy } from "../policy/types.js";
import type {
  ConversationResult,
  FailurePattern,
  FailureType,
  MetricScores,
  METRIC_NAMES,
} from "../evaluation/types.js";

/**
 * Aggregate policy results across all conversations.
 */
export function aggregatePolicies(
  policies: Policy[],
  results: ConversationResult[],
): Array<
  Policy & {
    passing: number;
    failing: number;
    total: number;
    complianceRate: number;
    fix?: string;
    blastRadius?: string[];
    failingConversationIds: string[];
  }
> {
  return policies.map((policy) => {
    const relevant = results.filter((r) =>
      r.policyResults.some((pr) => pr.policyId === policy.id),
    );

    const passing = relevant.filter((r) =>
      r.policyResults.some((pr) => pr.policyId === policy.id && pr.passed),
    ).length;

    const failing = relevant.filter((r) =>
      r.policyResults.some((pr) => pr.policyId === policy.id && !pr.passed),
    ).length;

    const total = relevant.length;
    const complianceRate = total > 0 ? Math.round((passing / total) * 100) : 100;

    const failingConversationIds = relevant
      .filter((r) =>
        r.policyResults.some((pr) => pr.policyId === policy.id && !pr.passed),
      )
      .map((r) => r.id);

    return {
      ...policy,
      passing,
      failing,
      total,
      complianceRate,
      failingConversationIds,
    };
  });
}

/**
 * Aggregate failure patterns across all conversations.
 * Groups by failureType and failureSubtype.
 */
export function aggregateFailurePatterns(
  results: ConversationResult[],
): FailurePattern[] {
  const typeMap = new Map<
    FailureType,
    {
      count: number;
      criticalCount: number;
      subtypes: Map<string, number>;
    }
  >();

  for (const result of results) {
    for (const pr of result.policyResults) {
      if (pr.passed || !pr.failureType) continue;

      const ft = pr.failureType as FailureType;
      if (!typeMap.has(ft)) {
        typeMap.set(ft, { count: 0, criticalCount: 0, subtypes: new Map() });
      }

      const entry = typeMap.get(ft)!;
      entry.count++;

      // Count critical based on diagnosis severity
      if (result.diagnosis?.severity === "critical") {
        entry.criticalCount++;
      }

      if (pr.failureSubtype) {
        entry.subtypes.set(
          pr.failureSubtype,
          (entry.subtypes.get(pr.failureSubtype) ?? 0) + 1,
        );
      }
    }
  }

  const patterns: FailurePattern[] = [];
  for (const [type, data] of typeMap) {
    const subtypes = [...data.subtypes.entries()]
      .map(([name, count]) => ({
        name,
        count,
        percentage:
          data.count > 0 ? Math.round((count / data.count) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    patterns.push({
      type,
      count: data.count,
      criticalCount: data.criticalCount,
      subtypes,
    });
  }

  return patterns.sort((a, b) => b.count - a.count);
}

/**
 * Calculate average metrics across all conversations.
 */
export function calculateMetricSummary(
  results: ConversationResult[],
): Record<string, number> {
  if (results.length === 0) return {};

  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};

  for (const result of results) {
    for (const [key, value] of Object.entries(result.metrics)) {
      sums[key] = (sums[key] ?? 0) + value;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  const averages: Record<string, number> = {};
  for (const key of Object.keys(sums)) {
    averages[key] = Math.round(sums[key]! / counts[key]!);
  }

  return averages;
}

/**
 * Calculate overall compliance rate (% of policy checks that passed).
 */
export function calculateOverallCompliance(
  results: ConversationResult[],
): number {
  let totalChecks = 0;
  let passedChecks = 0;

  for (const result of results) {
    for (const pr of result.policyResults) {
      totalChecks++;
      if (pr.passed) passedChecks++;
    }
  }

  return totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 100;
}
