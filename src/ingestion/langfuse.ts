import { createHash } from "node:crypto";
import type { NormalizedConversation, Message } from "./types.js";
import { normalizeRole } from "./normalize-role.js";
import { getLogger } from "../logger.js";

const DEFAULT_HOST = "https://cloud.langfuse.com";
const TRACE_PAGE_SIZE = 50;
const MAX_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 1000;
const DEFAULT_LIMIT = 500;

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host?: string;       // default "https://cloud.langfuse.com"
  limit?: number;      // default 500
  startTime?: string;  // ISO 8601
  endTime?: string;
}

interface LangfuseTrace {
  id: string;
  name?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  sessionId?: string;
  userId?: string;
  release?: string;
  input?: unknown;
  output?: unknown;
}

interface LangfuseTracesResponse {
  data: LangfuseTrace[];
  meta: {
    totalPages: number;
    page: number;
    totalItems: number;
  };
}

interface LangfuseObservation {
  id: string;
  traceId: string;
  type: string;
  name?: string;
  startTime: string;
  endTime?: string;
  model?: string;
  input?: unknown;
  output?: unknown;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
  };
  completionStartTime?: string;
}

interface LangfuseObservationsResponse {
  data: LangfuseObservation[];
  meta: {
    totalItems: number;
    page: number;
    totalPages: number;
  };
}

// ─── Public API ──────────────────────────────────────────────────────

export async function readLangfuseTraces(
  config: LangfuseConfig,
): Promise<NormalizedConversation[]> {
  const host = (config.host ?? DEFAULT_HOST).replace(/\/+$/, "");
  const limit = config.limit ?? DEFAULT_LIMIT;
  const authHeader = buildAuthHeader(config.publicKey, config.secretKey);

  const traces = await fetchAllTraces(host, authHeader, config, limit);

  if (traces.length === 0) return [];

  const conversations: NormalizedConversation[] = [];

  for (const trace of traces) {
    if (conversations.length >= limit) break;

    const generations = await fetchGenerations(host, authHeader, trace.id);
    if (generations.length === 0) continue;

    const conv = normalizeTrace(trace, generations);
    if (conv) conversations.push(conv);
  }

  return conversations;
}

// ─── Trace Fetching (offset pagination) ──────────────────────────────

async function fetchAllTraces(
  host: string,
  authHeader: string,
  config: LangfuseConfig,
  limit: number,
): Promise<LangfuseTrace[]> {
  const allTraces: LangfuseTrace[] = [];
  let page = 1;

  while (allTraces.length < limit) {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(TRACE_PAGE_SIZE),
    });
    if (config.startTime) params.set("fromTimestamp", config.startTime);
    if (config.endTime) params.set("toTimestamp", config.endTime);

    const url = `${host}/api/public/traces?${params}`;
    const res = await fetchWithRetry(url, {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "Invalid Langfuse credentials. Check LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.",
        );
      }
      const text = await res.text().catch(() => "");
      throw new Error(`Langfuse API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }

    const data = (await res.json()) as LangfuseTracesResponse;
    allTraces.push(...data.data);

    if (page >= data.meta.totalPages) break;
    page++;
  }

  return allTraces.slice(0, limit);
}

// ─── Generation Fetching (cursor pagination) ─────────────────────────

async function fetchGenerations(
  host: string,
  authHeader: string,
  traceId: string,
): Promise<LangfuseObservation[]> {
  const allObs: LangfuseObservation[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      traceId,
      type: "GENERATION",
      limit: "100",
      page: String(page),
    });

    const url = `${host}/api/public/observations?${params}`;
    const res = await fetchWithRetry(url, {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) break;

    const data = (await res.json()) as LangfuseObservationsResponse;
    allObs.push(...data.data);

    if (page >= data.meta.totalPages) break;
    page++;
  }

  return allObs;
}

// ─── Trace Normalization ─────────────────────────────────────────────

function normalizeTrace(
  trace: LangfuseTrace,
  generations: LangfuseObservation[],
): NormalizedConversation | null {
  // Sort generations by startTime
  generations.sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );

  const messages: Message[] = [];
  const seenUserContent = new Set<string>();
  let systemPrompt: string | undefined;
  let model: string | undefined;
  let totalTokens = 0;

  for (let gi = 0; gi < generations.length; gi++) {
    const gen = generations[gi];
    if (!model && gen.model) model = gen.model;

    // Accumulate tokens — Langfuse provides both top-level and nested usage fields
    const promptTok = gen.promptTokens ?? gen.usage?.input ?? 0;
    const completionTok = gen.completionTokens ?? gen.usage?.output ?? 0;
    totalTokens += promptTok + completionTok;

    // Extract input messages — each generation's input contains the full history
    // up to that point. For the first generation, take all messages. For subsequent
    // generations, only take the new messages (last user/tool message) to avoid duplicates.
    if (gen.input) {
      const inputMessages = extractInputMessages(gen.input);

      // Hoist system prompt from any generation
      for (const msg of inputMessages) {
        if (msg.role === "system" && !systemPrompt) {
          systemPrompt = msg.content;
        }
      }

      if (gi === 0) {
        // First generation: add all non-system messages
        for (const msg of inputMessages) {
          if (msg.role !== "system") {
            if (msg.role === "user") {
              seenUserContent.add(msg.content.trim().toLowerCase());
            }
            messages.push(msg);
          }
        }
      } else {
        // Subsequent generations: only add the last user/tool message (the new turn)
        for (let i = inputMessages.length - 1; i >= 0; i--) {
          const msg = inputMessages[i];
          if (msg.role === "user" || msg.role === "tool") {
            // Deduplicate — orchestrators and sub-agents often receive the same input
            const key = msg.content.trim().toLowerCase();
            if (!seenUserContent.has(key)) {
              seenUserContent.add(key);
              messages.push(msg);
            }
            break;
          }
        }
      }
    }

    // Extract output (completion)
    if (gen.output) {
      const outputContent = extractOutputContent(gen.output);
      if (outputContent) {
        messages.push({ role: "assistant", content: outputContent });
      }
    }
  }

  if (messages.length === 0) return null;

  // Compute duration from first and last generation
  const firstTime = new Date(generations[0].startTime).getTime();
  const lastGen = generations[generations.length - 1];
  const lastTime = lastGen.endTime
    ? new Date(lastGen.endTime).getTime()
    : new Date(lastGen.startTime).getTime();
  const durationSec = (lastTime - firstTime) / 1000;

  // Compute prompt hash
  const promptHash = systemPrompt ? hashPrompt(systemPrompt) : undefined;

  return {
    id: trace.id,
    messages,
    systemPrompt,
    metadata: {
      model,
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      duration: durationSec > 0 ? durationSec : undefined,
      source: "langfuse",
      agentName: trace.name || undefined,
      tags: trace.tags && trace.tags.length > 0 ? trace.tags : undefined,
      sessionId: trace.sessionId || undefined,
      promptHash,
      traceId: trace.id,
    },
    timestamp: trace.timestamp,
  };
}

// ─── Message Extraction ──────────────────────────────────────────────

function extractInputMessages(input: unknown): Message[] {
  // Array of messages: [{role, content}]
  if (Array.isArray(input)) {
    return input
      .filter((m) => m && typeof m === "object" && "role" in m && "content" in m)
      .map((m) => ({
        role: normalizeRole(String(m.role)),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));
  }

  // String input — treat as user message
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  // Object with messages array
  if (input && typeof input === "object" && "messages" in input) {
    const obj = input as { messages: unknown };
    if (Array.isArray(obj.messages)) {
      return extractInputMessages(obj.messages);
    }
  }

  return [];
}

function extractOutputContent(output: unknown): string | null {
  if (typeof output === "string") return output;

  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;

    // {content: "..."} or {message: {content: "..."}}
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;

    // OpenAI choices format
    if (Array.isArray(obj.choices)) {
      const first = obj.choices[0] as Record<string, unknown> | undefined;
      if (first) {
        const msg = first.message as Record<string, unknown> | undefined;
        if (msg && typeof msg.content === "string") return msg.content;
      }
    }

    // Anthropic content blocks
    if (Array.isArray(obj.content)) {
      const texts = (obj.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string);
      if (texts.length > 0) return texts.join("\n");
    }
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function buildAuthHeader(publicKey: string, secretKey: string): string {
  const encoded = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return `Basic ${encoded}`;
}


function hashPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
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
      getLogger().warn(
        `Langfuse rate limited. Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    return res;
  }

  return fetch(url, init);
}
