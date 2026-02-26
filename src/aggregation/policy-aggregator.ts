import type { Policy } from "../policy/types.js";
import type {
  AgentSummary,
  ConversationResult,
  FailurePattern,
  FailureType,
  MetricScores,
  METRIC_NAMES,
} from "../evaluation/types.js";
import type { NormalizedConversation } from "../ingestion/types.js";

/**
 * Aggregate policy results across all conversations.
 * Excludes not_applicable verdicts from compliance calculation.
 */
export function aggregatePolicies(
  policies: Policy[],
  results: ConversationResult[],
): Array<
  Policy & {
    passing: number;
    failing: number;
    notApplicable: number;
    evaluated: number;
    total: number;
    complianceRate: number;
    fix?: string;
    blastRadius?: string[];
    failingConversationIds: string[];
  }
> {
  return policies.map((policy) => {
    let passing = 0;
    let failing = 0;
    let notApplicable = 0;
    const failingConversationIds: string[] = [];

    for (const r of results) {
      const pr = r.policyResults.find((p) => p.policyId === policy.id);
      if (!pr) continue;

      if (pr.verdict === "not_applicable") {
        notApplicable++;
      } else if (pr.verdict === "fail") {
        failing++;
        failingConversationIds.push(r.id);
      } else {
        passing++;
      }
    }

    const evaluated = passing + failing;
    const total = evaluated + notApplicable;
    // Compliance is based only on evaluated conversations (pass + fail)
    const complianceRate = evaluated > 0 ? Math.round((passing / evaluated) * 100) : 100;

    return {
      ...policy,
      passing,
      failing,
      notApplicable,
      evaluated,
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
      if (pr.verdict !== "fail" || !pr.failureType) continue;

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
 * Calculate overall compliance rate (% of evaluated policy checks that passed).
 * Excludes not_applicable verdicts from the denominator.
 */
export function calculateOverallCompliance(
  results: ConversationResult[],
): number {
  let evaluatedChecks = 0;
  let passedChecks = 0;

  for (const result of results) {
    for (const pr of result.policyResults) {
      if (pr.verdict === "not_applicable") continue;
      evaluatedChecks++;
      if (pr.verdict === "pass") passedChecks++;
    }
  }

  return evaluatedChecks > 0 ? Math.round((passedChecks / evaluatedChecks) * 100) : 100;
}

/**
 * Aggregate results per agent for agent-centric report view.
 */
export function aggregateByAgent(
  conversations: NormalizedConversation[],
  results: ConversationResult[],
  policies: Policy[],
): AgentSummary[] {
  // Group conversations by agent name
  const agentConvs = new Map<string, string[]>();
  for (const conv of conversations) {
    const name = conv.metadata.agentName ?? "Unknown Agent";
    if (!agentConvs.has(name)) agentConvs.set(name, []);
    agentConvs.get(name)!.push(conv.id);
  }

  const summaries: AgentSummary[] = [];
  for (const [name, convIds] of agentConvs) {
    const convIdSet = new Set(convIds);
    const agentResults = results.filter((r) => convIdSet.has(r.id));

    // Calculate compliance excluding NA
    let passed = 0;
    let failed = 0;
    const policyFailCounts = new Map<string, number>();

    for (const r of agentResults) {
      for (const pr of r.policyResults) {
        if (pr.verdict === "not_applicable") continue;
        if (pr.verdict === "pass") {
          passed++;
        } else {
          failed++;
          policyFailCounts.set(pr.policyId, (policyFailCounts.get(pr.policyId) ?? 0) + 1);
        }
      }
    }

    const evaluated = passed + failed;
    const compliance = evaluated > 0 ? Math.round((passed / evaluated) * 100) : 100;

    // Count unique policies that were actually evaluated for this agent
    const evaluatedPolicyIds = new Set<string>();
    for (const r of agentResults) {
      for (const pr of r.policyResults) {
        if (pr.verdict !== "not_applicable") evaluatedPolicyIds.add(pr.policyId);
      }
    }

    const topFailing = buildTopFailingPolicies(policyFailCounts, agentResults, policies);

    summaries.push({
      name,
      conversationCount: convIds.length,
      policiesEvaluated: evaluatedPolicyIds.size,
      compliance,
      topFailingPolicies: topFailing,
    });
  }

  return summaries.sort((a, b) => a.compliance - b.compliance);
}

function buildTopFailingPolicies(
  failCounts: Map<string, number>,
  results: ConversationResult[],
  policies: Policy[],
): Array<{ id: string; name: string; complianceRate: number }> {
  return [...failCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => {
      const policy = policies.find((p) => p.id === id);
      const policyPassed = results.reduce((count, r) => {
        const pr = r.policyResults.find((p) => p.policyId === id);
        return count + (pr?.verdict === "pass" ? 1 : 0);
      }, 0);
      const policyFailed = failCounts.get(id) ?? 0;
      const policyEval = policyPassed + policyFailed;
      return {
        id,
        name: policy?.name ?? id,
        complianceRate: policyEval > 0 ? Math.round((policyPassed / policyEval) * 100) : 0,
      };
    });
}
