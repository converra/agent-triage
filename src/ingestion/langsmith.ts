import type { NormalizedConversation, Message } from "./types.js";

const DEFAULT_BASE_URL = "https://api.smith.langchain.com";
const PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 650;

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
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  start_time: string;
  end_time: string | null;
  extra: Record<string, unknown>;
  child_run_ids: string[] | null;
  parent_run_id: string | null;
  total_tokens: number | null;
}

export async function readLangSmithTraces(
  config: LangSmithConfig,
): Promise<NormalizedConversation[]> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const headers = {
    "x-api-key": config.apiKey,
    "Content-Type": "application/json",
  };

  // Get project ID from name
  const projectRes = await fetch(
    `${baseUrl}/api/v1/sessions?name=${encodeURIComponent(config.project)}`,
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

  const projects = (await projectRes.json()) as Array<{ id: string }>;
  if (projects.length === 0) {
    throw new Error(
      `LangSmith project "${config.project}" not found. Check the project name.`,
    );
  }

  const projectId = projects[0]!.id;

  // Fetch runs with pagination
  const conversations: NormalizedConversation[] = [];
  let offset = 0;
  const limit = config.limit ?? 500;

  while (conversations.length < limit) {
    const runsRes = await fetch(
      `${baseUrl}/api/v1/runs?session_id=${projectId}` +
        `&run_type=chain&is_root=true` +
        `&offset=${offset}&limit=${PAGE_SIZE}` +
        `&select=["id","name","run_type","inputs","outputs","start_time","end_time","extra","total_tokens","parent_run_id"]`,
      { headers },
    );

    if (!runsRes.ok) {
      throw new Error(`LangSmith runs API error: ${runsRes.status}`);
    }

    const runs = (await runsRes.json()) as LangSmithRun[];
    if (runs.length === 0) break;

    for (const run of runs) {
      const conversation = normalizeRun(run);
      if (conversation) {
        conversations.push(conversation);
        if (conversations.length >= limit) break;
      }
    }

    offset += PAGE_SIZE;

    // Rate limiting
    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
  }

  return conversations;
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
