import { LlmClient } from "../llm/client.js";
import { buildPolicyCheckerPrompt } from "../llm/prompts.js";
import { parseJsonResponse } from "../llm/json.js";
import type { Policy } from "../policy/types.js";
import type { PolicyResult } from "./types.js";
import type { NormalizedConversation } from "../ingestion/types.js";

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
    console.warn(
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

  return (parsed as Array<Record<string, unknown>>).map((result) => ({
    policyId: String(result.policyId ?? ""),
    passed: Boolean(result.passed),
    evidence: String(result.evidence ?? ""),
    failingTurns: Array.isArray(result.failingTurns)
      ? result.failingTurns.map(Number)
      : undefined,
    failureType: result.failureType ? String(result.failureType) as PolicyResult["failureType"] : null,
    failureSubtype: result.failureSubtype ? String(result.failureSubtype) : null,
  }));
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

      results.push({
        policyId: policy.id,
        passed: Boolean(result.passed),
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
    } catch {
      results.push({
        policyId: policy.id,
        passed: true,
        evidence: "Error: Could not evaluate this policy.",
        failingTurns: [],
        failureType: null,
        failureSubtype: null,
      });
    }
  }

  return results;
}

function formatTranscript(conversation: NormalizedConversation): string {
  return conversation.messages
    .map((msg, i) => `Turn ${i + 1} [${msg.role}]: ${msg.content}`)
    .join("\n\n");
}
