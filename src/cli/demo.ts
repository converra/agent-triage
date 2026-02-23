import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeCommand } from "./analyze.js";

const EXAMPLES = ["customer-support"] as const;
type ExampleName = (typeof EXAMPLES)[number];

const EXAMPLE_DESCRIPTIONS: Record<ExampleName, string> = {
  "customer-support": "Acme Electronics support agent — escalation, refund rules, tone policies",
};

interface DemoOptions {
  provider?: string;
  model?: string;
  apiKey?: string;
}

export async function demoCommand(
  example: string | undefined,
  options: DemoOptions,
): Promise<void> {
  const name = (example ?? "customer-support") as ExampleName;

  if (!EXAMPLES.includes(name as ExampleName)) {
    console.error(`Unknown example: ${name}`);
    console.error(`\nAvailable examples:`);
    for (const ex of EXAMPLES) {
      console.error(`  ${ex} — ${EXAMPLE_DESCRIPTIONS[ex]}`);
    }
    process.exit(1);
  }

  console.log(`\nRunning demo: ${name}`);
  console.log(`  ${EXAMPLE_DESCRIPTIONS[name]}\n`);

  // Resolve example files — bundled in data/examples/
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), `../../data/examples/${name}`);

  if (!existsSync(srcDir)) {
    console.error(`Error: Demo data not found for "${name}".`);
    console.error("If installed via npm, please update to the latest version.");
    console.error("If running from source, ensure data/examples/ exists.");
    process.exit(1);
  }

  // Set up a temp output directory
  const outputDir = resolve(process.cwd(), `.agent-triage-demo-${name}`);
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  // Copy fixtures to output dir
  const promptSrc = resolve(srcDir, "prompt.txt");
  const tracesSrc = resolve(srcDir, "conversations.json");
  const policiesSrc = resolve(srcDir, "policies.json");

  const promptDst = resolve(outputDir, "prompt.txt");
  const tracesDst = resolve(outputDir, "conversations.json");
  const policiesDst = resolve(outputDir, "policies.json");

  await cp(promptSrc, promptDst);
  await cp(tracesSrc, tracesDst);
  await cp(policiesSrc, policiesDst);

  const policiesData = JSON.parse(await readFile(policiesDst, "utf-8")) as unknown[];
  console.log(`  Copied demo files to ${outputDir}`);
  console.log(`  Using pre-extracted policies (${policiesData.length} policies from customer-support prompt)\n`);

  // Run the analyze pipeline
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
