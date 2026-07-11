import { runDoctor } from "./doctor";
import { setupWorkspace } from "./setup";
import { parse } from "yaml";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityRegistry } from "../packages/storage/src/capabilities";
import { openDatabase } from "../packages/storage/src/database";
import { migrate } from "../packages/storage/src/migrate";

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
  if (command === "capabilities") {
    const db = openDatabase(join(process.cwd(), "workspace", "control-room.sqlite"));
    try {
      migrate(db);
      const registry = new CapabilityRegistry(db);
      registry.seed();
      const configured = parse(await readFile(join(process.cwd(), "workspace", "auto-apply.yml"), "utf8")) as { configured_mode?: string };
      console.log(JSON.stringify({ configured_mode: configured.configured_mode ?? "prepare_only", effective_mode: registry.getEffectiveMode(configured.configured_mode ?? "prepare_only"), capabilities: registry.list() }, null, 2));
    } finally {
      db.close();
    }
    return;
  }
  throw new Error("Usage: bun run scripts/cli.ts <setup|doctor|capabilities>");
}

await main();
