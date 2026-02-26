import { z } from "zod";

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  timestamp: z.string().optional(),
  agent: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        name: z.string(),
        arguments: z.any(),
      }),
    )
    .optional(),
  toolCallId: z.string().optional(),
});

export type Message = z.infer<typeof MessageSchema>;

export const NormalizedConversationSchema = z.object({
  id: z.string(),
  messages: z.array(MessageSchema),
  systemPrompt: z.string().optional(),
  metadata: z.object({
    model: z.string().optional(),
    totalTokens: z.number().optional(),
    duration: z.number().optional(),
    source: z.enum(["json", "langsmith", "langfuse", "otel"]),
    tags: z.array(z.string()).optional(),
    agentName: z.string().optional(),
    promptHash: z.string().optional(),
    sessionId: z.string().optional(),
    traceId: z.string().optional(),
    subAgents: z.array(z.object({
      name: z.string(),
      systemPrompt: z.string(),
      promptHash: z.string(),
    })).optional(),
  }),
  timestamp: z.string(),
});

export type NormalizedConversation = z.infer<
  typeof NormalizedConversationSchema
>;
