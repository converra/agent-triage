import { describe, it, expect } from "vitest";
import { readJsonTraces } from "../../src/ingestion/json.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, unlink } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../fixtures");

describe("readJsonTraces", () => {
  it("reads array-format conversations", async () => {
    const convs = await readJsonTraces(
      resolve(fixturesDir, "sample-conversations.json"),
    );

    expect(convs.length).toBeGreaterThan(0);
    for (const conv of convs) {
      expect(conv.id).toBeDefined();
      expect(conv.messages.length).toBeGreaterThan(0);
      expect(conv.metadata.source).toBe("json");
      expect(conv.timestamp).toBeDefined();
    }
  });

  it("normalizes role variants (human→user, ai→assistant)", async () => {
    const tmp = resolve(fixturesDir, "_test_roles.json");
    await writeFile(
      tmp,
      JSON.stringify([
        {
          id: "role-test",
          messages: [
            { role: "human", content: "hello" },
            { role: "ai", content: "hi" },
            { role: "agent", content: "how can I help?" },
            { role: "customer", content: "fix my order" },
            { sender: "bot", text: "on it" },
          ],
        },
      ]),
    );

    try {
      const [conv] = await readJsonTraces(tmp);
      expect(conv.messages[0].role).toBe("user");
      expect(conv.messages[1].role).toBe("assistant");
      expect(conv.messages[2].role).toBe("assistant");
      expect(conv.messages[3].role).toBe("user");
      expect(conv.messages[4].role).toBe("assistant");
      expect(conv.messages[4].content).toBe("on it");
    } finally {
      await unlink(tmp);
    }
  });

  it("reads JSONL format", async () => {
    const tmp = resolve(fixturesDir, "_test_jsonl.json");
    const lines = [
      JSON.stringify({
        id: "jsonl-1",
        messages: [{ role: "user", content: "hi" }],
      }),
      JSON.stringify({
        id: "jsonl-2",
        messages: [{ role: "user", content: "bye" }],
      }),
    ];
    await writeFile(tmp, lines.join("\n"));

    try {
      const convs = await readJsonTraces(tmp);
      expect(convs).toHaveLength(2);
      expect(convs[0].id).toBe("jsonl-1");
      expect(convs[1].id).toBe("jsonl-2");
    } finally {
      await unlink(tmp);
    }
  });

  it("extracts system prompt from first system message", async () => {
    const tmp = resolve(fixturesDir, "_test_sys.json");
    await writeFile(
      tmp,
      JSON.stringify([
        {
          messages: [
            { role: "system", content: "You are a helper." },
            { role: "user", content: "hi" },
          ],
        },
      ]),
    );

    try {
      const [conv] = await readJsonTraces(tmp);
      expect(conv.systemPrompt).toBe("You are a helper.");
    } finally {
      await unlink(tmp);
    }
  });

  it("extracts system prompt from metadata field", async () => {
    const tmp = resolve(fixturesDir, "_test_sysmeta.json");
    await writeFile(
      tmp,
      JSON.stringify([
        {
          systemPrompt: "I am the system prompt.",
          messages: [{ role: "user", content: "test" }],
        },
      ]),
    );

    try {
      const [conv] = await readJsonTraces(tmp);
      expect(conv.systemPrompt).toBe("I am the system prompt.");
    } finally {
      await unlink(tmp);
    }
  });

  it("generates stable IDs when none provided", async () => {
    const tmp = resolve(fixturesDir, "_test_noid.json");
    await writeFile(
      tmp,
      JSON.stringify([{ messages: [{ role: "user", content: "a" }] }]),
    );

    try {
      const [conv] = await readJsonTraces(tmp);
      expect(conv.id).toBe("conv_1");
    } finally {
      await unlink(tmp);
    }
  });

  it("extracts metadata (model, tokens, duration)", async () => {
    const tmp = resolve(fixturesDir, "_test_meta.json");
    await writeFile(
      tmp,
      JSON.stringify([
        {
          id: "meta-test",
          model: "gpt-4o",
          messages: [{ role: "user", content: "test" }],
          metadata: { totalTokens: 150, duration: 2.5 },
        },
      ]),
    );

    try {
      const [conv] = await readJsonTraces(tmp);
      expect(conv.metadata.model).toBe("gpt-4o");
      expect(conv.metadata.totalTokens).toBe(150);
      expect(conv.metadata.duration).toBe(2.5);
    } finally {
      await unlink(tmp);
    }
  });

  it("throws on empty file", async () => {
    const tmp = resolve(fixturesDir, "_test_empty.json");
    await writeFile(tmp, "[]");

    try {
      await expect(readJsonTraces(tmp)).rejects.toThrow("No conversations");
    } finally {
      await unlink(tmp);
    }
  });
});
