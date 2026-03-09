import type { NormalizedConversation } from "./types.js";
import { hashPrompt } from "./langsmith.js";
import type { Policy } from "../policy/types.js";
import type { LlmClient } from "../llm/client.js";
import { extractPolicies } from "../policy/extractor.js";
import { buildBehavioralInferencePrompt } from "../llm/prompts.js";
import { parseJsonResponse } from "../llm/json.js";
import { PoliciesFileSchema } from "../policy/types.js";
import { getLogger } from "../logger.js";

export interface DiscoveredAgent {
  name: string;
  promptHash: string;
  systemPrompt: string;
  conversationCount: number;
}

export interface DiscoveryResult {
  agents: DiscoveredAgent[];
  policies: Policy[];
  systemPrompt: string;
  method: "prompt-based" | "behavioral-inference";
}

// ─── Agent Discovery ─────────────────────────────────────────────────

export function discoverAgents(
  conversations: NormalizedConversation[],
): DiscoveredAgent[] {
  // Group conversations by system prompt hash
  const promptGroups = new Map<
    string,
    { prompt: string; names: Map<string, number>; count: number }
  >();

  for (const conv of conversations) {
    if (!conv.systemPrompt) continue;

    const hash =
      conv.metadata.promptHash ?? hashPrompt(conv.systemPrompt);

    if (!promptGroups.has(hash)) {
      promptGroups.set(hash, {
        prompt: conv.systemPrompt,
        names: new Map(),
        count: 0,
      });
    }

    const group = promptGroups.get(hash)!;
    group.count++;

    // Track agent names for voting
    const name = conv.metadata.agentName ?? "Unknown Agent";
    group.names.set(name, (group.names.get(name) ?? 0) + 1);

    // Surface sub-agents from multi-agent traces
    if (conv.metadata.subAgents) {
      for (const sub of conv.metadata.subAgents) {
        if (!promptGroups.has(sub.promptHash)) {
          promptGroups.set(sub.promptHash, {
            prompt: sub.systemPrompt,
            names: new Map(),
            count: 0,
          });
        }
        const subGroup = promptGroups.get(sub.promptHash)!;
        subGroup.count++;
        subGroup.names.set(sub.name, (subGroup.names.get(sub.name) ?? 0) + 1);
      }
    }
  }

  // Build discovered agents, sorted by conversation count descending
  const agents: DiscoveredAgent[] = [];
  for (const [hash, group] of promptGroups) {
    // Pick the most common name
    let bestName = "Unknown Agent";
    let bestCount = 0;
    for (const [name, count] of group.names) {
      if (count > bestCount) {
        bestName = name;
        bestCount = count;
      }
    }

    agents.push({
      name: bestName,
      promptHash: hash,
      systemPrompt: group.prompt,
      conversationCount: group.count,
    });
  }

  agents.sort((a, b) => b.conversationCount - a.conversationCount);
  return agents;
}

// ─── Auto-Policy Extraction ──────────────────────────────────────────

export async function autoExtractPolicies(
  llm: LlmClient,
  conversations: NormalizedConversation[],
): Promise<DiscoveryResult> {
  const agents = discoverAgents(conversations);

  if (agents.length > 0) {
    return extractPoliciesFromAgents(llm, agents, conversations);
  }

  // Fallback: no system prompts found
  return inferPoliciesFromBehavior(llm, conversations);
}

async function extractPoliciesFromAgents(
  llm: LlmClient,
  agents: DiscoveredAgent[],
  conversations: NormalizedConversation[],
): Promise<DiscoveryResult> {
  // Print discovery
  getLogger().log(`\nDiscovered agents:`);
  for (let i = 0; i < agents.length; i++) {
    getLogger().log(
      `  ${i + 1}. ${agents[i].name} — ${agents[i].conversationCount} conversations`,
    );
  }

  const allPolicies: Policy[] = [];
  const multiAgent = agents.length > 1;

  for (const agent of agents) {
    getLogger().log(
      `\nExtracting policies from ${agent.name}...`,
    );

    try {
      const policies = await extractPolicies(llm, agent.systemPrompt);

      for (const policy of policies) {
        // Tag every policy with its source agent for scoping during evaluation
        policy.sourceAgent = agent.name;

        // Namespace policy IDs to avoid collisions in multi-agent setups
        if (multiAgent) {
          policy.id = `${slugify(agent.name)}-${policy.id}`;
        }
        allPolicies.push(policy);
      }
    } catch (error) {
      getLogger().warn(
        `  Warning: Could not extract policies from ${agent.name}: ${error}`,
      );
    }
  }

  if (allPolicies.length === 0) {
    // All prompt-based extraction failed — fall back to behavioral inference
    return inferPoliciesFromBehavior(llm, conversations);
  }

  getLogger().log(
    `\nExtracted ${allPolicies.length} policies across ${agents.length} agent${agents.length > 1 ? "s" : ""}.`,
  );

  // Use the most common agent's system prompt as the primary prompt
  const primaryPrompt = agents[0].systemPrompt;

  return {
    agents,
    policies: allPolicies,
    systemPrompt: primaryPrompt,
    method: "prompt-based",
  };
}

// ─── Behavioral Inference Fallback ───────────────────────────────────

async function inferPoliciesFromBehavior(
  llm: LlmClient,
  conversations: NormalizedConversation[],
): Promise<DiscoveryResult> {
  getLogger().warn(
    "\nNo system prompt found in traces. Inferring policies from observed behavior...",
  );

  // Pick 20 diverse conversations (spread across time range)
  const samples = selectDiverseSamples(conversations, 20);

  const prompt = buildBehavioralInferencePrompt(samples);
  const response = await llm.call(prompt, {
    temperature: 0.3,
    maxTokens: 4096,
  });

  const parsed = parseJsonResponse(response.content);
  const policies = PoliciesFileSchema.parse(parsed);

  getLogger().warn(
    "Warning: No system prompt found in traces. Policies were inferred from observed behavior and may be incomplete.",
  );

  getLogger().log(`Inferred ${policies.length} policies from behavior.`);

  return {
    agents: [],
    policies,
    systemPrompt: "",
    method: "behavioral-inference",
  };
}

function selectDiverseSamples(
  conversations: NormalizedConversation[],
  count: number,
): NormalizedConversation[] {
  if (conversations.length <= count) return [...conversations];

  // Pick evenly spaced samples across the array (already sorted by time from ingestion)
  const step = conversations.length / count;
  const samples: NormalizedConversation[] = [];

  for (let i = 0; i < count; i++) {
    const idx = Math.min(
      Math.floor(i * step),
      conversations.length - 1,
    );
    samples.push(conversations[idx]);
  }

  return samples;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
