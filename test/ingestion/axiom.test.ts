import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readAxiomTraces, buildAplQuery, parseTabularResponse } from "../../src/ingestion/axiom.js";
import type { AxiomConfig } from "../../src/ingestion/axiom.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTabularResponse(rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    return { tables: [{ fields: [], columns: [] }], status: {} };
  }

  const fieldNames = Object.keys(rows[0]);
  const fields = fieldNames.map((name) => ({ name, type: "string" }));
  const columns = fieldNames.map((name) => rows.map((r) => r[name]));

  return {
    tables: [{ fields, columns }],
    status: { rowsMatched: rows.length },
  };
}

/** Span row using flattened dotted columns (how Axiom returns real data) */
function makeSpanRow(overrides: Record<string, unknown> = {}) {
  return {
    trace_id: "trace-001",
    span_id: "span-001",
    parent_span_id: undefined,
    name: "gen_ai.anthropic.completion",
    kind: "internal",
    duration: "1.500s",
    _time: "2024-03-01T10:00:00.000Z",
    "attributes.gen_ai.provider.name": "anthropic",
    "attributes.gen_ai.request.model": "claude-sonnet-4-6",
    "attributes.gen_ai.usage.input_tokens": 100,
    "attributes.gen_ai.usage.output_tokens": 50,
    "attributes.gen_ai.input.messages": [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is the weather?" },
    ],
    "attributes.gen_ai.output.messages": [
      { role: "assistant", content: "The weather is sunny today." },
    ],
    events: null,
    ...overrides,
  };
}

/** Span row using events (older semconv format) */
function makeEventsSpanRow(overrides: Record<string, unknown> = {}) {
  return {
    trace_id: "trace-001",
    span_id: "span-001",
    name: "chat",
    kind: "internal",
    duration: "1.500s",
    _time: "2024-03-01T10:00:00.000Z",
    "attributes.gen_ai.system": "openai",
    "attributes.gen_ai.request.model": "gpt-4o-mini",
    "attributes.gen_ai.usage.prompt_tokens": 100,
    "attributes.gen_ai.usage.completion_tokens": 50,
    "attributes.gen_ai.input.messages": null,
    "attributes.gen_ai.output.messages": null,
    events: [
      {
        name: "gen_ai.content.prompt",
        attributes: {
          "gen_ai.prompt": JSON.stringify([
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "What is the weather?" },
          ]),
        },
      },
      {
        name: "gen_ai.content.completion",
        attributes: {
          "gen_ai.completion": "The weather is sunny today.",
        },
      },
    ],
    ...overrides,
  };
}

function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let callIndex = 0;
  return vi.fn(async () => {
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

// ─── Tests ───────────────────────────────────────────────────────────

describe("readAxiomTraces", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses single-trace tabular response into conversation", async () => {
    const span = makeSpanRow();
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs).toHaveLength(1);
    expect(convs[0].id).toBe("span-001");
    expect(convs[0].metadata.source).toBe("axiom");
    expect(convs[0].metadata.traceId).toBe("trace-001");
  });

  it("extracts model from flattened attributes", async () => {
    const span = makeSpanRow();
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs[0].metadata.model).toBe("claude-sonnet-4-6");
  });

  it("extracts system prompt from input messages", async () => {
    const span = makeSpanRow();
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs[0].systemPrompt).toBe("You are a helpful assistant.");
  });

  it("extracts messages from gen_ai.input/output.messages", async () => {
    const span = makeSpanRow();
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    const msgs = convs[0].messages;
    expect(msgs.find((m) => m.role === "system")).toBeDefined();
    expect(msgs.find((m) => m.role === "user")?.content).toBe("What is the weather?");
    expect(msgs.find((m) => m.role === "assistant")?.content).toBe("The weather is sunny today.");
  });

  it("extracts messages from events (older semconv)", async () => {
    const span = makeEventsSpanRow();
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    const msgs = convs[0].messages;
    expect(msgs.find((m) => m.role === "user")?.content).toBe("What is the weather?");
    expect(msgs.find((m) => m.role === "assistant")?.content).toBe("The weather is sunny today.");
  });

  it("extracts tokens from single span (input_tokens/output_tokens)", async () => {
    const span = makeSpanRow({
      "attributes.gen_ai.usage.input_tokens": 100,
      "attributes.gen_ai.usage.output_tokens": 50,
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs[0].metadata.totalTokens).toBe(150); // 100+50
  });

  it("sums tokens using prompt_tokens/completion_tokens fallback", async () => {
    const span = makeEventsSpanRow({
      "attributes.gen_ai.usage.prompt_tokens": 100,
      "attributes.gen_ai.usage.completion_tokens": 50,
      "attributes.gen_ai.usage.input_tokens": null,
      "attributes.gen_ai.usage.output_tokens": null,
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs[0].metadata.totalTokens).toBe(150);
  });

  it("treats each span as its own conversation (no trace grouping)", async () => {
    const span1 = makeSpanRow({ trace_id: "trace-001", span_id: "span-001" });
    const span2 = makeSpanRow({
      trace_id: "trace-001",
      span_id: "span-002",
      _time: "2024-03-01T11:00:00.000Z",
      "attributes.gen_ai.input.messages": [{ role: "user", content: "Hello" }],
      "attributes.gen_ai.output.messages": [{ role: "assistant", content: "Hi there!" }],
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span1, span2]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    // Two spans with same trace_id → two separate conversations
    expect(convs).toHaveLength(2);
    expect(convs[0].id).toBe("span-001");
    expect(convs[1].id).toBe("span-002");
    expect(convs[0].metadata.traceId).toBe("trace-001");
    expect(convs[1].metadata.traceId).toBe("trace-001");
  });

  it("uses spanId-operationName as conversation ID when operation name exists", async () => {
    const span = makeSpanRow({
      span_id: "abcdef123456789",
      "attributes.gen_ai.operation.name": "chat",
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs[0].id).toBe("abcdef123456-chat");
  });

  it("handles plain-text prompts in events", async () => {
    const span = makeEventsSpanRow({
      events: [
        {
          name: "gen_ai.content.prompt",
          attributes: { "gen_ai.prompt": "Translate hello to French" },
        },
        {
          name: "gen_ai.content.completion",
          attributes: { "gen_ai.completion": "Bonjour" },
        },
      ],
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    const userMsg = convs[0].messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("Translate hello to French");
    expect(convs[0].systemPrompt).toBeUndefined();
  });

  it("handles nested attribute format (test compatibility)", async () => {
    const span = makeSpanRow({
      "attributes.gen_ai.request.model": null,
      // Nested format under "attributes" key
      attributes: {
        gen_ai: {
          request: { model: "gpt-4o" },
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      },
    });

    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs[0].metadata.model).toBe("gpt-4o");
  });

  it("parses duration from string format (e.g. '38.037s')", async () => {
    const span = makeSpanRow({ duration: "2.500s" });
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    // Single span, duration is the span duration itself
    expect(convs[0].metadata.duration).toBeCloseTo(2.5, 1);
  });

  it("paginates using cursor", async () => {
    const span1 = makeSpanRow({ trace_id: "trace-001" });
    const span2 = makeSpanRow({
      trace_id: "trace-002",
      span_id: "span-002",
      "attributes.gen_ai.input.messages": [{ role: "user", content: "Page 2" }],
      "attributes.gen_ai.output.messages": [{ role: "assistant", content: "Response 2" }],
    });

    const page1 = {
      ...makeTabularResponse([span1]),
      status: { maxCursor: "cursor-page2", rowsMatched: 1 },
    };
    const page2 = makeTabularResponse([span2]);

    globalThis.fetch = mockFetch([
      { status: 200, body: page1 },
      { status: 200, body: page2 },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs).toHaveLength(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 rate limit", async () => {
    const span = makeSpanRow();

    globalThis.fetch = mockFetch([
      { status: 429, body: {}, headers: { "retry-after": "0" } },
      { status: 200, body: makeTabularResponse([span]) },
    ]);

    vi.spyOn(console, "warn").mockImplementation(() => {});

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("throws on 401 auth error with descriptive message", async () => {
    globalThis.fetch = mockFetch([
      { status: 401, body: { error: "unauthorized" } },
    ]);

    await expect(
      readAxiomTraces({ apiKey: "bad-key", dataset: "test" }),
    ).rejects.toThrow("Invalid Axiom API key");
  });

  it("returns empty array for empty results", async () => {
    globalThis.fetch = mockFetch([
      { status: 200, body: { tables: [{ fields: [], columns: [] }], status: {} } },
    ]);

    const convs = await readAxiomTraces({
      apiKey: "test-key",
      dataset: "test-dataset",
    });

    expect(convs).toEqual([]);
  });

  it("sends correct headers including Authorization and Content-Type", async () => {
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([]) },
    ]);

    await readAxiomTraces({
      apiKey: "xaat-test-token",
      dataset: "my-dataset",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(headers.Authorization).toBe("Bearer xaat-test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends x-axiom-org-id header when orgId is provided", async () => {
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([]) },
    ]);

    await readAxiomTraces({
      apiKey: "test-key",
      dataset: "my-dataset",
      orgId: "my-org",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(headers["x-axiom-org-id"]).toBe("my-org");
  });

  it("does not send x-axiom-org-id when orgId is not provided", async () => {
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([]) },
    ]);

    await readAxiomTraces({
      apiKey: "test-key",
      dataset: "my-dataset",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(headers["x-axiom-org-id"]).toBeUndefined();
  });

  it("includes time filters in APL query", async () => {
    globalThis.fetch = mockFetch([
      { status: 200, body: makeTabularResponse([]) },
    ]);

    await readAxiomTraces({
      apiKey: "test-key",
      dataset: "my-dataset",
      startTime: "2024-03-01T00:00:00Z",
      endTime: "2024-03-02T00:00:00Z",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);

    expect(body.apl).toContain("2024-03-01T00:00:00Z");
    expect(body.apl).toContain("2024-03-02T00:00:00Z");
  });
});

describe("buildAplQuery", () => {
  it("builds basic query with dataset name", () => {
    const apl = buildAplQuery({ apiKey: "", dataset: "my-traces" });
    expect(apl).toContain("['my-traces']");
    expect(apl).toContain("gen_ai.request.model");
    expect(apl).toContain("sort by _time asc");
  });

  it("adds time filters when provided", () => {
    const apl = buildAplQuery({
      apiKey: "",
      dataset: "traces",
      startTime: "2024-01-01T00:00:00Z",
      endTime: "2024-01-02T00:00:00Z",
    });
    expect(apl).toContain('_time >= datetime("2024-01-01T00:00:00Z")');
    expect(apl).toContain('_time <= datetime("2024-01-02T00:00:00Z")');
  });

  it("omits time filters when not provided", () => {
    const apl = buildAplQuery({ apiKey: "", dataset: "traces" });
    expect(apl).not.toContain("datetime");
  });
});

describe("parseTabularResponse", () => {
  it("zips fields and columns into row objects", () => {
    const response = {
      tables: [{
        fields: [
          { name: "trace_id", type: "string" },
          { name: "span_id", type: "string" },
          { name: "_time", type: "datetime" },
        ],
        columns: [
          ["t1", "t1", "t2"],
          ["s1", "s2", "s3"],
          ["2024-01-01", "2024-01-02", "2024-01-03"],
        ],
      }],
      status: {},
    };

    const rows = parseTabularResponse(response);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      trace_id: "t1",
      span_id: "s1",
      _time: "2024-01-01",
    });
  });

  it("returns empty array for empty tables", () => {
    const rows = parseTabularResponse({ tables: [], status: {} });
    expect(rows).toEqual([]);
  });

  it("returns empty array for empty columns", () => {
    const rows = parseTabularResponse({
      tables: [{ fields: [{ name: "a", type: "string" }], columns: [[]] }],
      status: {},
    });
    expect(rows).toEqual([]);
  });
});
