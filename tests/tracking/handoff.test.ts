import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const cli = join(root, "scripts", "cli.ts");

async function run(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  return {
    code,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

test("report handoff writes full private exports and only a sanitized tracked block", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-handoff-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  await cp(join(root, "CHATGPT_WORK_HANDOFF.md"), join(directory, "CHATGPT_WORK_HANDOFF.md"));
  try {
    const firstImport = await run(directory, [
      "job",
      "import",
      "--text",
      [
        "# Private Infrastructure Technician",
        "Company: Example GmbH",
        "Location: Secret Street 17, Frankfurt",
        "Contact: private@example.test",
      ].join("\n"),
    ]);
    const secondImport = await run(directory, [
      "job",
      "import",
      "--text",
      "# Confidential Support Role\nCompany: Other AG\nLocation: Hidden Address, Berlin",
    ]);
    expect(firstImport.code).toBe(0);
    expect(secondImport.code).toBe(0);
    const firstId = (JSON.parse(firstImport.stdout) as { id: string }).id;
    const secondId = (JSON.parse(secondImport.stdout) as { id: string }).id;

    expect((await run(directory, [
      "applications",
      "set",
      "--id",
      firstId,
      "--status",
      "shortlisted",
      "--next",
      "Call private@example.test about permit document",
      "--note",
      "Private event note",
    ])).code).toBe(0);
    expect((await run(directory, [
      "applications",
      "set",
      "--id",
      secondId,
      "--status",
      "shortlisted",
    ])).code).toBe(0);
    expect((await run(directory, [
      "applications",
      "set",
      "--id",
      secondId,
      "--status",
      "rejected",
      "--confirm",
      "--note",
      "Rejected after private document review",
    ])).code).toBe(0);

    const reported = await run(directory, ["report", "handoff"]);
    expect(reported.code).toBe(0);
    expect(JSON.parse(reported.stdout)).toMatchObject({
      vacancies: 2,
      applications: 2,
      json: "workspace/exports/handoff.json",
      markdown: "workspace/exports/handoff.md",
      public_handoff: "CHATGPT_WORK_HANDOFF.md",
    });

    const privateJson = JSON.parse(await readFile(
      join(directory, "workspace", "exports", "handoff.json"),
      "utf8",
    )) as {
      schema_version: number;
      vacancies: Array<{ jobId: string; title: string | null; company: string | null }>;
      applications: Array<{
        job_id: string;
        status: string;
        next_action: string | null;
        job: { title: string | null; company: string | null; location: string | null } | null;
        events: Array<{ status: string; actor: string; note: string | null }>;
      }>;
    };
    expect(privateJson.schema_version).toBe(1);
    expect(privateJson.vacancies).toHaveLength(2);
    expect(privateJson.applications).toHaveLength(2);
    expect(privateJson.applications.find(({ job_id: jobId }) => jobId === firstId)).toMatchObject({
      status: "shortlisted",
      next_action: "Call private@example.test about permit document",
      job: {
        title: "Private Infrastructure Technician",
        company: "Example GmbH",
        location: "Secret Street 17, Frankfurt",
      },
      events: [
        expect.objectContaining({
          status: "shortlisted",
          actor: "user",
          note: "Private event note",
        }),
      ],
    });
    expect(privateJson.applications.find(({ job_id: jobId }) => jobId === secondId)?.events).toHaveLength(2);

    const privateMarkdown = await readFile(
      join(directory, "workspace", "exports", "handoff.md"),
      "utf8",
    );
    expect(privateMarkdown).toContain("Private Infrastructure Technician");
    expect(privateMarkdown).toContain("Secret Street 17, Frankfurt");
    expect(privateMarkdown).toContain("Call private@example.test about permit document");
    expect(privateMarkdown).toContain("Private event note");

    const tracked = await readFile(join(directory, "CHATGPT_WORK_HANDOFF.md"), "utf8");
    const generated = tracked.match(
      /<!-- generated:status:start -->([\s\S]*?)<!-- generated:status:end -->/,
    )?.[1] ?? "";
    expect(generated).toContain("shortlisted: 1");
    expect(generated).toContain("rejected: 1");
    expect(generated).toContain(`Example GmbH — \`${firstId}\``);
    expect(generated).toContain(`Other AG — \`${secondId}\``);
    for (const privateValue of [
      "Private Infrastructure Technician",
      "Confidential Support Role",
      "Secret Street 17",
      "Hidden Address",
      "private@example.test",
      "permit",
      "document",
      "Private event note",
      "Rejected after private document review",
    ]) {
      expect(generated).not.toContain(privateValue);
    }
    expect(tracked).toContain("# ChatGPT Work handoff");
    expect(tracked.match(/<!-- generated:status:start -->/g)).toHaveLength(1);
    expect(tracked.match(/<!-- generated:status:end -->/g)).toHaveLength(1);

    expect((await run(directory, ["report", "handoff"])).code).toBe(0);
    const rerun = await readFile(join(directory, "CHATGPT_WORK_HANDOFF.md"), "utf8");
    expect(rerun.match(/<!-- generated:status:start -->/g)).toHaveLength(1);
    expect(rerun.match(/<!-- generated:status:end -->/g)).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("report handoff refuses to rewrite a tracked file without both markers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-handoff-markers-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  await writeFile(
    join(directory, "CHATGPT_WORK_HANDOFF.md"),
    "# Public handoff\n<!-- generated:status:start -->\n",
  );
  try {
    const reported = await run(directory, ["report", "handoff"]);
    expect(reported.code).toBe(1);
    expect(reported.stderr).toContain("exactly one generated status marker pair");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});
