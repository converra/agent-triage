import { describe, it, expect, vi } from "vitest";
import { discoverAgents, autoExtractPolicies } from "../../src/ingestion/auto-discovery.js";
import { hashPrompt } from "../../src/ingestion/langsmith.js";
import { createMockLlm, makeConversation } from "../helpers.js";
import type { NormalizedConversation } from "../../src/ingestion/types.js";

function makeConvWithPrompt(
  id: string,
  systemPrompt: string,
  agentName?: string,
): NormalizedConversation {
  return {
    ...makeConversation(id),
    systemPrompt,
    metadata: {
      source: "langsmith",
      promptHash: hashPrompt(systemPrompt),
      agentName,
    },
  };
}

describe("discoverAgents", () => {
  it("groups conversations by system prompt hash", () => {
    const conversations = [
      makeConvWithPrompt("c1", "You are a billing agent.", "Billing Agent"),
      makeConvWithPrompt("c2", "You are a billing agent.", "Billing Agent"),
      makeConvWithPrompt("c3", "You are a sales agent.", "Sales Agent"),
    ];

    const agents = discoverAgents(conversations);

    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe("Billing Agent");
    expect(agents[0].conversationCount).toBe(2);
    expect(agents[1].name).toBe("Sales Agent");
    expect(agents[1].conversationCount).toBe(1);
  });

  it("sorts agents by conversation count descending", () => {
    const conversations = [
      makeConvWithPrompt("c1", "Agent A prompt", "Agent A"),
      makeConvWithPrompt("c2", "Agent B prompt", "Agent B"),
      makeConvWithPrompt("c3", "Agent B prompt", "Agent B"),
      makeConvWithPrompt("c4", "Agent B prompt", "Agent B"),
    ];

    const agents = discoverAgents(conversations);

    expect(agents[0].name).toBe("Agent B");
    expect(agents[0].conversationCount).toBe(3);
    expect(agents[1].name).toBe("Agent A");
    expect(agents[1].conversationCount).toBe(1);
  });

  it("skips conversations without system prompt", () => {
    const conversations = [
      makeConversation("c1"),
      makeConvWithPrompt("c2", "You are an agent.", "Agent"),
    ];

    const agents = discoverAgents(conversations);

    expect(agents).toHaveLength(1);
    expect(agents[0].conversationCount).toBe(1);
  });

  it("returns empty array when no conversations have system prompts", () => {
    const conversations = [
      makeConversation("c1"),
      makeConversation("c2"),
    ];

    const agents = discoverAgents(conversations);
    expect(agents).toHaveLength(0);
  });

  it("uses most common agent name per prompt group", () => {
    const prompt = "You are a support bot.";
    const conversations = [
      makeConvWithPrompt("c1", prompt, "Support Bot"),
      makeConvWithPrompt("c2", prompt, "Support Bot"),
      makeConvWithPrompt("c3", prompt, "Help Agent"),
    ];

    const agents = discoverAgents(conversations);

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("Support Bot");
  });

  it("normalizes whitespace in prompt hashing", () => {
    const conversations = [
      makeConvWithPrompt("c1", "You are  a  billing   agent.", "Billing"),
      makeConvWithPrompt("c2", "You are a billing agent.", "Billing"),
    ];

    const agents = discoverAgents(conversations);

    // Should be grouped together (whitespace normalized)
    expect(agents).toHaveLength(1);
    expect(agents[0].conversationCount).toBe(2);
  });
});

describe("autoExtractPolicies", () => {
  it("extracts policies from discovered agents (prompt-based)", async () => {
    const conversations = [
      makeConvWithPrompt("c1", "You are a billing agent. Always greet the user.", "Billing Agent"),
      makeConvWithPrompt("c2", "You are a billing agent. Always greet the user.", "Billing Agent"),
    ];

    const mockLlm = createMockLlm(() =>
      JSON.stringify([
        {
          id: "greet-user",
          name: "Greet user",
          description: "Agent must greet the user.",
          complexity: 1,
          category: "tone",
        },
      ]),
    );

    const result = await autoExtractPolicies(mockLlm as any, conversations);

    expect(result.method).toBe("prompt-based");
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0].id).toBe("greet-user");
    expect(result.agents).toHaveLength(1);
    expect(result.systemPrompt).toBe("You are a billing agent. Always greet the user.");
  });

  it("prefixes policy names when multiple agents found", async () => {
    const conversations = [
      makeConvWithPrompt("c1", "You are a billing agent.", "Billing"),
      makeConvWithPrompt("c2", "You are a sales agent.", "Sales"),
    ];

    const mockLlm = createMockLlm(() =>
      JSON.stringify([
        {
          id: "greet-user",
          name: "Greet user",
          description: "Agent must greet.",
          complexity: 1,
          category: "tone",
        },
      ]),
    );

    const result = await autoExtractPolicies(mockLlm as any, conversations);

    expect(result.method).toBe("prompt-based");
    expect(result.policies).toHaveLength(2);
    // Policies should be prefixed with agent name
    expect(result.policies[0].name).toContain("[Billing]");
    expect(result.policies[1].name).toContain("[Sales]");
  });

  it("falls back to behavioral inference when no system prompts", async () => {
    const conversations = [
      makeConversation("c1"),
      makeConversation("c2"),
    ];

    const mockLlm = createMockLlm(() =>
      JSON.stringify([
        {
          id: "inferred-policy",
          name: "Inferred policy",
          description: "Inferred from behavior.",
          complexity: 2,
          category: "behavior",
        },
      ]),
    );

    const result = await autoExtractPolicies(mockLlm as any, conversations);

    expect(result.method).toBe("behavioral-inference");
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0].id).toBe("inferred-policy");
    expect(result.agents).toHaveLength(0);
  });
});
