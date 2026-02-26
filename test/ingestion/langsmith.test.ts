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
const { readLangSmithTraces, extractMessagesFromRun, resolveAgentName, hashPrompt, normalizeRole } = await import(
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

// Helper: create a standard sample response that triggers trace-based strategy
// (no session_id in inputs means trace-based detection)
function mockSampleRunsResponse(runs?: unknown[]) {
  const defaultRuns = runs ?? [{
    id: "sample_1",
    name: "ChatOpenAI",
    run_type: "chain",
    trace_id: "t_sample",
    inputs: {},
    outputs: null,
    start_time: "2026-02-20T10:00:00Z",
    end_time: null,
    extra: {},
    parent_run_id: null,
    total_tokens: null,
    status: "success",
  }];
  return new Response(
    JSON.stringify({ runs: defaultRuns, cursors: { next: null } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Helper: create a fixture response (LLM runs with messages for trace-based)
function makeLlmRunsFixture() {
  return {
    runs: [
      {
        id: "run_abc123",
        name: "ChatOpenAI",
        run_type: "llm",
        trace_id: "trace_abc123",
        inputs: {
          messages: [
            { type: "system", content: "You are a helpful assistant." },
            { type: "human", content: "What is the capital of France?" },
          ],
        },
        outputs: {
          choices: [
            { message: { content: "The capital of France is Paris." } },
          ],
        },
        start_time: "2026-02-20T10:00:00Z",
        end_time: "2026-02-20T10:00:02Z",
        status: "success",
        extra: {
          invocation_params: {
            model: "gpt-4o-mini",
            temperature: 0.7,
          },
        },
        parent_run_id: null,
        total_tokens: 45,
      },
      {
        id: "run_def456",
        name: "ChatOpenAI",
        run_type: "llm",
        trace_id: "trace_def456",
        inputs: {
          messages: [
            { role: "system", content: "You are a math tutor." },
            { role: "user", content: "Help me calculate 25 * 17" },
          ],
        },
        outputs: {
          choices: [
            { message: { content: "25 multiplied by 17 equals 425." } },
          ],
        },
        start_time: "2026-02-20T11:00:00Z",
        end_time: "2026-02-20T11:00:05Z",
        status: "success",
        extra: {
          invocation_params: {
            model_name: "gpt-4o",
          },
        },
        parent_run_id: null,
        total_tokens: 120,
      },
    ],
    cursors: { next: null },
  };
}

describe("readLangSmithTraces", () => {
  it("fetches LLM runs and normalizes to conversations (trace-based)", async () => {
    const llmFixture = makeLlmRunsFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      // Strategy detection: sample root runs (no session_id → trace-based)
      .mockResolvedValueOnce(mockSampleRunsResponse())
      // Trace-based: fetch LLM runs
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmFixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // Both runs have system prompts so both should be included
    expect(convs.length).toBe(2);

    for (const conv of convs) {
      expect(conv.id).toBeDefined();
      expect(conv.messages.length).toBeGreaterThan(0);
      expect(conv.metadata.source).toBe("langsmith");
      expect(conv.systemPrompt).toBeDefined();
      expect(conv.metadata.promptHash).toBeDefined();
    }
  });

  it("uses POST /api/v1/runs/query for strategy detection and LLM fetching", async () => {
    const llmFixture = makeLlmRunsFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmFixture), { status: 200 }),
      );

    await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // First call: project resolution
    expect(mockFetch.mock.calls[0][0]).toContain("/api/v1/sessions");
    // Second call: strategy detection (sample root runs)
    const sampleCall = mockFetch.mock.calls[1];
    expect(sampleCall[0]).toContain("/api/v1/runs/query");
    const sampleBody = JSON.parse(sampleCall[1].body);
    expect(sampleBody.is_root).toBe(true);
    expect(sampleBody.limit).toBe(5);
    // Third call: LLM runs fetch
    const llmCall = mockFetch.mock.calls[2];
    expect(llmCall[0]).toContain("/api/v1/runs/query");
    const llmBody = JSON.parse(llmCall[1].body);
    expect(llmBody.run_type).toBe("llm");
  });

  it("passes x-api-key header", async () => {
    const llmFixture = makeLlmRunsFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmFixture), { status: 200 }),
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
    const llmFixture = makeLlmRunsFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmFixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // First run uses type field: {type: "system"}, {type: "human"}
    const conv1 = convs.find((c) => c.id === "run_abc123")!;
    expect(conv1).toBeDefined();
    expect(conv1.systemPrompt).toBe("You are a helpful assistant.");

    const userMsg = conv1.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("What is the capital of France?");

    const assistantMsg = conv1.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("The capital of France is Paris.");
  });

  it("extracts model from invocation_params", async () => {
    const llmFixture = makeLlmRunsFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmFixture), { status: 200 }),
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
    const llmFixture = makeLlmRunsFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmFixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    const conv1 = convs.find((c) => c.id === "run_abc123")!;
    expect(conv1.metadata.duration).toBe(2);

    const conv2 = convs.find((c) => c.id === "run_def456")!;
    expect(conv2.metadata.duration).toBe(5);
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

  it("handles {sessions: [...]} project response format", async () => {
    const llmFixture = makeLlmRunsFixture();

    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessions: [{ id: "proj_999", name: "saleapeak-prod" }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmFixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    expect(convs.length).toBeGreaterThan(0);

    // Verify it used the correct project ID from sessions format
    const sampleCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sampleCall[1].body);
    expect(body.session).toEqual(["proj_999"]);
  });

  it("retries on 429 rate limit", async () => {
    const llmFixture = makeLlmRunsFixture();

    mockFetch
      // Projects endpoint: first 429, then success
      .mockResolvedValueOnce(
        new Response("Rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmFixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    expect(convs.length).toBeGreaterThan(0);
    // fetch called 4 times: 429 + projects success + sample runs + LLM runs
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("composes multi-agent trace into one conversation", async () => {
    // A trace with 3 LLM runs: orchestrator + 2 sub-agents
    const multiAgentFixture = {
      runs: [
        {
          id: "run_orchestrator",
          name: "ChatOpenAI",
          run_type: "llm",
          trace_id: "trace_multi",
          inputs: {
            messages: [
              { role: "system", content: "You are the Orchestrator Agent. Route user requests to the appropriate agent." },
              { role: "user", content: "What is my account balance?" },
            ],
          },
          outputs: {
            choices: [
              { message: { content: "Let me route you to the billing agent." } },
            ],
          },
          start_time: "2026-02-20T10:00:00Z",
          end_time: "2026-02-20T10:00:01Z",
          status: "success",
          extra: { invocation_params: { model: "gpt-4o" } },
          parent_run_id: null,
          total_tokens: 30,
        },
        {
          id: "run_billing",
          name: "ChatOpenAI",
          run_type: "llm",
          trace_id: "trace_multi",
          inputs: {
            messages: [
              { role: "system", content: "You are the Billing Agent. Help users with billing questions." },
              { role: "user", content: "What is my account balance?" },
            ],
          },
          outputs: {
            choices: [
              { message: { content: "Your account balance is $150.00." } },
            ],
          },
          start_time: "2026-02-20T10:00:02Z",
          end_time: "2026-02-20T10:00:03Z",
          status: "success",
          extra: { invocation_params: { model: "gpt-4o" } },
          parent_run_id: "chain_billing",
          total_tokens: 40,
        },
        {
          id: "run_summarizer",
          name: "ChatOpenAI",
          run_type: "llm",
          trace_id: "trace_multi",
          inputs: {
            messages: [
              { role: "system", content: "You are the Summary Agent. Summarize results for the user." },
              { role: "user", content: "Summarize: account balance is $150.00" },
            ],
          },
          outputs: {
            choices: [
              { message: { content: "Your current balance is $150.00. Is there anything else?" } },
            ],
          },
          start_time: "2026-02-20T10:00:04Z",
          end_time: "2026-02-20T10:00:05Z",
          status: "success",
          extra: { invocation_params: { model: "gpt-4o" } },
          parent_run_id: "chain_summary",
          total_tokens: 35,
        },
      ],
      cursors: { next: null },
    };

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(multiAgentFixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // Should produce ONE conversation for the trace, not 3
    expect(convs.length).toBe(1);
    const conv = convs[0];

    // Primary agent should be the orchestrator (first with system prompt)
    expect(conv.metadata.agentName).toBe("Orchestrator Agent");
    expect(conv.systemPrompt).toContain("Orchestrator Agent");
    expect(conv.metadata.traceId).toBe("trace_multi");

    // Should have sub-agents in metadata
    expect(conv.metadata.subAgents).toBeDefined();
    expect(conv.metadata.subAgents!.length).toBe(2);
    const subNames = conv.metadata.subAgents!.map((s) => s.name);
    expect(subNames).toContain("Billing Agent");
    expect(subNames).toContain("Summary Agent");

    // User message should be deduplicated (all 3 runs had similar user input)
    const userMessages = conv.messages.filter((m) => m.role === "user");
    expect(userMessages.length).toBeLessThanOrEqual(2); // original + summarizer's different input

    // Assistant messages should be tagged with agent names
    const assistantMessages = conv.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(3);
    expect(assistantMessages[0].agent).toBe("Orchestrator Agent");
    expect(assistantMessages[1].agent).toBe("Billing Agent");
    expect(assistantMessages[2].agent).toBe("Summary Agent");

    // Total tokens should be summed
    expect(conv.metadata.totalTokens).toBe(105);

    // Duration should span from first run start to last run end
    expect(conv.metadata.duration).toBe(5);
  });

  it("keeps single-run traces as individual conversations", async () => {
    // Two separate traces, each with one LLM run — unchanged behavior
    const llmFixture = makeLlmRunsFixture();

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(llmFixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    expect(convs.length).toBe(2);
    // Each should have its own agent/prompt
    expect(convs[0].id).toBe("run_abc123");
    expect(convs[1].id).toBe("run_def456");
    // No subAgents for single-run traces
    expect(convs[0].metadata.subAgents).toBeUndefined();
    expect(convs[1].metadata.subAgents).toBeUndefined();
  });

  it("handles multi-agent trace where sub-agents lack system prompts", async () => {
    // Orchestrator has system prompt, sub-agent does not
    const fixture = {
      runs: [
        {
          id: "run_orch",
          name: "ChatOpenAI",
          run_type: "llm",
          trace_id: "trace_partial",
          inputs: {
            messages: [
              { role: "system", content: "You are the Router. Route requests." },
              { role: "user", content: "Help me" },
            ],
          },
          outputs: {
            choices: [{ message: { content: "Routing to helper." } }],
          },
          start_time: "2026-02-20T10:00:00Z",
          end_time: "2026-02-20T10:00:01Z",
          status: "success",
          extra: {},
          parent_run_id: null,
          total_tokens: 20,
        },
        {
          id: "run_helper",
          name: "HelperBot",
          run_type: "llm",
          trace_id: "trace_partial",
          inputs: {
            messages: [
              { role: "user", content: "Help me" },
            ],
          },
          outputs: {
            choices: [{ message: { content: "Here's how I can help." } }],
          },
          start_time: "2026-02-20T10:00:02Z",
          end_time: "2026-02-20T10:00:03Z",
          status: "success",
          extra: {},
          parent_run_id: "chain_helper",
          total_tokens: 15,
        },
      ],
      cursors: { next: null },
    };

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      .mockResolvedValueOnce(mockSampleRunsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    // Should still produce one conversation
    expect(convs.length).toBe(1);
    const conv = convs[0];

    // Primary agent is the orchestrator
    expect(conv.metadata.agentName).toBe("Router");

    // Sub-agent without system prompt should still contribute messages
    const assistantMessages = conv.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(2);
    // Sub-agent uses run name since no system prompt
    expect(assistantMessages[1].agent).toBe("HelperBot");

    // No subAgents metadata since helper had no system prompt
    expect(conv.metadata.subAgents).toBeUndefined();
  });

  it("detects session-based strategy when inputs have session_id", async () => {
    const sessionRuns = [{
      id: "root_1",
      name: "AgentChain",
      run_type: "chain",
      trace_id: "t_1",
      inputs: { session_id: "sess_abc", message: "Hello" },
      outputs: null,
      start_time: "2026-02-20T10:00:00Z",
      end_time: "2026-02-20T10:00:01Z",
      extra: {},
      parent_run_id: null,
      total_tokens: null,
      status: "success",
    }];

    // Session-based: after detection, fetches root runs, then child LLM runs per trace
    const rootRunsResponse = {
      runs: [{
        id: "root_1",
        name: "AgentChain",
        run_type: "chain",
        trace_id: "t_1",
        inputs: { session_id: "sess_abc", message: "Hello there" },
        outputs: { output: "Hi! How can I help?" },
        start_time: "2026-02-20T10:00:00Z",
        end_time: "2026-02-20T10:00:01Z",
        extra: {},
        parent_run_id: null,
        total_tokens: null,
        status: "success",
      }],
      cursors: { next: null },
    };

    const childLlmResponse = {
      runs: [{
        id: "llm_child_1",
        name: "ChatOpenAI",
        run_type: "llm",
        trace_id: "t_1",
        inputs: {
          messages: [
            { role: "system", content: "You are a helpful bot." },
            { role: "user", content: "Hello there" },
          ],
        },
        outputs: {
          choices: [{ message: { content: "Hi! How can I help?" } }],
        },
        start_time: "2026-02-20T10:00:00Z",
        end_time: "2026-02-20T10:00:01Z",
        extra: { invocation_params: { model: "gpt-4o-mini" } },
        parent_run_id: "root_1",
        total_tokens: 50,
        status: "success",
      }],
      cursors: { next: null },
    };

    mockFetch
      .mockResolvedValueOnce(mockProjectsResponse())
      // Strategy detection: returns runs with session_id
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ runs: sessionRuns, cursors: { next: null } }),
        { status: 200 },
      ))
      // Session-based: fetch root runs
      .mockResolvedValueOnce(new Response(
        JSON.stringify(rootRunsResponse),
        { status: 200 },
      ))
      // Fetch child LLM runs for trace
      .mockResolvedValueOnce(new Response(
        JSON.stringify(childLlmResponse),
        { status: 200 },
      ));

    const convs = await readLangSmithTraces({
      apiKey: "test-key",
      project: "saleapeak-prod",
    });

    expect(convs.length).toBe(1);
    expect(convs[0].id).toBe("sess_abc");
    expect(convs[0].metadata.sessionId).toBe("sess_abc");
    expect(convs[0].systemPrompt).toBe("You are a helpful bot.");
    expect(convs[0].metadata.agentName).toBeDefined();

    // Should have user + assistant messages
    const userMsg = convs[0].messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("Hello there");

    const assistantMsg = convs[0].messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
  });
});

describe("extractMessagesFromRun", () => {
  it("handles OpenAI format (role-based messages)", () => {
    const run = {
      id: "r1",
      name: "ChatOpenAI",
      run_type: "llm",
      trace_id: "t1",
      inputs: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hi" },
        ],
      },
      outputs: {
        choices: [{ message: { content: "Hello!" } }],
      },
      start_time: "2026-01-01T00:00:00Z",
      end_time: null,
      extra: {},
      parent_run_id: null,
      total_tokens: null,
      status: "success",
    };

    const result = extractMessagesFromRun(run);
    expect(result.systemPrompt).toBe("You are helpful.");
    expect(result.messages).toHaveLength(2); // user + assistant
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
  });

  it("handles Anthropic format (inputs.system string)", () => {
    const run = {
      id: "r2",
      name: "ChatAnthropic",
      run_type: "llm",
      trace_id: "t2",
      inputs: {
        system: "You are Claude.",
        messages: [
          { role: "user", content: "What can you do?" },
        ],
      },
      outputs: {
        content: [{ type: "text", text: "I can help with many things!" }],
      },
      start_time: "2026-01-01T00:00:00Z",
      end_time: null,
      extra: {},
      parent_run_id: null,
      total_tokens: null,
      status: "success",
    };

    const result = extractMessagesFromRun(run);
    expect(result.systemPrompt).toBe("You are Claude.");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toBe("I can help with many things!");
  });

  it("handles LangChain format (type-based messages)", () => {
    const run = {
      id: "r3",
      name: "ChatOpenAI",
      run_type: "llm",
      trace_id: "t3",
      inputs: {
        messages: [
          { type: "SystemMessage", content: "System prompt here." },
          { type: "HumanMessage", content: "User question" },
        ],
      },
      outputs: {
        messages: [{ type: "AIMessage", content: "Answer here." }],
      },
      start_time: "2026-01-01T00:00:00Z",
      end_time: null,
      extra: {},
      parent_run_id: null,
      total_tokens: null,
      status: "success",
    };

    const result = extractMessagesFromRun(run);
    expect(result.systemPrompt).toBe("System prompt here.");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
  });

  it("handles LangChain generations output format", () => {
    const run = {
      id: "r4",
      name: "ChatOpenAI",
      run_type: "llm",
      trace_id: "t4",
      inputs: {
        messages: [
          { role: "system", content: "Be helpful." },
          { role: "user", content: "Help" },
        ],
      },
      outputs: {
        generations: [[{ text: "Here to help!" }]],
      },
      start_time: "2026-01-01T00:00:00Z",
      end_time: null,
      extra: {},
      parent_run_id: null,
      total_tokens: null,
      status: "success",
    };

    const result = extractMessagesFromRun(run);
    expect(result.systemPrompt).toBe("Be helpful.");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].content).toBe("Here to help!");
  });

  it("handles legacy string input format", () => {
    const run = {
      id: "r5",
      name: "LLMChain",
      run_type: "llm",
      trace_id: "t5",
      inputs: {
        input: "What is 2+2?",
      },
      outputs: {
        output: "4",
      },
      start_time: "2026-01-01T00:00:00Z",
      end_time: null,
      extra: {},
      parent_run_id: null,
      total_tokens: null,
      status: "success",
    };

    const result = extractMessagesFromRun(run);
    expect(result.systemPrompt).toBeUndefined();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("What is 2+2?");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toBe("4");
  });
});

describe("resolveAgentName", () => {
  it("extracts name from 'You are the X' pattern", () => {
    const run = {
      id: "r1", name: "ChatOpenAI", run_type: "llm", trace_id: "t1",
      inputs: {}, outputs: null, start_time: "", end_time: null,
      extra: {}, parent_run_id: null, total_tokens: null, status: "success",
    };
    const name = resolveAgentName(run, "You are the Billing Support Agent. Help customers.");
    expect(name).toBe("Billing Support Agent");
  });

  it("extracts name from 'You are a X' pattern", () => {
    const run = {
      id: "r2", name: "ChatOpenAI", run_type: "llm", trace_id: "t2",
      inputs: {}, outputs: null, start_time: "", end_time: null,
      extra: {}, parent_run_id: null, total_tokens: null, status: "success",
    };
    const name = resolveAgentName(run, "You are a Sales Assistant. Your job is to help.");
    expect(name).toBe("Sales Assistant");
  });

  it("falls back to run name for generic names", () => {
    const run = {
      id: "r3", name: "ChatOpenAI", run_type: "llm", trace_id: "t3",
      inputs: {}, outputs: null, start_time: "", end_time: null,
      extra: {}, parent_run_id: null, total_tokens: null, status: "success",
    };
    const name = resolveAgentName(run, "Answer the user's questions.");
    expect(name).toBe("ChatOpenAI");
  });

  it("extracts name from markdown heading", () => {
    const run = {
      id: "r4", name: "ChatOpenAI", run_type: "llm", trace_id: "t4",
      inputs: {}, outputs: null, start_time: "", end_time: null,
      extra: {}, parent_run_id: null, total_tokens: null, status: "success",
    };
    const name = resolveAgentName(run, "# Beelo AI Guide\n\nYou help users navigate the website.");
    expect(name).toBe("Beelo AI Guide");
  });
});

describe("hashPrompt", () => {
  it("produces consistent hashes for same content", () => {
    const h1 = hashPrompt("You are a helpful assistant.");
    const h2 = hashPrompt("You are a helpful assistant.");
    expect(h1).toBe(h2);
  });

  it("normalizes whitespace differences", () => {
    const h1 = hashPrompt("You are   a helpful\n\nassistant.");
    const h2 = hashPrompt("You are a helpful assistant.");
    expect(h1).toBe(h2);
  });

  it("is case-insensitive", () => {
    const h1 = hashPrompt("You Are A Helpful Assistant.");
    const h2 = hashPrompt("you are a helpful assistant.");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different prompts", () => {
    const h1 = hashPrompt("You are a helpful assistant.");
    const h2 = hashPrompt("You are a billing agent.");
    expect(h1).not.toBe(h2);
  });
});

describe("normalizeRole", () => {
  it("maps LangChain types to standard roles", () => {
    expect(normalizeRole("human")).toBe("user");
    expect(normalizeRole("HumanMessage")).toBe("user");
    expect(normalizeRole("ai")).toBe("assistant");
    expect(normalizeRole("AIMessage")).toBe("assistant");
    expect(normalizeRole("system")).toBe("system");
    expect(normalizeRole("SystemMessage")).toBe("system");
    expect(normalizeRole("tool")).toBe("tool");
    expect(normalizeRole("ToolMessage")).toBe("tool");
    expect(normalizeRole("function")).toBe("tool");
  });

  it("maps standard OpenAI roles", () => {
    expect(normalizeRole("user")).toBe("user");
    expect(normalizeRole("assistant")).toBe("assistant");
    expect(normalizeRole("system")).toBe("system");
  });

  it("defaults unknown to user", () => {
    expect(normalizeRole("unknown")).toBe("user");
  });
});
