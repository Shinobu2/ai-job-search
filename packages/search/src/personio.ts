export type PersonioJob = { id: string; title: string; location: string | null; description: string };

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
