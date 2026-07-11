import { runDoctor } from "./doctor";
import { setupWorkspace } from "./setup";

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "setup") {
    console.log(JSON.stringify(await setupWorkspace(process.cwd()), null, 2));
    return;
  }
  if (command === "doctor") {
    const report = await runDoctor(process.cwd(), arguments_.includes("--strict"));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.errors.length ? 1 : 0;
    return;
  }
  throw new Error("Usage: bun run scripts/cli.ts <setup|doctor>");
}

await main();
