import { describe, it, expect } from "vitest";
import { readOtelTraces, OTEL_SEMCONV_VERSION } from "../../src/ingestion/otel.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, unlink } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../fixtures");
const otelFixture = resolve(fixturesDir, "otel-traces.json");

describe("readOtelTraces", () => {
  it("parses OTLP/JSON fixture into conversations", async () => {
    const convs = await readOtelTraces(otelFixture);

    // Fixture has 2 traces: abc123def456 (2 spans) and xyz789abc012 (1 span)
    expect(convs).toHaveLength(2);

    for (const conv of convs) {
      expect(conv.id).toBeDefined();
      expect(conv.messages.length).toBeGreaterThan(0);
      expect(conv.metadata.source).toBe("otel");
    }
  });

  it("extracts model from gen_ai.request.model attribute", async () => {
    const convs = await readOtelTraces(otelFixture);
    const trace1 = convs.find((c) => c.id === "abc123def456");

    expect(trace1).toBeDefined();
    expect(trace1!.metadata.model).toBe("gpt-4o-mini");
  });

  it("extracts messages from gen_ai events", async () => {
    const convs = await readOtelTraces(otelFixture);
    const trace1 = convs.find((c) => c.id === "abc123def456")!;

    // First trace has system + user prompt (JSON array) and completion
    const userMsg = trace1.messages.find(
      (m) => m.role === "user" && m.content.includes("weather"),
    );
    expect(userMsg).toBeDefined();

    const assistantMsg = trace1.messages.find(
      (m) => m.role === "assistant" && m.content.includes("weather.com"),
    );
    expect(assistantMsg).toBeDefined();
  });

  it("parses JSON array prompt into individual messages", async () => {
    const convs = await readOtelTraces(otelFixture);
    const trace1 = convs.find((c) => c.id === "abc123def456")!;

    // System messages are hoisted to systemPrompt and excluded from messages
    const systemMsg = trace1.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeUndefined();
    expect(trace1.systemPrompt).toBe("You are a helpful assistant.");
    // Only user + assistant messages remain
    expect(trace1.messages.length).toBe(2);
  });

  it("extracts system prompt", async () => {
    const convs = await readOtelTraces(otelFixture);
    const trace1 = convs.find((c) => c.id === "abc123def456")!;

    expect(trace1.systemPrompt).toBe("You are a helpful assistant.");
  });

  it("handles plain-text prompts (non-JSON)", async () => {
    const convs = await readOtelTraces(otelFixture);
    const trace2 = convs.find((c) => c.id === "xyz789abc012")!;

    // Second trace has plain-text prompt "Translate 'hello world' to French"
    const userMsg = trace2.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("hello world");
  });

  it("sums token counts across spans", async () => {
    const convs = await readOtelTraces(otelFixture);
    const trace1 = convs.find((c) => c.id === "abc123def456")!;

    // span001: 150 prompt + 45 completion = 195
    // span002: no tokens
    expect(trace1.metadata.totalTokens).toBe(195);
  });

  it("calculates duration from span time range", async () => {
    const convs = await readOtelTraces(otelFixture);
    const trace1 = convs.find((c) => c.id === "abc123def456")!;

    // Earliest: span001 start 1708430400000000000 (ns)
    // Latest: span001 end 1708430402000000000 (ns)
    // Duration: 2 seconds
    expect(trace1.metadata.duration).toBe(2);
  });

  it("sets timestamp from earliest span", async () => {
    const convs = await readOtelTraces(otelFixture);
    const trace1 = convs.find((c) => c.id === "abc123def456")!;

    // 1708430400000000000 nanoseconds → 2024-02-20T12:00:00.000Z
    const ts = new Date(trace1.timestamp);
    expect(ts.getFullYear()).toBe(2024);
    expect(ts.getMonth()).toBe(1); // February
    expect(ts.getDate()).toBe(20);
  });

  it("handles intValue as both string and number", async () => {
    // Fixture has intValue: "150" (string) and intValue: 200 (number)
    const convs = await readOtelTraces(otelFixture);
    const trace2 = convs.find((c) => c.id === "xyz789abc012")!;

    // span003: 200 prompt + 80 completion = 280
    expect(trace2.metadata.totalTokens).toBe(280);
  });

  it("throws on empty resourceSpans", async () => {
    const tmp = resolve(fixturesDir, "_test_empty_otel.json");
    await writeFile(tmp, JSON.stringify({ resourceSpans: [] }));

    try {
      await expect(readOtelTraces(tmp)).rejects.toThrow("No OTLP resource spans");
    } finally {
      await unlink(tmp);
    }
  });

  it("exports semconv version", () => {
    expect(OTEL_SEMCONV_VERSION).toBe("1.36.0");
  });
});
