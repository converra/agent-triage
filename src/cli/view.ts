import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";

interface ViewOptions {
  report?: string;
}

export async function viewCommand(options: ViewOptions): Promise<void> {
  const dir = resolve(process.cwd(), options.report ?? ".");
  const htmlPath = resolve(dir, "report.html");
  const jsonPath = resolve(dir, "report.json");

  if (existsSync(htmlPath)) {
    openInBrowser(htmlPath);
    return;
  }

  if (existsSync(jsonPath)) {
    console.error(
      "Error: report.html not found. Only report.json exists.\n" +
        "Re-run `agent-triage analyze` to generate the HTML report.",
    );
    process.exit(1);
  }

  console.error(
    "Error: No report found in this directory.\n" +
      "Run `agent-triage analyze` first.",
  );
  process.exit(1);
}

function openInBrowser(path: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", path]]
        : ["xdg-open", [path]];

  console.log(`Opening ${path}...`);
  execFile(cmd, args, (err) => {
    if (err) {
      console.log(`Could not open browser automatically. Open manually:\n  ${path}`);
    }
  });
}
