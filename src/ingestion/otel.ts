import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { NormalizedConversation, Message } from "./types.js";

/**
 * OpenTelemetry OTLP/JSON reader
 * Pinned to GenAI semantic conventions v1.36.0 (Development status)
 *
 * GenAI semconv attributes:
 * - gen_ai.system → provider
 * - gen_ai.request.model → model
 * - gen_ai.prompt / gen_ai.completion → messages
 * - gen_ai.usage.prompt_tokens + gen_ai.usage.completion_tokens → tokens
 */
export const OTEL_SEMCONV_VERSION = "1.36.0";

interface OtelResource {
  resourceSpans: Array<{
    resource: { attributes: OtelAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version?: string };
      spans: OtelSpan[];
    }>;
  }>;
}

interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtelAttribute[];
  events?: OtelEvent[];
}

interface OtelAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    arrayValue?: { values: Array<{ stringValue?: string }> };
  };
}

interface OtelEvent {
  name: string;
  timeUnixNano: string;
  attributes: OtelAttribute[];
}

export async function readOtelTraces(
  filePath: string,
): Promise<NormalizedConversation[]> {
  const resolvedPath = resolve(process.cwd(), filePath);
  const raw = await readFile(resolvedPath, "utf-8");
  const data = JSON.parse(raw) as OtelResource;

  if (!data.resourceSpans || data.resourceSpans.length === 0) {
    throw new Error(
      `No OTLP resource spans found in ${filePath}. ` +
        "Expected OTLP/JSON export format with resourceSpans array.",
    );
  }

  // Collect all spans grouped by traceId
  const traceMap = new Map<string, OtelSpan[]>();

  for (const resourceSpan of data.resourceSpans) {
    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        const traceId = span.traceId;
        if (!traceMap.has(traceId)) {
          traceMap.set(traceId, []);
        }
        traceMap.get(traceId)!.push(span);
      }
    }
  }

  const conversations: NormalizedConversation[] = [];

  for (const [traceId, spans] of traceMap) {
    const conversation = normalizeTrace(traceId, spans);
    if (conversation) {
      conversations.push(conversation);
    }
  }

  return conversations;
}

function normalizeTrace(
  traceId: string,
  spans: OtelSpan[],
): NormalizedConversation | null {
  // Sort spans by start time
  spans.sort(
    (a, b) =>
      Number(BigInt(a.startTimeUnixNano)) -
      Number(BigInt(b.startTimeUnixNano)),
  );

  const messages: Message[] = [];
  let model: string | undefined;
  let totalTokens = 0;
  let systemPrompt: string | undefined;
  let earliestTime = Infinity;
  let latestTime = 0;

  for (const span of spans) {
    const attrs = parseAttributes(span.attributes);

    // Extract model
    if (!model && attrs["gen_ai.request.model"]) {
      model = attrs["gen_ai.request.model"] as string;
    }

    // Extract tokens
    const promptTokens = Number(attrs["gen_ai.usage.prompt_tokens"] ?? 0);
    const completionTokens = Number(
      attrs["gen_ai.usage.completion_tokens"] ?? 0,
    );
    totalTokens += promptTokens + completionTokens;

    // Track time range
    const startNano = Number(BigInt(span.startTimeUnixNano));
    const endNano = Number(BigInt(span.endTimeUnixNano));
    if (startNano < earliestTime) earliestTime = startNano;
    if (endNano > latestTime) latestTime = endNano;

    // Extract messages from events (gen_ai.content.prompt, gen_ai.content.completion)
    if (span.events) {
      for (const event of span.events) {
        const eventAttrs = parseAttributes(event.attributes);

        if (event.name === "gen_ai.content.prompt") {
          const content = eventAttrs["gen_ai.prompt"] as string;
          if (content) {
            // Try to parse as JSON message array
            try {
              const parsed = JSON.parse(content);
              if (Array.isArray(parsed)) {
                for (const msg of parsed) {
                  const role = msg.role ?? "user";
                  if (role === "system" && !systemPrompt) {
                    systemPrompt = msg.content;
                    continue;
                  }
                  messages.push({
                    role: normalizeRole(role),
                    content: msg.content ?? "",
                  });
                }
              } else {
                messages.push({ role: "user", content });
              }
            } catch {
              messages.push({ role: "user", content });
            }
          }
        }

        if (event.name === "gen_ai.content.completion") {
          const content = eventAttrs["gen_ai.completion"] as string;
          if (content) {
            messages.push({ role: "assistant", content });
          }
        }
      }
    }

    // Also check span-level prompt/completion attributes
    const promptAttr = attrs["gen_ai.prompt"] as string | undefined;
    if (promptAttr && messages.length === 0) {
      messages.push({ role: "user", content: promptAttr });
    }

    const completionAttr = attrs["gen_ai.completion"] as string | undefined;
    if (completionAttr && !messages.some((m) => m.role === "assistant")) {
      messages.push({ role: "assistant", content: completionAttr });
    }
  }

  if (messages.length === 0) return null;

  const durationMs = (latestTime - earliestTime) / 1_000_000;

  return {
    id: traceId,
    messages,
    systemPrompt,
    metadata: {
      model,
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      duration: durationMs > 0 ? durationMs / 1000 : undefined,
      source: "otel",
      traceId,
    },
    timestamp: new Date(earliestTime / 1_000_000).toISOString(),
  };
}

function parseAttributes(
  attrs: OtelAttribute[],
): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const attr of attrs) {
    if (attr.value.stringValue !== undefined) {
      result[attr.key] = attr.value.stringValue;
    } else if (attr.value.intValue !== undefined) {
      result[attr.key] = Number(attr.value.intValue);
    } else if (attr.value.doubleValue !== undefined) {
      result[attr.key] = attr.value.doubleValue;
    }
  }
  return result;
}

function normalizeRole(
  role: string,
): "user" | "assistant" | "system" | "tool" {
  const lower = role.toLowerCase();
  if (lower === "user" || lower === "human") return "user";
  if (lower === "assistant" || lower === "ai") return "assistant";
  if (lower === "system") return "system";
  if (lower === "tool" || lower === "function") return "tool";
  return "user";
}
