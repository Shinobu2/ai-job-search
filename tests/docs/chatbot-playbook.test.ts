import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("chatbot playbook is self-contained for public search, JSON-LD import, and handoff", async () => {
  const playbook = await readFile(join(import.meta.dir, "../../docs/CHATBOT_PLAYBOOK.md"), "utf8");

  for (const template of [
    "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true",
    "https://api.lever.co/v0/postings/{slug}?mode=json",
    "https://{slug}.jobs.personio.com/xml?language=en",
    "https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true",
    "https://api.smartrecruiters.com/v1/companies/{slug}/postings",
    "https://{slug}.recruitee.com/api/offers",
    "https://www.arbeitnow.com/api/job-board-api?page={page}",
    "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/app/jobs",
    "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/{base64(referenznummer)}",
  ]) {
    expect(playbook).toContain(template);
  }

  expect(playbook).toContain("X-API-Key: jobboerse-jobsuche");
  expect(playbook).toContain('<script type="application/ld+json">');
  expect(playbook).toContain('"title": null');
  expect(playbook).toContain('"directApply": null');
  expect(playbook).toContain("handoff.md");
  expect(playbook).toContain("Ничего не выдумывай");
});
