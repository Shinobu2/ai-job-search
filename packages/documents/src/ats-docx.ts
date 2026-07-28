import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import JSZip from "jszip";

export type AtsDocumentModel = {
  language: "en" | "de";
  name: string | null;
  email: string | null;
  phone: string | null;
  title: string;
  company: string;
  evidence: string[];
  verify: string[];
  workAuthorization: string | null;
  availability: string | null;
  summary?: string | null;
  professionalExperience?: string[];
  skills?: string[];
  education?: string[];
  languages?: string[];
};

export type DocumentQaCheck = {
  id: "file_opens" | "contacts_found" | "extracted_text" | "section_order" | "forbidden_glyphs"
    | "forbidden_layout" | "header_footer_contacts" | "length" | "evidence_terms" | "complete_cv";
  status: "pass" | "warn" | "fail";
  message: string;
};

export type DocumentQa = {
  format: "docx";
  language: "en" | "de";
  checks: DocumentQaCheck[];
};

function heading(text: string, level: typeof HeadingLevel.HEADING_1 | typeof HeadingLevel.HEADING_2): Paragraph {
  return new Paragraph({ text, heading: level, spacing: { before: 180, after: 80 } });
}

function body(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, size: 22 })], spacing: { after: 80 } });
}

function bullets(values: string[]): Paragraph[] {
  return values.map((value) => new Paragraph({
    children: [new TextRun({ text: `• ${value}`, font: "Arial", size: 22 })],
    spacing: { after: 60 },
  }));
}

export async function buildAtsDocx(model: AtsDocumentModel): Promise<Uint8Array> {
  const labels = model.language === "de"
    ? { contacts: "Kontakt", target: "Zielposition", summary: "Kurzprofil", experience: "Berufserfahrung", skills: "Kernkompetenzen", education: "Ausbildung", languages: "Sprachen", evidence: "Nachweisbare Kompetenzen" }
    : { contacts: "Contact", target: "Target role", summary: "Professional Summary", experience: "Professional Experience", skills: "Core Skills", education: "Education", languages: "Languages", evidence: "Evidence-backed capabilities" };
  const contacts = [model.email, model.phone].filter((value): value is string => Boolean(value));
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: model.name ?? "", bold: true, size: 34 })],
      spacing: { after: 80 },
    }),
    heading(labels.contacts, HeadingLevel.HEADING_1),
    body(contacts.join(" | ")),
  ];
  if (model.workAuthorization) children.push(body(model.workAuthorization));
  children.push(heading(labels.target, HeadingLevel.HEADING_1), body(`${model.title} — ${model.company}`));
  if (model.summary) children.push(heading(labels.summary, HeadingLevel.HEADING_1), body(model.summary));
  if (model.professionalExperience?.length) children.push(heading(labels.experience, HeadingLevel.HEADING_1), ...bullets(model.professionalExperience));
  if (model.skills?.length) children.push(heading(labels.skills, HeadingLevel.HEADING_1), ...bullets(model.skills));
  if (model.education?.length) children.push(heading(labels.education, HeadingLevel.HEADING_1), ...bullets(model.education));
  if (model.languages?.length) children.push(heading(labels.languages, HeadingLevel.HEADING_1), ...bullets(model.languages));
  children.push(heading(labels.evidence, HeadingLevel.HEADING_1), ...bullets(model.evidence));
  if (model.availability) {
    children.push(heading(model.language === "de" ? "Verfügbarkeit" : "Availability", HeadingLevel.HEADING_2), body(model.availability));
  }
  const document = new Document({
    sections: [{ properties: {}, children }],
    styles: {
      default: {
        document: { run: { font: "Arial", size: 22 } },
        heading1: { run: { font: "Arial", size: 26, bold: true } },
        heading2: { run: { font: "Arial", size: 23, bold: true } },
      },
    },
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function textFromDocumentXml(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function lintAtsDocx(bytes: Uint8Array, model: AtsDocumentModel): Promise<DocumentQa> {
  const checks: DocumentQaCheck[] = [];
  let zip: JSZip;
  let documentXml = "";
  try {
    zip = await JSZip.loadAsync(bytes);
    documentXml = await zip.file("word/document.xml")!.async("string");
    checks.push({ id: "file_opens", status: "pass", message: "DOCX package opens and contains word/document.xml." });
  } catch (error) {
    return {
      format: "docx",
      language: model.language,
      checks: [{ id: "file_opens", status: "fail", message: `DOCX package cannot be read: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  const text = textFromDocumentXml(documentXml);
  const xmlNames = Object.keys(zip.files).filter((name) => /^word\/.*\.xml$/i.test(name));
  const allWordXml = (await Promise.all(xmlNames.map(async (name) => await zip.file(name)!.async("string")))).join("\n");
  const contacts = [model.name, model.email, model.phone].filter((value): value is string => Boolean(value));
  checks.push({
    id: "contacts_found",
    status: contacts.length === 3 && contacts.every((value) => text.includes(value)) ? "pass" : "fail",
    message: contacts.length === 3 && contacts.every((value) => text.includes(value))
      ? "Verified name, email and phone are present in the document body."
      : "One or more verified body contacts are missing.",
  });
  checks.push({
    id: "extracted_text",
    status: text.length >= 80 ? "pass" : "fail",
    message: `Extracted body text contains ${text.length} characters.`,
  });
  const labels = model.language === "de"
    ? ["Kontakt", "Zielposition", "Nachweisbare Kompetenzen"]
    : ["Contact", "Target role", "Evidence-backed capabilities"];
  const positions = labels.map((label) => text.indexOf(label));
  checks.push({
    id: "section_order",
    status: positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]) ? "pass" : "fail",
    message: "Contact, target role and evidence sections are checked in reading order.",
  });
  checks.push({
    id: "forbidden_glyphs",
    status: /[\uE000-\uF8FF]/u.test(text) || /<w:sym\b|w:(?:ascii|hAnsi)="(?:Wingdings|Symbol)"/i.test(allWordXml) ? "fail" : "pass",
    message: "Private-use characters, symbol runs and forbidden symbol fonts checked across Word XML.",
  });
  const forbiddenLayout = /<w:tbl\b|<w:txbxContent\b|<w:drawing\b|<w:pict\b|<(?:wps|v):/i.test(allWordXml);
  checks.push({
    id: "forbidden_layout",
    status: forbiddenLayout ? "fail" : "pass",
    message: "Tables, text boxes, drawings and icon containers checked across Word XML.",
  });
  const headerFooterNames = Object.keys(zip.files).filter((name) => /^word\/(?:header|footer)\d+\.xml$/i.test(name));
  const headerFooterText = (await Promise.all(headerFooterNames.map(async (name) => textFromDocumentXml(await zip.file(name)!.async("string"))))).join(" ");
  checks.push({
    id: "header_footer_contacts",
    status: contacts.some((value) => headerFooterText.includes(value)) ? "fail" : "pass",
    message: "No critical contact data is stored in headers or footers.",
  });
  const words = text.split(/\s+/).filter(Boolean).length;
  checks.push({
    id: "length",
    status: words < 60 || words > 1100 ? "warn" : "pass",
    message: `${words} extracted words; warning range is below 60 or above 1100.`,
  });
  const missingEvidence = model.evidence.filter((statement) => !text.includes(statement));
  checks.push({
    id: "evidence_terms",
    status: missingEvidence.length === 0 && model.evidence.length > 0 ? "pass" : "fail",
    message: missingEvidence.length === 0
      ? `${model.evidence.length} evidence-backed statements are present.`
      : `${missingEvidence.length} evidence-backed statements are missing.`,
  });
  const completeCv = Boolean(
    model.summary?.trim()
    && model.professionalExperience?.length
    && model.skills?.length
    && model.education?.length
    && model.languages?.length,
  );
  checks.push({
    id: "complete_cv",
    status: completeCv ? "pass" : "fail",
    message: completeCv
      ? "Summary, professional experience, skills, education and languages are present."
      : "Document is an evidence-safe draft, not a complete CV: one or more required CV sections are missing.",
  });
  return { format: "docx", language: model.language, checks };
}
