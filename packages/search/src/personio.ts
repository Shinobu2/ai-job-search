export type PersonioJob = { id: string; title: string; location: string | null; description: string };
import type { EmployerRegistryEntry } from "./employer-registry";

function text(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim() : null;
}

export function parsePersonioXml(xml: string): PersonioJob[] {
  return [...xml.matchAll(/<position[^>]*>([\s\S]*?)<\/position>/gi)].flatMap((match) => {
    const body = match[1];
    const id = text(body, "id");
    const title = text(body, "name");
    if (!id || !title) return [];
    const descriptions = [...body.matchAll(/<jobDescription[^>]*>([\s\S]*?)<\/jobDescription>/gi)].map((entry) => text(entry[1], "value")).filter((value): value is string => Boolean(value));
    return [{ id, title, location: text(body, "office"), description: descriptions.join("\n") }];
  });
}

export async function readPersonioEmployer(employer: EmployerRegistryEntry, fetcher: typeof fetch = fetch): Promise<PersonioJob[]> {
  if (!employer.enabled || employer.policy !== "public_ats_endpoint" || employer.ats !== "personio") throw new Error(`Employer ${employer.id} is not approved for Personio reads`);
  const career = new URL(employer.career_url);
  if (career.protocol !== "https:" || !career.hostname.endsWith(".jobs.personio.de")) throw new Error(`Employer ${employer.id} has an invalid Personio endpoint`);
  const endpoint = new URL("/xml", career.origin);
  const response = await fetcher(endpoint, { headers: { Accept: "application/xml" }, redirect: "error" });
  if (!response.ok) throw new Error(`Personio read failed for ${employer.id}: ${response.status}`);
  return parsePersonioXml(await response.text());
}
