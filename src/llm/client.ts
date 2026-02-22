import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "../config/schema.js";

export interface LlmCallOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface LlmResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export function createLlmClient(
  provider: LlmProvider,
  apiKey: string,
  model: string,
  baseUrl?: string,
): LlmClient {
  return new LlmClient(provider, apiKey, model, baseUrl);
}

export class LlmClient {
  private openai?: OpenAI;
  private anthropic?: Anthropic;
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  constructor(
    private provider: LlmProvider,
    private apiKey: string,
    private model: string,
    private baseUrl?: string,
  ) {
    if (provider === "anthropic") {
      this.anthropic = new Anthropic({ apiKey });
    } else {
      this.openai = new OpenAI({
        apiKey,
        baseURL: baseUrl ?? (provider === "openai" ? undefined : baseUrl),
      });
    }
  }

  async call(prompt: string, options?: LlmCallOptions): Promise<LlmResponse> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = this.anthropic
          ? await this.callAnthropic(prompt, options)
          : await this.callOpenAI(prompt, options);

        this.usage.inputTokens += response.inputTokens;
        this.usage.outputTokens += response.outputTokens;
        this.usage.calls++;

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (isRateLimitError(error)) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          process.stderr.write(
            `Rate limited. Retrying in ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...\n`,
          );
          await sleep(backoff);
          continue;
        }

        if (!isRetryableError(error)) throw lastError;

        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoff);
      }
    }

    throw lastError ?? new Error("LLM call failed after retries");
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  getModel(): string {
    return this.model;
  }

  getProvider(): string {
    return this.provider;
  }

  private async callOpenAI(
    prompt: string,
    options?: LlmCallOptions,
  ): Promise<LlmResponse> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await this.openai!.chat.completions.create({
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens ?? 4096,
    });

    return {
      content: response.choices[0]?.message?.content ?? "",
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }

  private async callAnthropic(
    prompt: string,
    options?: LlmCallOptions,
  ): Promise<LlmResponse> {
    const response = await this.anthropic!.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.2,
      system: options?.systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      content,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("rate limit") || msg.includes("429");
  }
  return false;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("connection")
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
