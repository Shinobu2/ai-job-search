import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { StorageRepository, StoredJob } from "../../storage/src/repository";
import type { ImportRequest, ImportedJob } from "./types";

type SourceInput = {
  rawContent: string;
  extractionText: string;
  rawHash: string;
  sourceType: string;
  sourceLocator?: string;
};

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);|&#(\d+);|&#x([\da-f]+);/gi, (entity, decimal?: string, hexadecimal?: string) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" } as Record<string, string>)[entity.toLowerCase()] ?? entity;
  });
}

function stylesheetHiddenClasses(raw: string): Set<string> {
  const classes = new Set<string>();
  for (const style of raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    for (const rule of style[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(?:^|;)\s*display\s*:\s*none\s*(?:!important\s*)?(?:;|$)/i.test(rule[2])) continue;
      for (const selector of rule[1].split(",")) {
        const match = selector.trim().match(/^\.([\w-]+)$/);
        if (match) classes.add(match[1]);
      }
    }
  }
  return classes;
}

function isHiddenElement(attributes: string, hiddenClasses: Set<string>): boolean {
  if (/(?:^|\s)hidden(?:\s|=|$)/i.test(attributes)) return true;
  if (/\bstyle\s*=\s*(["'])[^"']*\bdisplay\s*:\s*none\b[^"']*\1/i.test(attributes)) return true;
  const classes = attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2]?.split(/\s+/) ?? [];
  return classes.some((className) => hiddenClasses.has(className));
}

function removeHiddenHtml(raw: string, hiddenClasses: Set<string>): string {
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const elements: boolean[] = [];
  let hiddenDepth = 0;
  return raw.replace(/<[^>]+>|[^<]+/g, (token) => {
    const closing = token.match(/^<\s*\/\s*[\w:-]+[^>]*>$/);
    if (closing) {
      const hidden = elements.pop();
      if (hidden) {
        hiddenDepth--;
        return "";
      }
      return hiddenDepth ? "" : token;
    }
    const opening = token.match(/^<\s*([\w:-]+)\b([^>]*)>$/);
    if (!opening) return hiddenDepth ? "" : token;
    const hidden = hiddenDepth > 0 || isHiddenElement(opening[2], hiddenClasses);
    if (voidElements.has(opening[1].toLowerCase()) || /\/\s*>$/.test(token)) return hiddenDepth || hidden ? "" : token;
    elements.push(hidden);
    if (hidden) hiddenDepth++;
    return hidden ? "" : token;
  });
}

function visibleHtmlText(raw: string): string {
  const hiddenClasses = stylesheetHiddenClasses(raw);
  return decodeHtml(
    removeHiddenHtml(raw.replace(/<!--([\s\S]*?)-->/g, ""), hiddenClasses)
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\/?(?:p|div|h[1-6]|li|br|tr|section|article)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim(),
  );
}

function identity(text: string): Pick<ImportedJob, "title" | "company" | "location"> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labelled = (label: string): string | null => {
    const line = lines.find((candidate) => new RegExp(`^${label}\\s*:`, "i").test(candidate));
    return line ? line.replace(new RegExp(`^${label}\\s*:\\s*`, "i"), "").trim() || null : null;
  };
  const heading = lines.find((line) => /^#{1,6}\s+/.test(line));
  const title = labelled("title") ?? (heading ? heading.replace(/^#{1,6}\s+/, "").trim() : lines[0] ?? null);
  return { title, company: labelled("company"), location: labelled("location") };
}

async function sourceFrom(request: ImportRequest): Promise<SourceInput> {
  if ((request.text === undefined) === (request.file === undefined)) throw new Error("Provide exactly one of text or file");
  if (request.text !== undefined) {
    return { rawContent: request.text, extractionText: request.text, rawHash: hash(request.text), sourceType: "pasted_text", sourceLocator: request.sourceId ? `source-id:${request.sourceId}` : undefined };
  }

  const file = resolve(request.file as string);
  const extension = extname(file).toLowerCase();
  if (!new Set([".txt", ".md", ".html", ".htm"]).has(extension)) throw new Error(`Unsupported local file type: ${extension || "(none)"}`);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Local file does not exist: ${file}`);
    throw error;
  }
  const rawContent = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const extractionText = rawContent.replace(/^\ufeff/, "");
  const html = extension === ".html" || extension === ".htm";
  return {
    rawContent,
    extractionText: html ? visibleHtmlText(extractionText) : extractionText,
    rawHash: hash(bytes),
    sourceType: html ? "local_html" : extension === ".md" ? "local_markdown" : "local_text",
    sourceLocator: request.sourceId ? `source-id:${request.sourceId}` : file,
  };
}

function asImported(job: StoredJob, sourceHash: string, reused: boolean): ImportedJob {
  return { id: job.id, reused, sourceHash, title: job.title, company: job.company, location: job.location };
}

export async function importVacancy(request: ImportRequest, repository: StorageRepository): Promise<ImportedJob> {
  const source = await sourceFrom(request);
  const canonicalUrl = request.sourceUrl ? normalizeUrl(request.sourceUrl) : undefined;
  const values = identity(source.extractionText);
  const existing = (canonicalUrl ? repository.findJobByCanonicalUrl(canonicalUrl) : null)
    ?? (request.sourceId ? repository.findJobBySourceId(request.sourceId) : null)
    ?? (values.title && values.company && values.location ? repository.findJobByNormalizedTriple(values.title, values.company, values.location) : null)
    ?? repository.findJobByRawHash(source.rawHash);
  if (existing) return asImported(existing, source.rawHash, true);

  const sourceId = `source_${hash(`source:${source.rawHash}`)}`;
  const jobId = `job_${hash(`job:${source.rawHash}`)}`;
  repository.importJob({
    source: {
      id: sourceId,
      sourceType: source.sourceType,
      rawContent: source.rawContent,
      rawHash: source.rawHash,
      sourceLocator: source.sourceLocator,
      suppliedUrl: canonicalUrl,
      importedAt: new Date().toISOString(),
      provenance: [{ source_type: "local_import", source_ref: source.sourceLocator ?? "pasted_text" }],
    },
    job: {
      id: jobId,
      sourceId,
      title: values.title ?? undefined,
      company: values.company ?? undefined,
      location: values.location ?? undefined,
      rawSnapshotHash: source.rawHash,
      provenance: [{ source_type: "local_import", source_ref: source.sourceLocator ?? "pasted_text" }],
    },
  });
  return { id: jobId, reused: false, sourceHash: source.rawHash, ...values };
}
