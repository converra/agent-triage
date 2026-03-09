import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { NormalizedConversation, Message } from "./types.js";
import { normalizeRole } from "./normalize-role.js";

/**
 * Read conversations from a local JSON file.
 * Supports:
 *  - Array of conversations in a single JSON file
 *  - JSONL (one conversation per line)
 *  - Flexible message formats ({role, content} or {sender, text})
 */
export async function readJsonTraces(
  filePath: string,
): Promise<NormalizedConversation[]> {
  const resolvedPath = resolve(process.cwd(), filePath);
  const raw = await readFile(resolvedPath, "utf-8");

  const isJsonl =
    raw.trimStart().startsWith("{") && raw.includes("\n{");

  let rawConversations: unknown[];

  if (isJsonl) {
    rawConversations = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } else {
    const parsed = JSON.parse(raw);
    rawConversations = Array.isArray(parsed) ? parsed : [parsed];
  }

  if (rawConversations.length === 0) {
    throw new Error(
      `No conversations found in ${filePath}. ` +
        "Expected a JSON array of conversations or JSONL format.",
    );
  }

  return rawConversations.map((conv, index) =>
    normalizeConversation(conv, index),
  );
}

const FlexibleMessageSchema = z.object({
  role: z.string().optional(),
  sender: z.string().optional(),
  content: z.string().optional(),
  text: z.string().optional(),
  message: z.string().optional(),
  timestamp: z.string().optional(),
  name: z.string().optional(),
  tool_calls: z.any().optional(),
  toolCalls: z.any().optional(),
  tool_call_id: z.string().optional(),
  toolCallId: z.string().optional(),
});

function normalizeConversation(
  raw: unknown,
  index: number,
): NormalizedConversation {
  const obj = raw as Record<string, unknown>;
  const id =
    (obj.id as string) ??
    (obj.conversation_id as string) ??
    (obj.conversationId as string) ??
    `conv_${index + 1}`;

  const rawMessages =
    (obj.messages as unknown[]) ??
    (obj.turns as unknown[]) ??
    (obj.transcript as unknown[]) ??
    [];

  const messages: Message[] = rawMessages.map(normalizeMessage);

  // Extract system prompt from first system message or metadata
  let systemPrompt =
    (obj.systemPrompt as string) ??
    (obj.system_prompt as string) ??
    undefined;

  if (!systemPrompt) {
    const firstSystem = messages.find((m) => m.role === "system");
    if (firstSystem) {
      systemPrompt = firstSystem.content;
    }
  }

  const metadata = obj.metadata as Record<string, unknown> | undefined;

  return {
    id,
    messages,
    systemPrompt,
    metadata: {
      model: (metadata?.model as string) ?? (obj.model as string) ?? undefined,
      totalTokens:
        (metadata?.totalTokens as number) ??
        (metadata?.total_tokens as number) ??
        (obj.totalTokens as number) ??
        undefined,
      duration:
        (metadata?.duration as number) ??
        (obj.duration as number) ??
        undefined,
      source: "json",
      tags: (metadata?.tags as string[]) ?? (obj.tags as string[]) ?? undefined,
    },
    timestamp:
      (obj.timestamp as string) ??
      (obj.created_at as string) ??
      (obj.createdAt as string) ??
      new Date().toISOString(),
  };
}

function normalizeMessage(raw: unknown): Message {
  const parsed = FlexibleMessageSchema.parse(raw);

  const role = normalizeRole(parsed.role ?? parsed.sender ?? "user");
  const content = parsed.content ?? parsed.text ?? parsed.message ?? "";
  const toolCalls = parsed.toolCalls ?? parsed.tool_calls ?? undefined;
  const toolCallId = parsed.toolCallId ?? parsed.tool_call_id ?? undefined;
  const agent = parsed.name ?? undefined;

  return {
    role,
    content,
    timestamp: parsed.timestamp,
    ...(agent ? { agent } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

