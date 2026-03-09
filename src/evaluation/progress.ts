import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ConversationResult } from "./types.js";
import { getLogger } from "../logger.js";

const PROGRESS_FILE = ".agent-triage-progress.json";
const TEMP_SUFFIX = ".tmp";

interface ProgressData {
  policiesHash: string;
  completedConversations: Record<string, ConversationResult>;
  startedAt: string;
  lastUpdatedAt: string;
}

export function computePoliciesHash(policiesJson: string): string {
  return createHash("sha256").update(policiesJson).digest("hex");
}

export async function loadProgress(
  policiesHash: string,
): Promise<Map<string, ConversationResult> | null> {
  const progressPath = resolve(process.cwd(), PROGRESS_FILE);
  if (!existsSync(progressPath)) return null;

  try {
    const raw = await readFile(progressPath, "utf-8");
    const data: ProgressData = JSON.parse(raw);

    if (data.policiesHash !== policiesHash) {
      getLogger().warn(
        "Warning: policies.json has changed since the last run. " +
          "Discarding stale progress.\n",
      );
      await cleanupProgress();
      return null;
    }

    const map = new Map<string, ConversationResult>();
    for (const [id, result] of Object.entries(data.completedConversations)) {
      map.set(id, result);
    }

    return map;
  } catch {
    return null;
  }
}

let runStartedAt: string | null = null;

export async function saveProgress(
  policiesHash: string,
  completed: Map<string, ConversationResult>,
): Promise<void> {
  const progressPath = resolve(process.cwd(), PROGRESS_FILE);
  const tempPath = progressPath + TEMP_SUFFIX;

  // Preserve startedAt from first save of this run
  if (!runStartedAt) {
    runStartedAt = new Date().toISOString();
  }

  const data: ProgressData = {
    policiesHash,
    completedConversations: Object.fromEntries(completed),
    startedAt: runStartedAt,
    lastUpdatedAt: new Date().toISOString(),
  };

  // Atomic write: write to temp, then rename
  await writeFile(tempPath, JSON.stringify(data), "utf-8");
  await rename(tempPath, progressPath);
}

export async function cleanupProgress(): Promise<void> {
  const progressPath = resolve(process.cwd(), PROGRESS_FILE);
  const tempPath = progressPath + TEMP_SUFFIX;

  try {
    if (existsSync(progressPath)) await unlink(progressPath);
  } catch { /* ignore */ }

  try {
    if (existsSync(tempPath)) await unlink(tempPath);
  } catch { /* ignore */ }
}
