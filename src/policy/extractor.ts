import { PoliciesFileSchema, type Policy } from "./types.js";
import { LlmClient } from "../llm/client.js";
import { buildPolicyExtractionPrompt } from "../llm/prompts.js";
import { parseJsonResponse } from "../llm/json.js";

export async function extractPolicies(
  llm: LlmClient,
  systemPrompt: string,
): Promise<Policy[]> {
  const prompt = buildPolicyExtractionPrompt(systemPrompt);

  const response = await llm.call(prompt, {
    temperature: 0.3,
    maxTokens: 4096,
  });

  const parsed = parseJsonResponse(response.content);

  const validated = PoliciesFileSchema.parse(parsed);

  if (validated.length === 0) {
    throw new Error(
      "Policy extraction returned no policies. " +
        "The system prompt may be too short or not contain testable rules.",
    );
  }

  return validated;
}
