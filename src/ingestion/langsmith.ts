import { createHash } from "node:crypto";
import type { NormalizedConversation, Message } from "./types.js";

const DEFAULT_BASE_URL = "https://api.smith.langchain.com";
const PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 650;
const MAX_RETRIES = 3;
const SAMPLE_SIZE = 5;

// Generic parent run names to skip when resolving agent names
const GENERIC_RUN_NAMES = new Set([
  "chatopenai",
  "chatanthropic",
  "runnablesequence",
  "llmchain",
  "runnableparallel",
  "runnablelambda",
  "runnablewithfallbacks",
  "chatprompttemplate",
  "stroutputparser",
  "conversationchain",
  "agentexecutor",
]);

export interface LangSmithConfig {
  apiKey: string;
  project: string;
  baseUrl?: string;
  limit?: number;
  startTime?: string;  // ISO 8601 — filter traces after this time
  endTime?: string;    // ISO 8601 — filter traces before this time
}

export interface LangSmithRun {
  id: string;
  name: string;
  run_type: string;
  trace_id: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  start_time: string;
  end_time: string | null;
  extra: Record<string, unknown>;
  parent_run_id: string | null;
  total_tokens: number | null;
  status: string;
  tags?: string[];
}

type IngestionStrategy = "trace-based" | "session-based";

interface ExtractedMessages {
  systemPrompt: string | undefined;
  messages: Message[];
}

// ─── Public API ──────────────────────────────────────────────────────

export async function readLangSmithTraces(
  config: LangSmithConfig,
): Promise<NormalizedConversation[]> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const headers = buildHeaders(config.apiKey);

  const projectId = await resolveProjectId(baseUrl, headers, config.project);

  // Detect strategy by sampling 5 root runs
  const strategy = await detectStrategy(baseUrl, headers, projectId);
  console.log(
    `Detected ${strategy} agent architecture`,
  );

  const timeFilters: Record<string, unknown> = {};
  if (config.startTime) timeFilters.start_time = config.startTime;
  if (config.endTime) timeFilters.end_time = config.endTime;

  if (strategy === "session-based") {
    return ingestSessionBased(baseUrl, headers, projectId, config.limit ?? 500, timeFilters);
  }
  return ingestTraceBased(baseUrl, headers, projectId, config.limit ?? 500, timeFilters);
}

// ─── Strategy Detection ──────────────────────────────────────────────

async function detectStrategy(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<IngestionStrategy> {
  const body = {
    session: [projectId],
    is_root: true,
    limit: SAMPLE_SIZE,
  };

  const res = await fetchWithRetry(`${baseUrl}/api/v1/runs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`LangSmith runs API error: ${res.status}`);

  const data = (await res.json()) as { runs?: LangSmithRun[] };
  const runs = data.runs ?? [];

  const withSessionId = runs.filter(
    (r) => r.inputs?.session_id !== undefined,
  );

  if (withSessionId.length > 0) {
    console.log(
      `  (${withSessionId.length}/${runs.length} root runs have session_id)`,
    );
    return "session-based";
  }

  return "trace-based";
}

// ─── Trace-Based Ingestion ───────────────────────────────────────────

async function ingestTraceBased(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  limit: number,
  timeFilters: Record<string, unknown> = {},
): Promise<NormalizedConversation[]> {
  // Fetch LLM runs (not root runs) — these have actual messages
  const llmRuns = await fetchAllRuns(baseUrl, headers, projectId, {
    ...timeFilters,
    run_type: "llm",
  }, limit * 3); // fetch more since we'll filter

  // Group by trace_id
  const traceMap = new Map<string, LangSmithRun[]>();
  for (const run of llmRuns) {
    const traceId = run.trace_id;
    if (!traceMap.has(traceId)) traceMap.set(traceId, []);
    traceMap.get(traceId)!.push(run);
  }

  const conversations: NormalizedConversation[] = [];

  for (const [traceId, runs] of traceMap) {
    if (conversations.length >= limit) break;

    // Sort by start_time within trace
    runs.sort(
      (a, b) =>
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );

    for (const run of runs) {
      if (conversations.length >= limit) break;

      const extracted = extractMessagesFromRun(run);
      // Skip LLM runs without a system prompt (internal routing/classification calls)
      if (!extracted.systemPrompt) continue;
      if (extracted.messages.length === 0) continue;

      const agentName = resolveAgentName(run, extracted.systemPrompt);
      const promptHash = hashPrompt(extracted.systemPrompt);

      conversations.push({
        id: run.id,
        messages: extracted.messages,
        systemPrompt: extracted.systemPrompt,
        metadata: {
          model: extractModel(run),
          totalTokens: run.total_tokens ?? undefined,
          duration: extractDuration(run),
          source: "langsmith",
          agentName,
          promptHash,
          traceId,
        },
        timestamp: run.start_time,
      });
    }
  }

  return conversations;
}

// ─── Session-Based Ingestion ─────────────────────────────────────────

async function ingestSessionBased(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  limit: number,
  timeFilters: Record<string, unknown> = {},
): Promise<NormalizedConversation[]> {
  // Fetch root chain runs
  const rootRuns = await fetchAllRuns(baseUrl, headers, projectId, {
    ...timeFilters,
    is_root: true,
  }, limit * 2);

  // Group by session_id
  const sessionMap = new Map<string, LangSmithRun[]>();
  for (const run of rootRuns) {
    const sessionId = run.inputs?.session_id as string | undefined;
    if (!sessionId) continue;
    if (!sessionMap.has(sessionId)) sessionMap.set(sessionId, []);
    sessionMap.get(sessionId)!.push(run);
  }

  console.log(`Fetching sessions... found ${sessionMap.size} sessions.`);

  const conversations: NormalizedConversation[] = [];

  for (const [sessionId, runs] of sessionMap) {
    if (conversations.length >= limit) break;

    // Sort runs by start_time within session
    runs.sort(
      (a, b) =>
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );

    const allMessages: Message[] = [];
    let systemPrompt: string | undefined;
    let model: string | undefined;
    let totalTokens = 0;
    let agentName: string | undefined;

    for (const rootRun of runs) {
      // Fetch child LLM runs for this trace
      const childRuns = await fetchChildLlmRuns(
        baseUrl,
        headers,
        projectId,
        rootRun.trace_id,
      );

      // Extract system prompt from first child LLM run that has one
      for (const child of childRuns) {
        const extracted = extractMessagesFromRun(child);
        if (extracted.systemPrompt && !systemPrompt) {
          systemPrompt = extracted.systemPrompt;
          agentName = resolveAgentName(child, systemPrompt);
          model = extractModel(child);
        }
        if (child.total_tokens) totalTokens += child.total_tokens;
      }

      // Extract user message from root run inputs
      const userMessage = extractUserMessageFromRoot(rootRun);

      // Extract assistant response from child LLM runs
      const assistantResponse = extractAssistantResponseFromChildren(childRuns);

      // Parse conversation history from root run
      const history = parseHistory(rootRun);

      // If we have history and this is the first run in the session, add history first
      if (allMessages.length === 0 && history.length > 0) {
        allMessages.push(...history);
      }

      if (userMessage) {
        allMessages.push({ role: "user", content: userMessage });
      }
      if (assistantResponse) {
        allMessages.push({ role: "assistant", content: assistantResponse });
      }
    }

    if (allMessages.length === 0) continue;

    const promptHash = systemPrompt ? hashPrompt(systemPrompt) : undefined;

    conversations.push({
      id: sessionId,
      messages: allMessages,
      systemPrompt,
      metadata: {
        model,
        totalTokens: totalTokens || undefined,
        duration: extractSessionDuration(runs),
        source: "langsmith",
        agentName,
        promptHash,
        sessionId,
        traceId: runs[0]?.trace_id,
      },
      timestamp: runs[0]?.start_time ?? new Date().toISOString(),
    });
  }

  return conversations;
}

// ─── Message Extraction (multi-format) ───────────────────────────────

export function extractMessagesFromRun(run: LangSmithRun): ExtractedMessages {
  let systemPrompt: string | undefined;
  const messages: Message[] = [];

  // === INPUT EXTRACTION ===

  // 1. Anthropic format: inputs.system (string)
  if (typeof run.inputs?.system === "string" && run.inputs.system.trim()) {
    systemPrompt = run.inputs.system as string;
  }

  // 2. Check inputs.messages array
  const inputMessages = run.inputs?.messages;
  if (Array.isArray(inputMessages)) {
    for (const msg of inputMessages) {
      if (!msg || typeof msg !== "object") continue;
      const obj = msg as Record<string, unknown>;

      const roleRaw =
        (obj.role as string) ?? (obj.type as string) ?? "";
      const role = normalizeRole(roleRaw);
      const content = extractContent(obj);

      if (!content && !obj.tool_calls) continue;

      if (role === "system") {
        if (!systemPrompt) systemPrompt = content;
        continue; // don't add system to messages array
      }

      messages.push({
        role,
        content,
        ...(obj.tool_calls
          ? {
              toolCalls: (
                obj.tool_calls as Array<{ name: string; args?: unknown; arguments?: unknown }>
              ).map((tc) => ({
                name: tc.name,
                arguments: tc.args ?? tc.arguments,
              })),
            }
          : {}),
      });
    }
  }

  // 3. LangChain legacy: inputs.input or inputs.question (string)
  if (messages.length === 0) {
    const legacyInput =
      (typeof run.inputs?.input === "string" ? run.inputs.input : null) ??
      (typeof run.inputs?.question === "string" ? run.inputs.question : null);
    if (legacyInput) {
      messages.push({ role: "user", content: legacyInput });
    }
  }

  // === OUTPUT EXTRACTION ===
  if (run.outputs) {
    const outputContent = extractOutputContent(run.outputs);
    if (outputContent) {
      messages.push({ role: "assistant", content: outputContent });
    }
  }

  return { systemPrompt, messages };
}

function extractContent(obj: Record<string, unknown>): string {
  // String content
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.text === "string") return obj.text;

  // Anthropic array-of-blocks format: [{type: "text", text: "..."}]
  if (Array.isArray(obj.content)) {
    const texts = (obj.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join("\n");
  }

  return "";
}

function extractOutputContent(outputs: Record<string, unknown>): string | null {
  // Direct string outputs
  if (typeof outputs.output === "string") return outputs.output;
  if (typeof outputs.text === "string") return outputs.text;
  if (typeof outputs.answer === "string") return outputs.answer;
  if (typeof outputs.content === "string") return outputs.content;

  // OpenAI choices format
  const choices = outputs.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices) && choices[0]) {
    const msg = choices[0].message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === "string") return msg.content;
  }

  // LangChain generations format
  const generations = outputs.generations as Array<Array<Record<string, unknown>>> | undefined;
  if (Array.isArray(generations) && generations[0]?.[0]) {
    const gen = generations[0][0];
    if (typeof gen.text === "string") return gen.text;
    const genMsg = gen.message as Record<string, unknown> | undefined;
    if (genMsg && typeof genMsg.content === "string") return genMsg.content;
  }

  // Anthropic array-of-blocks: content: [{type: "text", text: "..."}]
  if (Array.isArray(outputs.content)) {
    const texts = (outputs.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join("\n");
  }

  // Messages array in output
  if (Array.isArray(outputs.messages)) {
    for (const msg of outputs.messages as Array<Record<string, unknown>>) {
      const role = normalizeRole(
        (msg.role as string) ?? (msg.type as string) ?? "",
      );
      if (role === "assistant") {
        const content = extractContent(msg);
        if (content) return content;
      }
    }
    // If no assistant message found, try first message
    const firstMsg = (outputs.messages as Array<Record<string, unknown>>)[0];
    if (firstMsg) {
      const content = extractContent(firstMsg);
      if (content) return content;
    }
  }

  return null;
}

// ─── Session-Based Helpers ───────────────────────────────────────────

function extractUserMessageFromRoot(rootRun: LangSmithRun): string | null {
  // Common pattern: inputs.message (string)
  if (typeof rootRun.inputs?.message === "string") {
    return rootRun.inputs.message as string;
  }
  // Also check inputs.input
  if (typeof rootRun.inputs?.input === "string") {
    return rootRun.inputs.input as string;
  }
  // Also check inputs.question
  if (typeof rootRun.inputs?.question === "string") {
    return rootRun.inputs.question as string;
  }
  return null;
}

function extractAssistantResponseFromChildren(
  childRuns: LangSmithRun[],
): string | null {
  // Try to find the "response generator" LLM run (usually the last one)
  // Search from last to first since the response generator is typically the final LLM call
  for (let i = childRuns.length - 1; i >= 0; i--) {
    const run = childRuns[i];
    if (!run.outputs) continue;

    const outputs = run.outputs;

    // Try specific response fields first
    for (const field of [
      "html_response",
      "response",
      "content",
      "message",
    ]) {
      if (typeof outputs[field] === "string") {
        return outputs[field] as string;
      }
    }

    // Try JSON-parsing the output for response fields
    if (typeof outputs.output === "string") {
      try {
        const parsed = JSON.parse(outputs.output) as Record<string, unknown>;
        if (typeof parsed.html_response === "string") return parsed.html_response;
        if (typeof parsed.message_to_user === "string") return parsed.message_to_user;
        if (typeof parsed.response === "string") return parsed.response;
      } catch {
        // Not JSON — use as-is
        return outputs.output;
      }
    }

    // Standard output extraction
    const content = extractOutputContent(outputs);
    if (content) return content;
  }

  return null;
}

function parseHistory(rootRun: LangSmithRun): Message[] {
  const history = rootRun.inputs?.history;
  if (!history) return [];

  const messages: Message[] = [];

  // String format: "User: ...\nAssistant: ..."
  if (typeof history === "string") {
    const lines = history.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("User:")) {
        messages.push({ role: "user", content: trimmed.slice(5).trim() });
      } else if (trimmed.startsWith("Assistant:")) {
        messages.push({
          role: "assistant",
          content: trimmed.slice(10).trim(),
        });
      }
    }
    return messages;
  }

  // Array format: [{role, content}] or [{type, content}]
  if (Array.isArray(history)) {
    for (const item of history as Array<Record<string, unknown>>) {
      if (!item || typeof item !== "object") continue;
      const role = normalizeRole(
        (item.role as string) ?? (item.type as string) ?? "",
      );
      const content =
        typeof item.content === "string"
          ? item.content
          : typeof item.text === "string"
            ? item.text
            : "";
      if (content) {
        messages.push({ role, content });
      }
    }
    return messages;
  }

  return [];
}

function extractSessionDuration(
  runs: LangSmithRun[],
): number | undefined {
  if (runs.length === 0) return undefined;
  const first = new Date(runs[0].start_time).getTime();
  const lastRun = runs[runs.length - 1];
  const last = lastRun.end_time
    ? new Date(lastRun.end_time).getTime()
    : new Date(lastRun.start_time).getTime();
  const duration = (last - first) / 1000;
  return duration > 0 ? duration : undefined;
}

// ─── Agent Name Resolution ───────────────────────────────────────────

export function resolveAgentName(
  run: LangSmithRun,
  systemPrompt?: string,
): string {
  // 1. Try extracting from system prompt
  if (systemPrompt) {
    const fromPrompt = extractAgentNameFromPrompt(systemPrompt);
    if (fromPrompt) return fromPrompt;
  }

  // 2. Use run name if it's not generic
  if (!GENERIC_RUN_NAMES.has(run.name.toLowerCase())) {
    return run.name;
  }

  return run.name;
}

function extractAgentNameFromPrompt(prompt: string): string | null {
  // "You are the X Agent" or "You are the X"
  const youAreThe = prompt.match(
    /You are the\s+([A-Z][A-Za-z\s]{1,40}?)(?:\.|,|\n|$)/,
  );
  if (youAreThe) return youAreThe[1].trim();

  // "You are an X" / "You are a X"
  const youAreA = prompt.match(
    /You are (?:an?)\s+([A-Z][A-Za-z\s]{1,40}?)(?:\.|,|\n|$)/,
  );
  if (youAreA) return youAreA[1].trim();

  // "As the X:"
  const asThe = prompt.match(/As the\s+([A-Z][A-Za-z\s]{1,40}?):/);
  if (asThe) return asThe[1].trim();

  // First markdown heading
  const heading = prompt.match(/^#\s+(.{2,50})$/m);
  if (heading) return heading[1].trim();

  return null;
}

// ─── Prompt Hashing ──────────────────────────────────────────────────

export function hashPrompt(prompt: string): string {
  // Normalize: collapse whitespace, trim
  const normalized = prompt.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ─── Shared Helpers ──────────────────────────────────────────────────

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

async function resolveProjectId(
  baseUrl: string,
  headers: Record<string, string>,
  projectName: string,
): Promise<string> {
  const projectRes = await fetchWithRetry(
    `${baseUrl}/api/v1/sessions?limit=100`,
    { headers },
  );

  if (!projectRes.ok) {
    if (projectRes.status === 401 || projectRes.status === 403) {
      throw new Error(
        "Invalid LangSmith API key. Set LANGSMITH_API_KEY or pass --api-key.",
      );
    }
    throw new Error(
      `LangSmith API error: ${projectRes.status} ${projectRes.statusText}`,
    );
  }

  const projectData = (await projectRes.json()) as
    | Array<{ id: string; name: string }>
    | { sessions: Array<{ id: string; name: string }> };
  const projects = Array.isArray(projectData)
    ? projectData
    : (projectData.sessions ?? []);

  const project = projects.find(
    (p: { name: string }) => p.name === projectName,
  );
  if (!project) {
    const available = projects
      .map((p: { name: string }) => p.name)
      .slice(0, 5)
      .join(", ");
    throw new Error(
      `LangSmith project "${projectName}" not found. ` +
        `Available: ${available || "(none)"}`,
    );
  }

  return project.id;
}

async function fetchAllRuns(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  filters: Record<string, unknown>,
  maxRuns: number,
): Promise<LangSmithRun[]> {
  const allRuns: LangSmithRun[] = [];
  let cursor: string | undefined;

  while (allRuns.length < maxRuns) {
    const body: Record<string, unknown> = {
      session: [projectId],
      ...filters,
      limit: PAGE_SIZE,
    };
    if (cursor) body.cursor = cursor;

    const res = await fetchWithRetry(`${baseUrl}/api/v1/runs/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`LangSmith runs API error: ${res.status}`);

    const data = (await res.json()) as {
      runs?: LangSmithRun[];
      cursors?: { next?: string };
    };
    const runs = data.runs ?? [];
    cursor = data.cursors?.next;

    if (runs.length === 0) break;

    allRuns.push(...runs);

    if (!cursor) break;
    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
  }

  return allRuns.slice(0, maxRuns);
}

async function fetchChildLlmRuns(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  traceId: string,
): Promise<LangSmithRun[]> {
  const body = {
    session: [projectId],
    trace_id: traceId,
    run_type: "llm",
    limit: 50,
  };

  const res = await fetchWithRetry(`${baseUrl}/api/v1/runs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) return [];

  const data = (await res.json()) as { runs?: LangSmithRun[] };
  const runs = data.runs ?? [];

  // Sort by start_time
  runs.sort(
    (a, b) =>
      new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
  );

  return runs;
}

export function normalizeRole(
  type: string,
): "user" | "assistant" | "system" | "tool" {
  const lower = type.toLowerCase();
  if (lower === "human" || lower === "humanmessage" || lower === "user")
    return "user";
  if (lower === "ai" || lower === "aimessage" || lower === "assistant")
    return "assistant";
  if (lower === "system" || lower === "systemmessage") return "system";
  if (lower === "tool" || lower === "toolmessage" || lower === "function")
    return "tool";
  return "user";
}

function extractModel(run: LangSmithRun): string | undefined {
  const extra = run.extra as Record<string, unknown>;
  const invocationParams = extra?.invocation_params as
    | Record<string, unknown>
    | undefined;
  return (
    (invocationParams?.model as string) ??
    (invocationParams?.model_name as string) ??
    undefined
  );
}

function extractDuration(run: LangSmithRun): number | undefined {
  if (!run.start_time || !run.end_time) return undefined;
  const start = new Date(run.start_time).getTime();
  const end = new Date(run.end_time).getTime();
  return (end - start) / 1000;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, init);

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const delayMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : RATE_LIMIT_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `LangSmith rate limited. Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    return res;
  }

  return fetch(url, init);
}
