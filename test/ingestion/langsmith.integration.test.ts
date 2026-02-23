import { describe, it, expect } from "vitest";
import { readLangSmithTraces } from "../../src/ingestion/langsmith.js";

const API_KEY = process.env.LANGSMITH_API_KEY;
const PROJECT = process.env.LANGSMITH_PROJECT ?? "converra-exploration";

describe.skipIf(!API_KEY)("LangSmith integration", () => {
  it("connects and resolves project", async () => {
    // Validates: auth, project resolution, POST /api/v1/runs/query
    const convs = await readLangSmithTraces({
      apiKey: API_KEY!,
      project: PROJECT,
      limit: 5,
    });

    console.log(`Fetched ${convs.length} conversations from ${PROJECT}`);

    // Project may have 0 runs — that's fine, we're testing the API contract
    expect(Array.isArray(convs)).toBe(true);

    for (const conv of convs) {
      expect(conv.id).toBeDefined();
      expect(conv.messages.length).toBeGreaterThan(0);
      expect(conv.metadata.source).toBe("langsmith");
      expect(conv.timestamp).toBeDefined();

      console.log(
        `  [${conv.id}] ${conv.messages.length} msgs, model=${conv.metadata.model}, tokens=${conv.metadata.totalTokens}`,
      );
    }
  });

  it("throws on nonexistent project", async () => {
    await expect(
      readLangSmithTraces({
        apiKey: API_KEY!,
        project: "definitely-does-not-exist-" + Date.now(),
        limit: 1,
      }),
    ).rejects.toThrow("not found");
  });
});
