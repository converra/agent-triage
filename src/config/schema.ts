import { z } from "zod";

export const LlmProviderSchema = z.enum([
  "openai",
  "anthropic",
  "openai-compatible",
]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const TraceSourceSchema = z.enum(["json", "langsmith", "otel", "langfuse", "axiom"]);
export type TraceSource = z.infer<typeof TraceSourceSchema>;

export const ConfigSchema = z.object({
  llm: z
    .object({
      provider: LlmProviderSchema.default("anthropic"),
      model: z.string().default("claude-sonnet-4-6"),
      apiKey: z.string().optional(),
      baseUrl: z.string().url().optional(),
      maxConcurrency: z.number().int().min(1).max(20).default(5),
    })
    .default({}),
  prompt: z.object({
    path: z.string(),
  }).optional(),
  traces: z
    .object({
      source: TraceSourceSchema.default("json"),
      path: z.string().optional(),
      project: z.string().optional(),
      apiKey: z.string().optional(),
      baseUrl: z.string().url().optional(),
    })
    .optional(),
  output: z
    .object({
      dir: z.string().default("."),
      includePrompt: z.boolean().default(false),
      summaryOnly: z.boolean().default(false),
      maxConversations: z.number().int().min(1).default(500),
    })
    .optional(),
  agent: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
