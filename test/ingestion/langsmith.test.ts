import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../fixtures");

// Load fixture
async function loadFixture() {
  const raw = await readFile(
    resolve(fixturesDir, "langsmith-runs-response.json"),
    "utf-8",
  );
  return JSON.parse(raw);
}

// Mock global fetch before importing the module
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocking
const { readLangSmithTraces } = await import(
  "../../src/ingestion/langsmith.js"
);

beforeEach(() => {
  mockFetch.mockReset();
});

function mockProjectsResponse(projectName = "saleapeak-prod") {
  return new Response(
    JSON.stringify([{ id: "proj_123", name: projectName }]),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("readLangSmithTraces", () => {
  it("fetches runs and normalizes to conversations", async () => {
    const fixture = await loadFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // 3 runs in fixture, but run_ghi789 has null outputs and only user message
    expect(convs.length).toBeGreaterThanOrEqual(2);

    for (const conv of convs) {
      expect(conv.id).toBeDefined();
      expect(conv.messages.length).toBeGreaterThan(0);
      expect(conv.metadata.source).toBe("langsmith");
    }
  });

  it("uses POST /api/v1/runs/query with correct body", async () => {
    const fixture = await loadFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // Second call is the runs query
    const runsCall = mockFetch.mock.calls[1];
    expect(runsCall[0]).toContain("/api/v1/runs/query");
    expect(runsCall[1].method).toBe("POST");

    const body = JSON.parse(runsCall[1].body);
    expect(body.session).toEqual(["proj_123"]);
    expect(body.is_root).toBe(true);
    expect(body.limit).toBeDefined();
  });

  it("passes x-api-key header", async () => {
    const fixture = await loadFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    await readLangSmithTraces({
      apiKey: "my-secret-key",
      project: "saleapeak-prod",
    });

    for (const call of mockFetch.mock.calls) {
      expect(call[1].headers["x-api-key"]).toBe("my-secret-key");
    }
  });

  it("normalizes messages format (type→role mapping)", async () => {
    const fixture = await loadFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // First run: inputs.messages has {type: "system"} and {type: "human"}
    const conv1 = convs.find((c) => c.id === "run_abc123")!;
    expect(conv1).toBeDefined();

    const systemMsg = conv1.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toBe("You are a helpful assistant.");

    const userMsg = conv1.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("What is the capital of France?");

    const assistantMsg = conv1.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("The capital of France is Paris.");
  });

  it("handles string input/output format", async () => {
    const fixture = await loadFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // Second run: inputs.input is string, outputs.output is string
    const conv2 = convs.find((c) => c.id === "run_def456")!;
    expect(conv2).toBeDefined();

    const userMsg = conv2.messages.find((m) => m.role === "user");
    expect(userMsg!.content).toBe("Help me calculate 25 * 17");

    const assistantMsg = conv2.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.content).toBe("25 multiplied by 17 equals 425.");
  });

  it("extracts model from invocation_params", async () => {
    const fixture = await loadFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    const conv1 = convs.find((c) => c.id === "run_abc123")!;
    expect(conv1.metadata.model).toBe("gpt-4o-mini");

    const conv2 = convs.find((c) => c.id === "run_def456")!;
    expect(conv2.metadata.model).toBe("gpt-4o");
  });

  it("extracts duration from start_time/end_time", async () => {
    const fixture = await loadFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    const conv1 = convs.find((c) => c.id === "run_abc123")!;
    expect(conv1.metadata.duration).toBe(2); // 2 seconds

    const conv2 = convs.find((c) => c.id === "run_def456")!;
    expect(conv2.metadata.duration).toBe(5); // 5 seconds
  });

  it("handles runs with null outputs", async () => {
    const fixture = await loadFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // Third run has null outputs — should still parse (user message from role field)
    const conv3 = convs.find((c) => c.id === "run_ghi789");
    if (conv3) {
      // It might be included with just user messages, or filtered out
      expect(conv3.messages.length).toBeGreaterThan(0);
    }
  });

  it("throws on invalid API key (401)", async () => {
    mockFetch.mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      readLangSmithTraces({
        apiKey: "bad-key",
        project: "saleapeak-prod",
      }),
    ).rejects.toThrow("Invalid LangSmith API key");
  });

  it("throws when project not found", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: "p1", name: "other-project" }]), {
        status: 200,
      }),
    );

    await expect(
      readLangSmithTraces({
        apiKey: "test-key",
        project: "nonexistent",
      }),
    ).rejects.toThrow('project "nonexistent" not found');
  });

  it("handles cursor-based pagination", async () => {
    const page1 = {
      runs: [
        {
          id: "run_page1",
          name: "ChatOpenAI",
          run_type: "chain",
          trace_id: "t1",
          inputs: {
            messages: [{ type: "human", content: "page 1" }],
          },
          outputs: {
            messages: [{ type: "ai", content: "response 1" }],
          },
          start_time: "2026-02-20T10:00:00Z",
          end_time: "2026-02-20T10:00:01Z",
          extra: {},
          parent_run_id: null,
          total_tokens: 50,
          status: "success",
        },
      ],
      cursors: { next: "cursor_abc" },
    };

    const page2 = {
      runs: [
        {
          id: "run_page2",
          name: "ChatOpenAI",
          run_type: "chain",
          trace_id: "t2",
          inputs: {
            messages: [{ type: "human", content: "page 2" }],
          },
          outputs: {
            messages: [{ type: "ai", content: "response 2" }],
          },
          start_time: "2026-02-20T11:00:00Z",
          end_time: "2026-02-20T11:00:01Z",
          extra: {},
          parent_run_id: null,
          total_tokens: 60,
          status: "success",
        },
      ],
      cursors: { next: null },
    };

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page1), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page2), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    expect(convs).toHaveLength(2);
    expect(convs[0].id).toBe("run_page1");
    expect(convs[1].id).toBe("run_page2");

    // Verify second query included cursor
    const secondRunsCall = mockFetch.mock.calls[2];
    const body = JSON.parse(secondRunsCall[1].body);
    expect(body.cursor).toBe("cursor_abc");
  });

  it("handles {sessions: [...]} project response format", async () => {
    const fixture = await loadFixture();

    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessions: [{ id: "proj_999", name: "saleapeak-prod" }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    expect(convs.length).toBeGreaterThan(0);

    // Verify it used the correct project ID from sessions format
    const runsCall = mockFetch.mock.calls[1];
    const body = JSON.parse(runsCall[1].body);
    expect(body.session).toEqual(["proj_999"]);
  });

  it("retries on 429 rate limit", async () => {
    const fixture = await loadFixture();

    mockFetch
      // Projects endpoint: first 429, then success
      .mockResolvedValueOnce(
        new Response("Rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    expect(convs.length).toBeGreaterThan(0);
    // fetch called 3 times: 429 + projects success + runs
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
