import { describe, it, expect } from "vitest";
import { extractPolicies } from "../../src/policy/extractor.js";
import { createMockLlm } from "../helpers.js";
import type { LlmClient } from "../../src/llm/client.js";

const validPoliciesResponse = JSON.stringify([
  {
    id: "greet-by-name",
    name: "Greet user by name",
    description: "Use the user's name in the greeting when available.",
    complexity: 1,
    category: "tone",
  },
  {
    id: "escalate-billing",
    name: "Escalate billing disputes",
    description: "Escalate billing disputes over $100 to human agent.",
    complexity: 3,
    category: "routing",
  },
  {
    id: "no-fabricated-pricing",
    name: "No fabricated pricing",
    description: "Do not make claims about pricing not in the system prompt.",
    complexity: 4,
    category: "safety",
  },
]);

describe("extractPolicies", () => {
  it("extracts policies from LLM response", async () => {
    const llm = createMockLlm(() => validPoliciesResponse);

    const policies = await extractPolicies(
      llm as unknown as LlmClient,
      "You are a support agent. Always greet the user by name.",
    );

    expect(policies).toHaveLength(3);
    expect(policies[0]!.id).toBe("greet-by-name");
    expect(policies[0]!.name).toBe("Greet user by name");
    expect(policies[0]!.complexity).toBe(1);
    expect(policies[0]!.category).toBe("tone");
  });

  it("validates policy schema (rejects invalid data)", async () => {
    const invalid = JSON.stringify([
      { id: "test", name: "Test" }, // missing description, complexity, category
    ]);
    const llm = createMockLlm(() => invalid);

    await expect(
      extractPolicies(llm as unknown as LlmClient, "test prompt"),
    ).rejects.toThrow();
  });

  it("throws when no policies are extracted", async () => {
    const llm = createMockLlm(() => "[]");

    await expect(
      extractPolicies(llm as unknown as LlmClient, "test prompt"),
    ).rejects.toThrow("Policy extraction returned no policies");
  });

  it("handles markdown-wrapped response", async () => {
    const llm = createMockLlm(
      () => "```json\n" + validPoliciesResponse + "\n```",
    );

    const policies = await extractPolicies(
      llm as unknown as LlmClient,
      "test prompt",
    );

    expect(policies).toHaveLength(3);
  });

  it("passes correct temperature and maxTokens", async () => {
    const llm = createMockLlm(() => validPoliciesResponse);

    await extractPolicies(llm as unknown as LlmClient, "test prompt");

    expect(llm.call).toHaveBeenCalledWith(
      expect.any(String),
      { temperature: 0.3, maxTokens: 4096 },
    );
  });

  it("includes system prompt in extraction prompt", async () => {
    const llm = createMockLlm(() => validPoliciesResponse);

    await extractPolicies(
      llm as unknown as LlmClient,
      "You must always respond in French.",
    );

    const prompt = llm.call.mock.calls[0]![0] as string;
    expect(prompt).toContain("always respond in French");
  });

  it("validates all category values", async () => {
    const allCategories = JSON.stringify([
      { id: "r1", name: "R1", description: "D1", complexity: 1, category: "routing" },
      { id: "t1", name: "T1", description: "D1", complexity: 1, category: "tone" },
      { id: "s1", name: "S1", description: "D1", complexity: 1, category: "safety" },
      { id: "k1", name: "K1", description: "D1", complexity: 1, category: "knowledge" },
      { id: "b1", name: "B1", description: "D1", complexity: 1, category: "behavior" },
      { id: "f1", name: "F1", description: "D1", complexity: 1, category: "formatting" },
    ]);
    const llm = createMockLlm(() => allCategories);

    const policies = await extractPolicies(llm as unknown as LlmClient, "test");
    expect(policies).toHaveLength(6);
  });

  it("rejects invalid category values", async () => {
    const invalid = JSON.stringify([
      { id: "x1", name: "X1", description: "D1", complexity: 1, category: "invalid_category" },
    ]);
    const llm = createMockLlm(() => invalid);

    await expect(
      extractPolicies(llm as unknown as LlmClient, "test"),
    ).rejects.toThrow();
  });

  it("validates complexity range (1-5)", async () => {
    const invalid = JSON.stringify([
      { id: "x1", name: "X1", description: "D1", complexity: 6, category: "tone" },
    ]);
    const llm = createMockLlm(() => invalid);

    await expect(
      extractPolicies(llm as unknown as LlmClient, "test"),
    ).rejects.toThrow();
  });
});
