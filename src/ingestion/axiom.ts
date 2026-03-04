import type { NormalizedConversation, Message } from "./types.js";

const DEFAULT_BASE_URL = "https://api.axiom.co";
const MAX_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 1000;
const DEFAULT_LIMIT = 500;

export interface AxiomConfig {
  apiKey: string;
  dataset: string;
  orgId?: string;
  baseUrl?: string;
  limit?: number;
  startTime?: string; // ISO 8601
  endTime?: string;   // ISO 8601
}

interface AxiomField {
  name: string;
  type: string;
}

interface AxiomTable {
  fields: AxiomField[];
  columns: unknown[][];
}

interface AxiomResponse {
  tables: AxiomTable[];
  status: {
    minCursor?: string;
    maxCursor?: string;
    rowsMatched?: number;
  };
}

/**
 * Axiom flattens OTel attributes into top-level dotted columns, e.g.:
 *   attributes.gen_ai.request.model
 *   attributes.gen_ai.input.messages
 * The SpanRow uses a flat Record to hold these.
 */
interface SpanRow {
  [key: string]: unknown;
}

// ─── Public API ──────────────────────────────────────────────────────

export async function readAxiomTraces(
  config: AxiomConfig,
): Promise<NormalizedConversation[]> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const headers = buildHeaders(config.apiKey, config.orgId);
  const limit = config.limit ?? DEFAULT_LIMIT;

  const allSpans = await fetchAllSpans(baseUrl, headers, config, limit);

  if (allSpans.length === 0) return [];

  // Normalize each span as its own conversation.
  // OTel gen_ai spans carry full input/output messages — each span is a
  // complete LLM interaction. Grouping by trace_id would merge hundreds
  // of spans into one massive conversation that exceeds context limits.
  const conversations: NormalizedConversation[] = [];
  for (const span of allSpans) {
    if (conversations.length >= limit) break;
    const conv = normalizeSpan(span);
    if (conv) conversations.push(conv);
  }

  return conversations;
}

// ─── APL Query Builder ───────────────────────────────────────────────

export function buildAplQuery(config: AxiomConfig): string {
  const parts: string[] = [`['${config.dataset}']`];

  // Time filter
  if (config.startTime) {
    parts.push(`| where _time >= datetime("${config.startTime}")`);
  }
  if (config.endTime) {
    parts.push(`| where _time <= datetime("${config.endTime}")`);
  }

  // Filter to gen_ai spans — use request.model as the most universal indicator
  // (present in both old and new OTel GenAI semconv)
  parts.push(
    `| where isnotnull(['attributes.gen_ai.request.model'])`,
  );

  parts.push(`| sort by _time asc`);

  return parts.join("\n");
}

// ─── Fetch with Pagination ───────────────────────────────────────────

async function fetchAllSpans(
  baseUrl: string,
  headers: Record<string, string>,
  config: AxiomConfig,
  limit: number,
): Promise<SpanRow[]> {
  const allSpans: SpanRow[] = [];
  let cursor: string | undefined;
  const apl = buildAplQuery(config);

  while (allSpans.length < limit * 10) { // fetch up to 10x limit to account for grouping
    const body: Record<string, unknown> = {
      apl,
      startTime: config.startTime,
      endTime: config.endTime,
    };
    if (cursor) body.cursor = cursor;

    const url = `${baseUrl}/v1/datasets/_apl?format=tabular`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "Invalid Axiom API key. Set AXIOM_API_KEY or pass --axiom-api-key.",
        );
      }
      const text = await res.text().catch(() => "");
      throw new Error(`Axiom API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }

    const data = (await res.json()) as AxiomResponse;
    const spans = parseTabularResponse(data);

    if (spans.length === 0) break;
    allSpans.push(...spans);

    // Check for more pages
    cursor = data.status?.maxCursor;
    if (!cursor) break;
  }

  return allSpans;
}

// ─── Tabular Response Parser ─────────────────────────────────────────

export function parseTabularResponse(response: AxiomResponse): SpanRow[] {
  if (!response.tables || response.tables.length === 0) return [];

  const table = response.tables[0];
  if (!table.fields || !table.columns || table.columns.length === 0) return [];

  const fieldNames = table.fields.map((f) => f.name);
  const rowCount = table.columns[0]?.length ?? 0;

  const rows: SpanRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row: SpanRow = {};
    for (let j = 0; j < fieldNames.length; j++) {
      row[fieldNames[j]] = table.columns[j]?.[i];
    }
    rows.push(row);
  }

  return rows;
}

// ─── Span Normalization ──────────────────────────────────────────────

function normalizeSpan(span: SpanRow): NormalizedConversation | null {
  const spanId = (span.span_id as string) ?? (span.trace_id as string);
  const traceId = span.trace_id as string | undefined;
  if (!spanId) return null;

  const messages: Message[] = [];
  let systemPrompt: string | undefined;

  const model = (getField(span, "attributes.gen_ai.request.model") as string) ?? undefined;

  // Extract tokens — try both semconv naming conventions
  const inputTokens = Number(
    getField(span, "attributes.gen_ai.usage.input_tokens") ??
    getField(span, "attributes.gen_ai.usage.prompt_tokens") ?? 0,
  );
  const outputTokens = Number(
    getField(span, "attributes.gen_ai.usage.output_tokens") ??
    getField(span, "attributes.gen_ai.usage.completion_tokens") ?? 0,
  );
  const totalTokens = inputTokens + outputTokens;

  // Strategy 1: gen_ai.input.messages / gen_ai.output.messages (newer semconv)
  const inputMsgs = getField(span, "attributes.gen_ai.input.messages");
  const outputMsgs = getField(span, "attributes.gen_ai.output.messages");

  if (Array.isArray(inputMsgs)) {
    for (const msg of inputMsgs as Array<{ role?: string; content?: string }>) {
      if (!msg || typeof msg !== "object") continue;
      const role = msg.role ?? "user";
      const content = msg.content ?? "";
      if (role === "system" && !systemPrompt && content) {
        systemPrompt = content;
      }
      messages.push({ role: normalizeRole(role), content });
    }
  }

  if (Array.isArray(outputMsgs)) {
    for (const msg of outputMsgs as Array<{ role?: string; content?: string }>) {
      if (!msg || typeof msg !== "object") continue;
      messages.push({
        role: normalizeRole(msg.role ?? "assistant"),
        content: msg.content ?? "",
      });
    }
  }

  // Strategy 2: events array with gen_ai.content.prompt / gen_ai.content.completion
  const events = span.events as Array<{
    name: string;
    attributes?: Record<string, unknown>;
  }> | undefined;

  if (Array.isArray(events) && !Array.isArray(inputMsgs)) {
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const eventAttrs = event.attributes ?? {};

      if (event.name === "gen_ai.content.prompt") {
        const content = (eventAttrs["gen_ai.prompt"] as string) ?? undefined;
        if (content) {
          parsePromptContent(content, messages, (sp) => {
            if (!systemPrompt) systemPrompt = sp;
          });
        }
      }

      if (event.name === "gen_ai.content.completion") {
        const content = (eventAttrs["gen_ai.completion"] as string) ?? undefined;
        if (content) {
          messages.push({ role: "assistant", content });
        }
      }
    }
  }

  if (messages.length === 0) return null;

  // Parse span duration
  const durationField = span.duration;
  let durationSec: number | undefined;

  if (typeof durationField === "string" && durationField.endsWith("s")) {
    const secs = parseFloat(durationField);
    if (!isNaN(secs) && secs > 0) durationSec = secs;
  } else if (typeof durationField === "number" && durationField > 0) {
    durationSec = durationField / 1_000_000_000; // nanoseconds to seconds
  }

  // Use span_id as conversation id for uniqueness, with operation name for context
  const opName = (getField(span, "attributes.gen_ai.operation.name") as string) ?? undefined;
  const displayId = opName ? `${spanId.slice(0, 12)}-${opName}` : spanId;

  return {
    id: displayId,
    messages,
    systemPrompt,
    metadata: {
      model,
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      duration: durationSec,
      source: "axiom",
      traceId: traceId ?? spanId,
    },
    timestamp: span._time as string,
  };
}

// ─── Prompt Content Parser ───────────────────────────────────────────

function parsePromptContent(
  content: string,
  messages: Message[],
  onSystemPrompt: (sp: string) => void,
): void {
  // Try to parse as JSON message array
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      for (const msg of parsed) {
        const role = msg.role ?? "user";
        if (role === "system") {
          onSystemPrompt(msg.content);
        }
        messages.push({
          role: normalizeRole(role),
          content: msg.content ?? "",
        });
      }
      return;
    }
  } catch {
    // Not JSON — treat as plain text user message
  }

  messages.push({ role: "user", content });
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Get a field from a flattened Axiom span row.
 * Axiom returns columns as flat dotted keys: "attributes.gen_ai.request.model"
 * But some setups use nested objects. Try flat key first, then nested path.
 */
function getField(row: SpanRow, key: string): unknown {
  // Try flat dotted key first (how Axiom returns it)
  if (row[key] !== undefined && row[key] !== null) return row[key];

  // Try nested path for test data or alternative formats
  const parts = key.split(".");
  let current: unknown = row;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function normalizeRole(role: string): "user" | "assistant" | "system" | "tool" {
  const lower = role.toLowerCase();
  if (lower === "user" || lower === "human") return "user";
  if (lower === "assistant" || lower === "ai") return "assistant";
  if (lower === "system") return "system";
  if (lower === "tool" || lower === "function") return "tool";
  return "user";
}

function buildHeaders(apiKey: string, orgId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (orgId) {
    headers["x-axiom-org-id"] = orgId;
  }
  return headers;
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
        `Axiom rate limited. Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    return res;
  }

  return fetch(url, init);
}
