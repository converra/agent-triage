import { describe, it, expect } from "vitest";
import { parseDuration, applyFilters, createLogger } from "../../src/cli/filters.js";
import { makeConversation } from "../helpers.js";
import type { NormalizedConversation } from "../../src/ingestion/types.js";

describe("parseDuration", () => {
  it("parses hours", () => {
    const result = parseDuration("2h");
    const diff = Date.now() - new Date(result).getTime();
    // Should be approximately 2 hours ago (within 1s tolerance)
    expect(diff).toBeGreaterThan(2 * 3600_000 - 1000);
    expect(diff).toBeLessThan(2 * 3600_000 + 1000);
  });

  it("parses days", () => {
    const result = parseDuration("7d");
    const diff = Date.now() - new Date(result).getTime();
    expect(diff).toBeGreaterThan(7 * 86_400_000 - 1000);
    expect(diff).toBeLessThan(7 * 86_400_000 + 1000);
  });

  it("parses minutes", () => {
    const result = parseDuration("30m");
    const diff = Date.now() - new Date(result).getTime();
    expect(diff).toBeGreaterThan(30 * 60_000 - 1000);
    expect(diff).toBeLessThan(30 * 60_000 + 1000);
  });

  it("parses weeks", () => {
    const result = parseDuration("1w");
    const diff = Date.now() - new Date(result).getTime();
    expect(diff).toBeGreaterThan(7 * 86_400_000 - 1000);
  });

  it("passes through ISO dates", () => {
    const result = parseDuration("2026-02-20T10:00:00Z");
    expect(new Date(result).toISOString()).toBe("2026-02-20T10:00:00.000Z");
  });

  it("passes through date-only strings", () => {
    const result = parseDuration("2026-02-20");
    expect(result).toBeDefined();
    // Should parse without error
    expect(new Date(result).getFullYear()).toBe(2026);
  });

  it("throws on invalid format", () => {
    expect(() => parseDuration("invalid")).toThrow("Invalid duration");
    expect(() => parseDuration("2x")).toThrow("Invalid duration");
  });

  it("throws on invalid date-like strings", () => {
    expect(() => parseDuration("not-a-date")).toThrow("Invalid duration");
    expect(() => parseDuration("foo-bar-baz")).toThrow("Invalid duration");
  });
});

describe("applyFilters", () => {
  const baseConversations: NormalizedConversation[] = [
    {
      ...makeConversation("c1"),
      timestamp: "2026-02-24T10:00:00Z",
      metadata: { source: "langsmith", agentName: "Billing Agent" },
    },
    {
      ...makeConversation("c2"),
      timestamp: "2026-02-24T12:00:00Z",
      metadata: { source: "langsmith", agentName: "Sales Agent" },
    },
    {
      ...makeConversation("c3"),
      timestamp: "2026-02-23T10:00:00Z",
      metadata: { source: "langsmith", agentName: "Billing Agent" },
    },
  ];

  it("filters by agent name (case-insensitive)", () => {
    const result = applyFilters(baseConversations, { agent: "billing" });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("c1");
    expect(result[1].id).toBe("c3");
  });

  it("filters by conversation IDs", () => {
    const result = applyFilters(baseConversations, {
      conversation: ["c2"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c2");
  });

  it("returns all when no filters", () => {
    const result = applyFilters(baseConversations, {});
    expect(result).toHaveLength(3);
  });

  it("composes multiple filters", () => {
    const result = applyFilters(baseConversations, {
      agent: "billing",
      conversation: ["c1"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c1");
  });

  it("handles empty result", () => {
    const result = applyFilters(baseConversations, {
      agent: "nonexistent",
    });
    expect(result).toHaveLength(0);
  });
});

describe("createLogger", () => {
  it("creates a logger that logs when not quiet", () => {
    const logger = createLogger(false);
    expect(typeof logger.log).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.progress).toBe("function");
  });

  it("creates a silent logger when quiet", () => {
    const logger = createLogger(true);
    // Should not throw when called
    logger.log("test");
    logger.warn("test");
    logger.progress("test");
    // error should still work
    expect(typeof logger.error).toBe("function");
  });
});
