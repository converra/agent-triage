import { LlmClient } from "../llm/client.js";
import type { Policy } from "../policy/types.js";
import type { NormalizedConversation } from "../ingestion/types.js";
import type { ConversationResult } from "./types.js";
import { evaluateConversation } from "./evaluator.js";
import { checkPolicies } from "./policy-checker.js";
import { saveProgress } from "./progress.js";

interface RunnerOptions {
  concurrency: number;
  policiesHash: string;
  previousResults?: Map<string, ConversationResult>;
  onProgress?: (completed: number, total: number, id: string) => void;
}

/**
 * Evaluate all conversations concurrently with rate limiting.
 * Saves progress after each conversation completes.
 */
export async function evaluateAll(
  llm: LlmClient,
  conversations: NormalizedConversation[],
  policies: Policy[],
  systemPrompt: string,
  options: RunnerOptions,
): Promise<ConversationResult[]> {
  const { concurrency, policiesHash, previousResults, onProgress } = options;

  const results = new Map<string, ConversationResult>(
    previousResults ?? new Map(),
  );

  // Filter out already-completed conversations
  const pending = conversations.filter((c) => !results.has(c.id));

  if (pending.length === 0) {
    return [...results.values()];
  }

  if (previousResults && previousResults.size > 0) {
    console.log(
      `  Resuming: ${previousResults.size} already completed, ${pending.length} remaining.\n`,
    );
  }

  let completed = results.size;
  const total = conversations.length;

  // Process in batches of `concurrency`
  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map(async (conv) => {
        const result = await evaluateSingle(llm, conv, policies, systemPrompt);
        return result;
      }),
    );

    for (let j = 0; j < batch.length; j++) {
      const conv = batch[j]!;
      const outcome = batchResults[j]!;

      if (outcome.status === "fulfilled") {
        results.set(conv.id, outcome.value);
      } else {
        console.warn(
          `  Error evaluating ${conv.id}: ${outcome.reason}. Skipping.`,
        );
      }

      completed++;
      onProgress?.(completed, total, conv.id);
    }

    // Save progress after each batch
    await saveProgress(policiesHash, results);
  }

  return [...results.values()];
}

async function evaluateSingle(
  llm: LlmClient,
  conversation: NormalizedConversation,
  policies: Policy[],
  systemPrompt: string,
): Promise<ConversationResult> {
  // Use the conversation's own system prompt if available, fall back to the provided one
  const effectivePrompt = conversation.systemPrompt ?? systemPrompt;

  const [metrics, policyResults] = await Promise.all([
    evaluateConversation(llm, conversation, effectivePrompt),
    checkPolicies(llm, conversation, policies, effectivePrompt),
  ]);

  return {
    id: conversation.id,
    metrics,
    policyResults,
    messages: conversation.messages,
  };
}
