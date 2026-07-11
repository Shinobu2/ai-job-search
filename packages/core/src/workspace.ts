import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { WorkspaceSnapshot } from "./types";

const workspaceNames = ["profile", "evidence", "document-pack", "search", "auto-apply"] as const;
export type WorkspaceFileName = (typeof workspaceNames)[number];

const schemaDirectory = join(import.meta.dir, "../../../config/schemas");
const schemas = await Promise.all(
  ["common", ...workspaceNames].map(async (name) =>
    JSON.parse(await readFile(join(schemaDirectory, `${name}.schema.json`), "utf8")),
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of schemas) ajv.addSchema(schema);

export function validateWorkspaceFile(name: WorkspaceFileName, value: unknown): void {
  const validate = ajv.getSchema(`${name}.schema.json`);
  if (!validate) throw new Error(`Workspace schema is unavailable: ${name}`);
  if (!validate(value)) {
    throw new Error(`Invalid ${name}.yml: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}

export async function loadWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const entries = await Promise.all(
    workspaceNames.map(async (name) => {
      const value = parse(await readFile(join(root, "workspace", `${name}.yml`), "utf8"));
      validateWorkspaceFile(name, value);
      return [name, value] as const;
    }),
  );
  return Object.fromEntries(entries) as WorkspaceSnapshot;
}

export { workspaceNames };
