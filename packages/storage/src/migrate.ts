import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

export interface MigrationSummary {
  applied: string[];
}
interface Migration {
  name: string;
  contents: string;
  checksum: string;
}

function migrations(): Migration[] {
  const directory = join(import.meta.dir, "../migrations");
  return readdirSync(directory)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const contents = readFileSync(join(directory, name), "utf8");
      return { name, contents, checksum: createHash("sha256").update(contents).digest("hex") };
    });
}

export function migrate(db: Database): MigrationSummary {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied: string[] = [];
  for (const migration of migrations()) {
    const stored = db.query("SELECT checksum FROM schema_migrations WHERE name = ?").get(migration.name) as
      | { checksum: string }
      | null;
    if (stored) {
      if (stored.checksum !== migration.checksum) {
        throw new Error(`Migration checksum mismatch for ${migration.name}`);
      }
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(migration.contents);
      db.query("INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)").run(
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
    });
    apply.immediate();
    applied.push(migration.name);
  }
  return { applied };
}
