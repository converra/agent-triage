#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./init.js";
import { analyzeCommand } from "./analyze.js";

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
  .action(initCommand);

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
  .action(analyzeCommand);

program.parse();
