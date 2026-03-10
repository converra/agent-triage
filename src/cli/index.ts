#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { initCommand } from "./init.js";
import { analyzeCommand } from "./analyze.js";
import { viewCommand } from "./view.js";
import { diffCommand } from "./diff.js";
import { demoCommand } from "./demo.js";
import { explainCommand } from "./explain.js";
import { checkCommand } from "./check.js";
import { statusCommand } from "./status.js";
import { historyCommand } from "./history.js";
import { setLogger, consoleLogger } from "../logger.js";

setLogger(consoleLogger);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as { version: string };

function wrapAction<T extends (...args: never[]) => Promise<void>>(fn: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      await fn(...args);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`\nError: ${msg}`);
      process.exit(1);
    }
  }) as T;
}

const program = new Command();

program
  .name("agent-triage")
  .description(
    "Diagnose your AI agents in production — extract behavioral policies from your prompt, evaluate traces against them, and generate diagnostic reports.",
  )
  .version(pkg.version);

program
  .command("init")
  .description("Extract testable policies from your agent's system prompt")
  .option("-p, --prompt <path>", "Path to the system prompt file")
  .option("-o, --output <path>", "Output path for policies.json", "policies.json")
  .option("--provider <provider>", "LLM provider (openai, anthropic, openai-compatible)")
  .option("--model <model>", "LLM model to use")
  .option("--api-key <key>", "LLM API key (or set env var)")
  .action(wrapAction(initCommand));

program
  .command("analyze")
  .description("Evaluate traces against policies and generate report")
  .option("--traces <path>", "Path to JSON traces file")
  .option("--langsmith <project>", "LangSmith project name")
  .option("--langsmith-api-key <key>", "LangSmith API key (or set LANGSMITH_API_KEY)")
  .option("--otel <path>", "Path to OTLP/JSON export file")
  .option("--axiom <dataset>", "Axiom dataset name")
  .option("--axiom-api-key <key>", "Axiom API key (or set AXIOM_API_KEY)")
  .option("--axiom-org-id <id>", "Axiom org ID (for personal access tokens)")
  .option("--langfuse", "Langfuse (reads all traces, or set LANGFUSE_HOST for self-hosted)")
  .option("--langfuse-public-key <key>", "Langfuse public key (or set LANGFUSE_PUBLIC_KEY)")
  .option("--langfuse-secret-key <key>", "Langfuse secret key (or set LANGFUSE_SECRET_KEY)")
  .option("--langfuse-host <url>", "Langfuse host (default: https://cloud.langfuse.com)")
  .option("--policies <path>", "Path to policies.json", "policies.json")
  .option("-p, --prompt <path>", "Path to system prompt file (for evaluation accuracy)")
  .option("--provider <provider>", "LLM provider")
  .option("--model <model>", "LLM model")
  .option("--api-key <key>", "LLM API key")
  .option("--dry-run", "Show estimated cost without running evaluation")
  .option("--max-conversations <n>", "Maximum traces to evaluate")
  .option("--include-prompt", "Include system prompt in report")
  .option("--summary-only", "Generate summary report without trace transcripts")
  .option("-o, --output <dir>", "Output directory", ".")
  .option("--since <duration>", "Only include traces after this time (e.g. 2h, 24h, 7d)")
  .option("--until <duration>", "Only include traces before this time")
  .option("--agent <name>", "Filter to a specific agent by name")
  .option("--quick", "Skip diagnosis and fix generation (faster, cheaper)")
  .option("--format <format>", "Output format: terminal (default), json")
  .action(wrapAction(analyzeCommand));

program
  .command("explain [conversation-id]")
  .description("Deep-dive diagnosis of a single conversation")
  .option("--worst", "Explain the worst conversation from the last report")
  .option("--langsmith <project>", "LangSmith project name (to fetch conversation)")
  .option("--langsmith-api-key <key>", "LangSmith API key (or set LANGSMITH_API_KEY)")
  .option("--traces <path>", "Path to JSON traces file")
  .option("--otel <path>", "Path to OTLP/JSON export file")
  .option("--axiom <dataset>", "Axiom dataset name")
  .option("--axiom-api-key <key>", "Axiom API key (or set AXIOM_API_KEY)")
  .option("--axiom-org-id <id>", "Axiom org ID (for personal access tokens)")
  .option("--langfuse", "Langfuse (reads all traces, or set LANGFUSE_HOST for self-hosted)")
  .option("--langfuse-public-key <key>", "Langfuse public key (or set LANGFUSE_PUBLIC_KEY)")
  .option("--langfuse-secret-key <key>", "Langfuse secret key (or set LANGFUSE_SECRET_KEY)")
  .option("--langfuse-host <url>", "Langfuse host (default: https://cloud.langfuse.com)")
  .option("--policies <path>", "Path to policies.json", "policies.json")
  .option("-p, --prompt <path>", "Path to system prompt file")
  .option("--provider <provider>", "LLM provider")
  .option("--model <model>", "LLM model")
  .option("--api-key <key>", "LLM API key")
  .option("--since <duration>", "Time filter for trace source")
  .option("--agent <name>", "Agent filter")
  .option("--format <format>", "Output format: terminal (default), json")
  .action(wrapAction(explainCommand));

program
  .command("check")
  .description("Targeted policy compliance check (no metrics, faster than analyze)")
  .option("--traces <path>", "Path to JSON traces file")
  .option("--langsmith <project>", "LangSmith project name")
  .option("--langsmith-api-key <key>", "LangSmith API key (or set LANGSMITH_API_KEY)")
  .option("--otel <path>", "Path to OTLP/JSON export file")
  .option("--axiom <dataset>", "Axiom dataset name")
  .option("--axiom-api-key <key>", "Axiom API key (or set AXIOM_API_KEY)")
  .option("--axiom-org-id <id>", "Axiom org ID (for personal access tokens)")
  .option("--langfuse", "Langfuse (reads all traces, or set LANGFUSE_HOST for self-hosted)")
  .option("--langfuse-public-key <key>", "Langfuse public key (or set LANGFUSE_PUBLIC_KEY)")
  .option("--langfuse-secret-key <key>", "Langfuse secret key (or set LANGFUSE_SECRET_KEY)")
  .option("--langfuse-host <url>", "Langfuse host (default: https://cloud.langfuse.com)")
  .option("--policies <path>", "Path to policies.json", "policies.json")
  .option("--policy <id>", "Check specific policy (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option("-p, --prompt <path>", "Path to system prompt file")
  .option("--provider <provider>", "LLM provider")
  .option("--model <model>", "LLM model")
  .option("--api-key <key>", "LLM API key")
  .option("--since <duration>", "Only include traces after this time (e.g. 2h, 24h, 7d)")
  .option("--until <duration>", "Only include traces before this time")
  .option("--agent <name>", "Filter to a specific agent by name")
  .option("--max-conversations <n>", "Maximum traces to check")
  .option("--threshold <n>", "Exit with code 1 if compliance below this % (for CI)")
  .option("--format <format>", "Output format: terminal (default), json")
  .action(wrapAction(checkCommand));

program
  .command("status")
  .description("Quick health check from the last report (zero LLM cost)")
  .option("-r, --report <dir>", "Directory containing report.json", ".")
  .option("--format <format>", "Output format: terminal (default), json")
  .action(wrapAction(statusCommand));

program
  .command("history")
  .description("Show run history — compliance trends across analyze runs")
  .option("-r, --report <dir>", "Directory containing .triage-history.jsonl", ".")
  .option("--last <n>", "Show only the last N runs")
  .option("--format <format>", "Output format: terminal (default), json")
  .action(wrapAction(historyCommand));

program
  .command("view")
  .description("Open the generated HTML report in your browser")
  .option("-r, --report <dir>", "Directory containing report.html", ".")
  .action(wrapAction(viewCommand));

program
  .command("demo [example]")
  .description("Run a demo with built-in example agents and traces")
  .option("--provider <provider>", "LLM provider")
  .option("--model <model>", "LLM model")
  .option("--api-key <key>", "LLM API key")
  .action(wrapAction(demoCommand));

program
  .command("diff")
  .description("Compare two report.json files to see what changed")
  .argument("<before>", "Path to the before report.json")
  .argument("<after>", "Path to the after report.json")
  .option("-o, --output <dir>", "Output directory for diff.json", ".")
  .action(wrapAction(diffCommand));

program.parse();

if (!process.argv.slice(2).length) {
  program.outputHelp();
  console.log("\n  Try `agent-triage demo` to get started.\n");
}
