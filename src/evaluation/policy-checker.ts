import { LlmClient } from "../llm/client.js";
import { buildPolicyCheckerPrompt } from "../llm/prompts.js";
import { parseJsonResponse } from "../llm/json.js";
import type { Policy } from "../policy/types.js";
import type { PolicyResult, Verdict } from "./types.js";
import type { NormalizedConversation } from "../ingestion/types.js";
import { formatTranscript } from "./shared.js";
import { getLogger } from "../logger.js";

/**
 * Check all policies against a single conversation.
 * Batches all policies into one LLM call. Falls back to individual calls on failure.
 */
export async function checkPolicies(
  llm: LlmClient,
  conversation: NormalizedConversation,
  policies: Policy[],
  systemPrompt: string,
): Promise<PolicyResult[]> {
  const transcript = formatTranscript(conversation);

  try {
    return await batchCheck(llm, transcript, policies, systemPrompt);
  } catch (batchError) {
    getLogger().warn(
      `  Batch policy check failed for ${conversation.id}, falling back to individual checks...`,
    );
    return individualCheck(llm, transcript, policies, systemPrompt);
  }
}

async function batchCheck(
  llm: LlmClient,
  transcript: string,
  policies: Policy[],
  systemPrompt: string,
): Promise<PolicyResult[]> {
  const prompt = buildPolicyCheckerPrompt(systemPrompt, transcript, policies);

  const response = await llm.call(prompt, {
    temperature: 0.2,
    maxTokens: 4096,
  });

  const parsed = parseJsonResponse(response.content);

  if (!Array.isArray(parsed)) {
    throw new Error("Expected array of policy results");
  }

  return (parsed as Array<Record<string, unknown>>).map((result) => {
    const verdict = parseVerdict(result);
    return {
      policyId: String(result.policyId ?? ""),
      verdict,
      passed: verdict !== "fail",
      evidence: String(result.evidence ?? ""),
      failingTurns: Array.isArray(result.failingTurns)
        ? result.failingTurns.map(Number)
        : undefined,
      failureType: result.failureType ? String(result.failureType) as PolicyResult["failureType"] : null,
      failureSubtype: result.failureSubtype ? String(result.failureSubtype) : null,
    };
  });
}

async function individualCheck(
  llm: LlmClient,
  transcript: string,
  policies: Policy[],
  systemPrompt: string,
): Promise<PolicyResult[]> {
  const results: PolicyResult[] = [];

  for (const policy of policies) {
    try {
      const prompt = buildPolicyCheckerPrompt(systemPrompt, transcript, [
        policy,
      ]);
      const response = await llm.call(prompt, {
        temperature: 0.2,
        maxTokens: 1024,
      });
      const parsed = parseJsonResponse(response.content);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const result = arr[0] as Record<string, unknown>;

      const verdict = parseVerdict(result);
      results.push({
        policyId: policy.id,
        verdict,
        passed: verdict !== "fail",
        evidence: String(result.evidence ?? ""),
        failingTurns: Array.isArray(result.failingTurns)
          ? result.failingTurns.map(Number)
          : undefined,
        failureType: result.failureType
          ? (String(result.failureType) as PolicyResult["failureType"])
          : null,
        failureSubtype: result.failureSubtype
          ? String(result.failureSubtype)
          : null,
      });
    } catch (error) {
      getLogger().warn(`  Warning: Could not evaluate policy "${policy.name}": ${error}`);
      results.push({
        policyId: policy.id,
        verdict: "fail" as Verdict,
        passed: false,
        evidence: "Error: Could not evaluate this policy. Marked as failing to avoid false positives.",
        failingTurns: [],
        failureType: null,
        failureSubtype: null,
      });
    }
  }

  return results;
}

/** Parse verdict from LLM response, with fallback from legacy `passed` boolean */
function parseVerdict(result: Record<string, unknown>): Verdict {
  const v = String(result.verdict ?? "").toLowerCase();
  if (v === "pass" || v === "fail" || v === "not_applicable") return v;
  // Fallback: legacy LLM response with boolean `passed`
  return result.passed ? "pass" : "fail";
}
