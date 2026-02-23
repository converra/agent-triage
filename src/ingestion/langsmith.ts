import type { NormalizedConversation, Message } from "./types.js";

const DEFAULT_BASE_URL = "https://api.smith.langchain.com";
const PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 650;
const MAX_RETRIES = 3;

interface LangSmithConfig {
  apiKey: string;
  project: string;
  baseUrl?: string;
  limit?: number;
}

interface LangSmithRun {
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
}

export async function readLangSmithTraces(
  config: LangSmithConfig,
): Promise<NormalizedConversation[]> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const headers: Record<string, string> = {
    "x-api-key": config.apiKey,
    "Content-Type": "application/json",
  };

  // Get project ID from name
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
  // LangSmith returns array or {sessions: [...]}
  const projects = Array.isArray(projectData)
    ? projectData
    : (projectData.sessions ?? []);

  const project = projects.find(
    (p: { name: string }) => p.name === config.project,
  );
  if (!project) {
    const available = projects.map((p: { name: string }) => p.name).slice(0, 5).join(", ");
    throw new Error(
      `LangSmith project "${config.project}" not found. ` +
        `Available: ${available || "(none)"}`,
    );
  }

  const projectId = project.id;

  // Fetch runs using POST /api/v1/runs/query (cursor-based pagination)
  const conversations: NormalizedConversation[] = [];
  const limit = config.limit ?? 500;
  let cursor: string | undefined;

  while (conversations.length < limit) {
    const body: Record<string, unknown> = {
      session: [projectId],
      is_root: true,
      limit: PAGE_SIZE,
    };
    if (cursor) {
      body.cursor = cursor;
    }

    const runsRes = await fetchWithRetry(`${baseUrl}/api/v1/runs/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!runsRes.ok) {
      throw new Error(`LangSmith runs API error: ${runsRes.status}`);
    }

    const data = (await runsRes.json()) as {
      runs?: LangSmithRun[];
      cursors?: { next?: string };
    };
    const runs = data.runs ?? [];
    cursor = data.cursors?.next;

    if (runs.length === 0) break;

    for (const run of runs) {
      const conversation = normalizeRun(run);
      if (conversation) {
        conversations.push(conversation);
        if (conversations.length >= limit) break;
      }
    }

    if (!cursor) break;

    // Rate limiting
    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
  }

  return conversations;
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

function normalizeRun(run: LangSmithRun): NormalizedConversation | null {
  const messages = extractMessages(run);
  if (messages.length === 0) return null;

  let systemPrompt: string | undefined;
  const firstSystem = messages.find((m) => m.role === "system");
  if (firstSystem) {
    systemPrompt = firstSystem.content;
  }

  return {
    id: run.id,
    messages,
    systemPrompt,
    metadata: {
      model: extractModel(run),
      totalTokens: run.total_tokens ?? undefined,
      duration: extractDuration(run),
      source: "langsmith",
    },
    timestamp: run.start_time,
  };
}

function extractMessages(run: LangSmithRun): Message[] {
  const messages: Message[] = [];

  // Extract from inputs
  const inputMessages =
    (run.inputs?.messages as unknown[]) ??
    (run.inputs?.input as unknown[]) ??
    [];

  if (Array.isArray(inputMessages)) {
    for (const msg of inputMessages) {
      const normalized = normalizeLangSmithMessage(msg);
      if (normalized) messages.push(normalized);
    }
  } else if (typeof run.inputs?.input === "string") {
    messages.push({ role: "user", content: run.inputs.input as string });
  }

  // Extract from outputs
  if (run.outputs) {
    const outputMessages =
      (run.outputs.messages as unknown[]) ??
      (run.outputs.output as unknown[]) ??
      [];

    if (Array.isArray(outputMessages)) {
      for (const msg of outputMessages) {
        const normalized = normalizeLangSmithMessage(msg);
        if (normalized) messages.push(normalized);
      }
    } else if (typeof run.outputs.output === "string") {
      messages.push({
        role: "assistant",
        content: run.outputs.output as string,
      });
    }
  }

  return messages;
}

function normalizeLangSmithMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // LangSmith uses type field for role
  const role = normalizeRole(
    (obj.type as string) ?? (obj.role as string) ?? "",
  );
  const content =
    typeof obj.content === "string"
      ? obj.content
      : typeof obj.text === "string"
        ? obj.text
        : "";

  if (!content && !obj.tool_calls) return null;

  return {
    role,
    content,
    ...(obj.tool_calls
      ? {
          toolCalls: (
            obj.tool_calls as Array<{ name: string; args: unknown }>
          ).map((tc) => ({
            name: tc.name,
            arguments: tc.args,
          })),
        }
      : {}),
  };
}

function normalizeRole(
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
