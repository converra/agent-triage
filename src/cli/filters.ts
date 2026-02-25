import type { NormalizedConversation } from "../ingestion/types.js";

export interface FilterSpec {
  since?: string;    // duration ("2h", "7d") or ISO date
  until?: string;    // duration or ISO date
  agent?: string;    // agent name filter (case-insensitive)
  policy?: string[]; // specific policy IDs
  conversation?: string[]; // specific conversation IDs
}

/**
 * Parse a duration string like "2h", "24h", "7d" into an ISO date string.
 * If already an ISO date string, returns as-is.
 */
export function parseDuration(input: string): string {
  // If it looks like an ISO date already, return as-is
  if (input.includes("T") || input.includes("-")) {
    const date = new Date(input);
    if (isNaN(date.getTime())) {
      throw new Error(
        `Invalid duration: "${input}". Use format like "2h", "24h", "7d", or a valid ISO date.`,
      );
    }
    return date.toISOString();
  }

  const match = input.match(/^(\d+)(m|h|d|w)$/);
  if (!match) {
    throw new Error(
      `Invalid duration: "${input}". Use format like "2h", "24h", "7d", or an ISO date.`,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const now = Date.now();
  const msPerUnit: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };

  return new Date(now - value * msPerUnit[unit]).toISOString();
}

/**
 * Apply post-ingestion filters to conversations.
 * Used for filters that can't be pushed to the API (agent name, conversation IDs)
 * and for non-LangSmith sources (JSON, OTEL) where all filtering is post-ingestion.
 */
export function applyFilters(
  conversations: NormalizedConversation[],
  filters: FilterSpec,
): NormalizedConversation[] {
  let result = conversations;

  // Time filters (for JSON/OTEL sources — LangSmith handles these server-side)
  if (filters.since) {
    const sinceDate = new Date(parseDuration(filters.since)).getTime();
    result = result.filter(
      (c) => new Date(c.timestamp).getTime() >= sinceDate,
    );
  }
  if (filters.until) {
    const untilDate = new Date(parseDuration(filters.until)).getTime();
    result = result.filter(
      (c) => new Date(c.timestamp).getTime() <= untilDate,
    );
  }

  // Agent name filter (case-insensitive, substring match)
  if (filters.agent) {
    const agentLower = filters.agent.toLowerCase();
    result = result.filter((c) =>
      c.metadata.agentName?.toLowerCase().includes(agentLower),
    );
  }

  // Specific conversation IDs
  if (filters.conversation && filters.conversation.length > 0) {
    const ids = new Set(filters.conversation);
    result = result.filter((c) => ids.has(c.id));
  }

  return result;
}

/**
 * Logger that can be silenced for JSON output mode.
 */
export function createLogger(quiet: boolean) {
  return {
    log: quiet ? (..._args: unknown[]) => {} : console.log.bind(console),
    warn: quiet ? (..._args: unknown[]) => {} : console.warn.bind(console),
    error: console.error.bind(console), // always show errors
    progress: quiet
      ? (..._args: unknown[]) => {}
      : (msg: string) => process.stdout.write(msg),
  };
}
