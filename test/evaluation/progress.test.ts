import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { unlink, readFile } from "node:fs/promises";
import {
  computePoliciesHash,
  saveProgress,
  loadProgress,
  cleanupProgress,
} from "../../src/evaluation/progress.js";
import type { ConversationResult } from "../../src/evaluation/types.js";

const PROGRESS_FILE = resolve(process.cwd(), ".converra-triage-progress.json");

afterEach(async () => {
  await cleanupProgress();
});

describe("computePoliciesHash", () => {
  it("returns consistent hash for same input", () => {
    const hash1 = computePoliciesHash('[{"id":"p1"}]');
    const hash2 = computePoliciesHash('[{"id":"p1"}]');
    expect(hash1).toBe(hash2);
  });

  it("returns different hash for different input", () => {
    const hash1 = computePoliciesHash('[{"id":"p1"}]');
    const hash2 = computePoliciesHash('[{"id":"p2"}]');
    expect(hash1).not.toBe(hash2);
  });

  it("returns a hex string", () => {
    const hash = computePoliciesHash("test");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("saveProgress and loadProgress", () => {
  const makeResult = (id: string): ConversationResult => ({
    id,
    metrics: {
      successScore: 80,
      aiRelevancy: 80,
      sentiment: 80,
      hallucinationScore: 80,
      repetitionScore: 80,
      consistencyScore: 80,
      naturalLanguageScore: 80,
      contextRetentionScore: 80,
      verbosityScore: 80,
      taskCompletion: 80,
      clarity: 80,
      truncationScore: 0,
    },
    policyResults: [{ policyId: "p1", passed: true, evidence: "OK" }],
    messages: [],
  });

  it("round-trips progress data", async () => {
    const hash = "test-hash-abc";
    const completed = new Map<string, ConversationResult>();
    completed.set("conv-1", makeResult("conv-1"));
    completed.set("conv-2", makeResult("conv-2"));

    await saveProgress(hash, completed);
    expect(existsSync(PROGRESS_FILE)).toBe(true);

    const loaded = await loadProgress(hash);
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(2);
    expect(loaded!.get("conv-1")!.id).toBe("conv-1");
    expect(loaded!.get("conv-2")!.id).toBe("conv-2");
  });

  it("returns null when no progress file exists", async () => {
    const loaded = await loadProgress("nonexistent");
    expect(loaded).toBeNull();
  });

  it("discards stale progress when hash changes", async () => {
    const completed = new Map<string, ConversationResult>();
    completed.set("conv-1", makeResult("conv-1"));

    await saveProgress("old-hash", completed);

    const loaded = await loadProgress("new-hash");
    expect(loaded).toBeNull();
  });
});

describe("cleanupProgress", () => {
  it("removes progress file", async () => {
    const completed = new Map<string, ConversationResult>();
    await saveProgress("cleanup-test", completed);
    expect(existsSync(PROGRESS_FILE)).toBe(true);

    await cleanupProgress();
    expect(existsSync(PROGRESS_FILE)).toBe(false);
  });

  it("does not throw when no file exists", async () => {
    await expect(cleanupProgress()).resolves.not.toThrow();
  });
});
