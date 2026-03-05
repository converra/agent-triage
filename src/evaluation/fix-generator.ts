import { LlmClient } from "../llm/client.js";
import {
  buildFixGeneratorPrompt,
  buildRecommendationsPrompt,
} from "../llm/prompts.js";
import { parseJsonResponse } from "../llm/json.js";
import type { Policy } from "../policy/types.js";
import type { ConversationResult, FailurePattern } from "./types.js";
import { getLogger } from "../logger.js";

interface FixResult {
  fix: string;
  blastRadius: string[];
}

/**
 * Generate directional fixes for failing policies.
 */
export async function generateFixes(
  llm: LlmClient,
  policies: Policy[],
  results: ConversationResult[],
  failurePatterns: FailurePattern[],
  onProgress?: (current: number, total: number) => void,
): Promise<Map<string, FixResult>> {
  const fixes = new Map<string, FixResult>();

  // Only generate fixes for policies that are actually failing
  const failingPolicies = policies.filter((p) => {
    const fails = results.filter((r) =>
      r.policyResults.some((pr) => pr.policyId === p.id && !pr.passed),
    );
    return fails.length > 0;
  });

  const patternSummary = formatPatternSummary(failurePatterns);

  for (let i = 0; i < failingPolicies.length; i++) {
    const policy = failingPolicies[i]!;
    onProgress?.(i + 1, failingPolicies.length);

    try {
      // Get worst 3 failing conversations for this policy
      const failing = results
        .filter((r) =>
          r.policyResults.some((pr) => pr.policyId === policy.id && !pr.passed),
        )
        .sort((a, b) => {
          const aAvg =
            Object.values(a.metrics).reduce((s, v) => s + v, 0) /
            Object.values(a.metrics).length;
          const bAvg =
            Object.values(b.metrics).reduce((s, v) => s + v, 0) /
            Object.values(b.metrics).length;
          return aAvg - bAvg;
        })
        .slice(0, 3);

      const examples = failing.map((r) =>
        r.messages
          .map((m, j) => `Turn ${j + 1} [${m.role}]: ${m.content}`)
          .join("\n"),
      );

      const prompt = buildFixGeneratorPrompt(policy, examples, patternSummary);
      const response = await llm.call(prompt, {
        temperature: 0.3,
        maxTokens: 1024,
      });

      const parsed = parseJsonResponse(response.content) as Record<
        string,
        unknown
      >;
      fixes.set(policy.id, {
        fix: String(parsed.fix ?? ""),
        blastRadius: Array.isArray(parsed.blastRadius)
          ? parsed.blastRadius.map(String)
          : [],
      });
    } catch (error) {
      getLogger().warn(
        `  Warning: Could not generate fix for "${policy.name}": ${error}`,
      );
    }
  }

  return fixes;
}

/**
 * Generate top recommendations from aggregated failure patterns.
 * Generates one per failure category, capped at 5.
 */
export async function generateRecommendations(
  llm: LlmClient,
  failurePatterns: FailurePattern[],
  policies: Policy[],
  results: ConversationResult[],
): Promise<
  Array<{
    title: string;
    description: string;
    targetFailureTypes: string[];
    targetSubtypes: string[];
    affectedConversations: number;
    confidence: string;
  }>
> {
  const patternSummary = formatPatternSummary(failurePatterns);

  // Only include failing policies to keep the prompt focused
  const policySummary = policies
    .map((p) => {
      const total = results.length;
      const failing = results.filter((r) =>
        r.policyResults.some((pr) => pr.policyId === p.id && !pr.passed),
      ).length;
      if (failing === 0) return null;
      const rate = total > 0 ? Math.round(((total - failing) / total) * 100) : 100;
      return `- ${p.name}: ${rate}% compliance (${failing} failures)`;
    })
    .filter(Boolean)
    .join("\n");

  const maxRecs = Math.min(Math.max(failurePatterns.length, 3), 5);
  const evidenceExcerpts = buildEvidenceExcerpts(failurePatterns, results);
  const prompt = buildRecommendationsPrompt(patternSummary, policySummary, evidenceExcerpts, maxRecs);
  const response = await llm.call(prompt, {
    temperature: 0.3,
    maxTokens: 2048,
  });

  const parsed = parseJsonResponse(response.content) as Record<
    string,
    unknown
  >;
  const recs = (parsed.recommendations ?? []) as Array<
    Record<string, unknown>
  >;

  return recs.slice(0, maxRecs).map((rec) => ({
    title: String(rec.title ?? ""),
    description: String(rec.description ?? ""),
    targetFailureTypes: Array.isArray(rec.targetFailureTypes)
      ? rec.targetFailureTypes.map(String)
      : [],
    targetSubtypes: Array.isArray(rec.targetSubtypes)
      ? rec.targetSubtypes.map(String)
      : [],
    affectedConversations: Number(rec.affectedConversations ?? 0),
    confidence: String(rec.confidence ?? "medium"),
    howToApply: rec.howToApply ? String(rec.howToApply) : undefined,
  }));
}

/**
 * Build evidence excerpts from worst failing conversations, grouped by failure type.
 * Gives the LLM real content to reference in recommendations.
 */
function buildEvidenceExcerpts(
  patterns: FailurePattern[],
  results: ConversationResult[],
): string {
  const sections: string[] = [];

  for (const pattern of patterns) {
    // Find conversations with this failure type, sorted worst-first by avg metric
    const matching = results
      .filter((r) =>
        r.policyResults.some(
          (pr) => !pr.passed && pr.failureType === pattern.type,
        ),
      )
      .sort((a, b) => {
        const aAvg =
          Object.values(a.metrics).reduce((s, v) => s + v, 0) /
          Object.values(a.metrics).length;
        const bAvg =
          Object.values(b.metrics).reduce((s, v) => s + v, 0) /
          Object.values(b.metrics).length;
        return aAvg - bAvg;
      })
      .slice(0, 2);

    if (matching.length === 0) continue;

    const excerpts = matching.map((conv) => {
      const lines: string[] = [];

      // System prompt snippet
      const systemMsg = conv.messages.find((m) => m.role === "system");
      if (systemMsg) {
        const snippet = systemMsg.content.slice(0, 300);
        lines.push(`  System prompt: "${snippet}${systemMsg.content.length > 300 ? "..." : ""}"`);
      }

      // Failing policy evidence
      const failingPolicies = conv.policyResults.filter(
        (pr) => !pr.passed && pr.failureType === pattern.type,
      );
      for (const pr of failingPolicies.slice(0, 2)) {
        lines.push(`  Policy violation: ${pr.policyId} — ${pr.evidence}`);
      }

      // Worst failing turn content
      const failingTurns = failingPolicies.flatMap((pr) => pr.failingTurns ?? []);
      const uniqueTurns = [...new Set(failingTurns)].sort((a, b) => a - b).slice(0, 2);
      for (const turnNum of uniqueTurns) {
        const msg = conv.messages[turnNum - 1];
        if (msg) {
          const content = msg.content.slice(0, 200);
          lines.push(`  Turn ${turnNum} [${msg.role}]: "${content}${msg.content.length > 200 ? "..." : ""}"`);
        }
      }

      // Diagnosis summary if available
      if (conv.diagnosis) {
        lines.push(`  Diagnosis: ${conv.diagnosis.shortSummary || conv.diagnosis.summary}`);
      }

      return `  Conversation ${conv.id}:\n${lines.join("\n")}`;
    });

    sections.push(`${pattern.type}:\n${excerpts.join("\n\n")}`);
  }

  return sections.join("\n\n---\n\n");
}

function formatPatternSummary(patterns: FailurePattern[]): string {
  return patterns
    .map((p) => {
      const subtypes = p.subtypes
        .map((s) => `${s.name}: ${s.count} (${s.percentage}%)`)
        .join(", ");
      return `${p.type}: ${p.count} failures (${p.criticalCount} critical) — subtypes: ${subtypes}`;
    })
    .join("\n");
}
