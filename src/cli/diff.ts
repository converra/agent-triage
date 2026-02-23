import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Report } from "../evaluation/types.js";
import { diffReports, formatDiffTerminal } from "../diff/diff.js";

interface DiffOptions {
  output?: string;
}

export async function diffCommand(
  beforePath: string,
  afterPath: string,
  options: DiffOptions,
): Promise<void> {
  const resolvedBefore = resolve(process.cwd(), beforePath);
  const resolvedAfter = resolve(process.cwd(), afterPath);

  if (!existsSync(resolvedBefore)) {
    console.error(`Error: File not found: ${resolvedBefore}`);
    process.exit(1);
  }
  if (!existsSync(resolvedAfter)) {
    console.error(`Error: File not found: ${resolvedAfter}`);
    process.exit(1);
  }

  const before: Report = JSON.parse(await readFile(resolvedBefore, "utf-8"));
  const after: Report = JSON.parse(await readFile(resolvedAfter, "utf-8"));

  const diff = diffReports(before, after);

  // Terminal output
  console.log("");
  console.log(formatDiffTerminal(diff));

  // Write diff.json
  const outputDir = resolve(process.cwd(), options.output ?? ".");
  const diffPath = resolve(outputDir, "diff.json");
  await writeFile(diffPath, JSON.stringify(diff, null, 2), "utf-8");
  console.log(`Diff written to ${diffPath}`);
}
