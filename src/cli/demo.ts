import { readFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveLlm } from "../config/loader.js";
import { analyzeCommand } from "./analyze.js";

const EXAMPLE = "customer-support";
const EXAMPLE_DESCRIPTION = "Acme Electronics support agent — escalation, refund rules, tone policies";

interface DemoOptions {
  provider?: string;
  model?: string;
  apiKey?: string;
}

export async function demoCommand(options: DemoOptions): Promise<void> {
  // Check for API key before doing anything else
  const config = await loadConfig({
    llm: {
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    },
  });
  await resolveLlm(config); // throws early if no key found

  console.log(`\nRunning demo: ${EXAMPLE}`);
  console.log(`  ${EXAMPLE_DESCRIPTION}\n`);

  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), `../../data/examples/${EXAMPLE}`);

  if (!existsSync(srcDir)) {
    console.error(`Error: Demo data not found.`);
    console.error("If installed via npm, please update to the latest version.");
    console.error("If running from source, ensure data/examples/ exists.");
    process.exit(1);
  }

  const outputDir = resolve(process.cwd(), `.agent-triage-demo-${EXAMPLE}`);
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  const promptDst = resolve(outputDir, "prompt.txt");
  const tracesDst = resolve(outputDir, "conversations.json");
  const policiesDst = resolve(outputDir, "policies.json");

  await cp(resolve(srcDir, "prompt.txt"), promptDst);
  await cp(resolve(srcDir, "conversations.json"), tracesDst);
  await cp(resolve(srcDir, "policies.json"), policiesDst);

  const policiesData = JSON.parse(await readFile(policiesDst, "utf-8")) as unknown[];
  console.log(`  Copied demo files to ${outputDir}`);
  console.log(`  Using pre-extracted policies (${policiesData.length} policies from ${EXAMPLE} prompt)\n`);

  await analyzeCommand({
    traces: tracesDst,
    policies: policiesDst,
    prompt: promptDst,
    provider: options.provider,
    model: options.model,
    apiKey: options.apiKey,
    output: outputDir,
  });
}
