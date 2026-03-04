import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readLangfuseTraces } from "../../src/ingestion/langfuse.js";
import type { LangfuseConfig } from "../../src/ingestion/langfuse.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTrace(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "trace-001",
    name: "test-trace",
    timestamp: "2024-03-01T10:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function makeGeneration(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gen-001",
    traceId: "trace-001",
    type: "GENERATION",
    name: "chat",
    startTime: "2024-03-01T10:00:00.000Z",
    endTime: "2024-03-01T10:00:01.000Z",
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is the weather?" },
    ],
    output: "The weather is sunny today.",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    usage: {
      input: 100,
      output: 50,
      total: 150,
    },
    ...overrides,
  };
}

function makeTracesResponse(traces: unknown[], totalPages = 1, page = 1) {
  return {
    data: traces,
    meta: { totalPages, page, totalItems: traces.length },
  };
}

function makeObservationsResponse(observations: unknown[], totalPages = 1, page = 1) {
  return {
    data: observations,
    meta: { totalItems: observations.length, page, totalPages },
  };
}

function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let callIndex = 0;
  return vi.fn(async (url: string) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: resp.status === 200 ? "OK" : "Error",
      headers: {
        get: (key: string) => resp.headers?.[key.toLowerCase()] ?? null,
      },
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as unknown as Response;
  });
}

const defaultConfig: LangfuseConfig = {
  publicKey: "pk-test",
  secretKey: "sk-test",
};

// ─── Tests ───────────────────────────────────────────────────────────

describe("readLangfuseTraces", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches traces and generations, normalizes correctly", async () => {
    const trace = makeTrace();
    const gen = makeGeneration();

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([trace]) },
      { status: 200, body: makeObservationsResponse([gen]) },
    ]);

    const convs = await readLangfuseTraces(defaultConfig);

    expect(convs).toHaveLength(1);
    expect(convs[0].id).toBe("trace-001");
    expect(convs[0].metadata.source).toBe("langfuse");
    expect(convs[0].metadata.model).toBe("gpt-4o-mini");
    expect(convs[0].metadata.totalTokens).toBe(150);
  });

  it("sends Basic auth header with base64-encoded credentials", async () => {
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([]) },
    ]);

    await readLangfuseTraces(defaultConfig);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;

    const expected = Buffer.from("pk-test:sk-test").toString("base64");
    expect(headers.Authorization).toBe(`Basic ${expected}`);
  });

  it("uses custom host when provided", async () => {
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([]) },
    ]);

    await readLangfuseTraces({
      ...defaultConfig,
      host: "https://langfuse.example.com",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("https://langfuse.example.com");
  });

  it("paginates traces across multiple pages", async () => {
    const trace1 = makeTrace({ id: "trace-001" });
    const trace2 = makeTrace({ id: "trace-002" });
    const gen1 = makeGeneration({ traceId: "trace-001" });
    const gen2 = makeGeneration({
      id: "gen-002",
      traceId: "trace-002",
      input: [{ role: "user", content: "Hello" }],
      output: "Hi there!",
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([trace1], 2, 1) },
      { status: 200, body: makeTracesResponse([trace2], 2, 2) },
      { status: 200, body: makeObservationsResponse([gen1]) },
      { status: 200, body: makeObservationsResponse([gen2]) },
    ]);

    const convs = await readLangfuseTraces(defaultConfig);

    expect(convs).toHaveLength(2);
  });

  it("paginates observations across multiple pages", async () => {
    const trace = makeTrace();
    const gen1 = makeGeneration({ id: "gen-001" });
    const gen2 = makeGeneration({
      id: "gen-002",
      startTime: "2024-03-01T10:00:02.000Z",
      input: [{ role: "user", content: "Follow up" }],
      output: "Follow up answer",
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([trace]) },
      { status: 200, body: makeObservationsResponse([gen1], 2, 1) },
      { status: 200, body: makeObservationsResponse([gen2], 2, 2) },
    ]);

    const convs = await readLangfuseTraces(defaultConfig);

    expect(convs).toHaveLength(1);
    expect(convs[0].messages.length).toBeGreaterThan(2);
  });

  it("skips traces with no generations", async () => {
    const trace1 = makeTrace({ id: "trace-001" });
    const trace2 = makeTrace({ id: "trace-002" });
    const gen2 = makeGeneration({ traceId: "trace-002" });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([trace1, trace2]) },
      { status: 200, body: makeObservationsResponse([]) },       // no generations for trace-001
      { status: 200, body: makeObservationsResponse([gen2]) },   // generations for trace-002
    ]);

    const convs = await readLangfuseTraces(defaultConfig);

    expect(convs).toHaveLength(1);
    expect(convs[0].id).toBe("trace-002");
  });

  it("extracts system prompt, model, tokens, and duration", async () => {
    const trace = makeTrace();
    const gen = makeGeneration({
      startTime: "2024-03-01T10:00:00.000Z",
      endTime: "2024-03-01T10:00:02.500Z",
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([trace]) },
      { status: 200, body: makeObservationsResponse([gen]) },
    ]);

    const convs = await readLangfuseTraces(defaultConfig);
    const conv = convs[0];

    expect(conv.systemPrompt).toBe("You are a helpful assistant.");
    expect(conv.metadata.model).toBe("gpt-4o-mini");
    expect(conv.metadata.totalTokens).toBe(150);
    expect(conv.metadata.duration).toBeGreaterThan(0);
    expect(conv.metadata.promptHash).toBeDefined();
  });

  it("throws clear error on 401", async () => {
    globalThis.fetch = mockFetch([
      { status: 401, body: { error: "unauthorized" } },
    ]);

    await expect(
      readLangfuseTraces(defaultConfig),
    ).rejects.toThrow("Invalid Langfuse credentials");
  });

  it("handles string input (non-array)", async () => {
    const trace = makeTrace();
    const gen = makeGeneration({
      input: "What is 2+2?",
      output: "4",
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([trace]) },
      { status: 200, body: makeObservationsResponse([gen]) },
    ]);

    const convs = await readLangfuseTraces(defaultConfig);

    expect(convs).toHaveLength(1);
    const userMsg = convs[0].messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("What is 2+2?");
    expect(convs[0].systemPrompt).toBeUndefined();
  });

  it("passes time filters as query parameters", async () => {
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([]) },
    ]);

    await readLangfuseTraces({
      ...defaultConfig,
      startTime: "2024-03-01T00:00:00Z",
      endTime: "2024-03-02T00:00:00Z",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain("fromTimestamp=2024-03-01T00%3A00%3A00Z");
    expect(url).toContain("toTimestamp=2024-03-02T00%3A00%3A00Z");
  });

  it("handles object output with content field", async () => {
    const trace = makeTrace();
    const gen = makeGeneration({
      output: { content: "Response from object" },
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTracesResponse([trace]) },
      { status: 200, body: makeObservationsResponse([gen]) },
    ]);

    const convs = await readLangfuseTraces(defaultConfig);

    const assistantMsg = convs[0].messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toBe("Response from object");
  });

  it("retries on 429 rate limit", async () => {
    const trace = makeTrace();
    const gen = makeGeneration();

    globalThis.fetch = mockFetch([
      { status: 429, body: {}, headers: { "retry-after": "0" } },
      { status: 200, body: makeTracesResponse([trace]) },
      { status: 200, body: makeObservationsResponse([gen]) },
    ]);

    vi.spyOn(console, "warn").mockImplementation(() => {});

    const convs = await readLangfuseTraces(defaultConfig);

    expect(convs).toHaveLength(1);
  });
});
