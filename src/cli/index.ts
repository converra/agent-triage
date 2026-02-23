#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./init.js";
import { analyzeCommand } from "./analyze.js";
import { viewCommand } from "./view.js";
import { diffCommand } from "./diff.js";
import { demoCommand } from "./demo.js";

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
  .name("converra-triage")
  .description(
    "Triage your AI agents — extract policies, evaluate conversations, generate diagnostic reports.",
  )
  .version("0.1.0");

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
  .description("Evaluate conversations against policies and generate report")
  .option("--traces <path>", "Path to JSON conversations file")
  .option("--langsmith <project>", "LangSmith project name")
  .option("--otel <path>", "Path to OTLP/JSON export file")
  .option("--policies <path>", "Path to policies.json", "policies.json")
  .option("-p, --prompt <path>", "Path to system prompt file (for evaluation accuracy)")
  .option("--provider <provider>", "LLM provider")
  .option("--model <model>", "LLM model")
  .option("--api-key <key>", "LLM API key")
  .option("--dry-run", "Show estimated cost without running evaluation")
  .option("--max-conversations <n>", "Maximum conversations to evaluate")
  .option("--include-prompt", "Include system prompt in report")
  .option("--summary-only", "Generate summary report without transcripts")
  .option("-o, --output <dir>", "Output directory", ".")
  .action(wrapAction(analyzeCommand));

program
  .command("view")
  .description("Open the generated HTML report in your browser")
  .option("-r, --report <dir>", "Directory containing report.html", ".")
  .action(wrapAction(viewCommand));

program
  .command("demo")
  .description("Run a demo with built-in example agents and traces")
  .argument("[example]", "Example to run (customer-support)", "customer-support")
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
