import { expect, test } from "bun:test";
import JSZip from "jszip";
import { buildAtsDocx, lintAtsDocx, type AtsDocumentModel } from "../../packages/documents/src/ats-docx";

const model: AtsDocumentModel = {
  language: "en",
  name: "Candidate",
  email: "candidate@example.com",
  phone: "+49000",
  title: "Data Center Technician",
  company: "Example DC",
  evidence: ["Personal hardware troubleshooting experience."],
  verify: ["INTERNAL: work authorisation must be confirmed"],
  availability: "Available immediately.",
};

test("ATS DOCX keeps internal verification notes out of candidate-facing content", async () => {
  const bytes = await buildAtsDocx(model);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  expect(xml).not.toContain("INTERNAL: work authorisation must be confirmed");
});

test("ATS QA fails closed when the generated document is not a complete CV", async () => {
  const bytes = await buildAtsDocx(model);
  const qa = await lintAtsDocx(bytes, model);
  expect(qa.checks).toContainEqual(expect.objectContaining({ id: "complete_cv", status: "fail" }));
});

test("ATS QA detects symbol/icon XML and contacts in footers", async () => {
  const bytes = await buildAtsDocx(model);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  zip.file("word/document.xml", xml.replace("</w:body>", '<w:p><w:r><w:sym w:font="Wingdings" w:char="F0A7"/><w:drawing/></w:r></w:p></w:body>'));
  zip.file("word/footer1.xml", '<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>candidate@example.com</w:t></w:r></w:p></w:ftr>');
  const mutated = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  const qa = await lintAtsDocx(mutated, model);
  expect(qa.checks).toContainEqual(expect.objectContaining({ id: "forbidden_glyphs", status: "fail" }));
  expect(qa.checks).toContainEqual(expect.objectContaining({ id: "forbidden_layout", status: "fail" }));
  expect(qa.checks).toContainEqual(expect.objectContaining({ id: "header_footer_contacts", status: "fail" }));
});
