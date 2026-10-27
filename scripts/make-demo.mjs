import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdir, writeFile } from "node:fs/promises";

// Original fictional content: this fixture is safe to redistribute and tests
// headings, italic/bold text, long paragraphs, vector art, and multiple pages.
const doc = await PDFDocument.create();
const regular = await doc.embedFont(StandardFonts.TimesRoman);
const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
doc.setTitle("Small gardens, shared discoveries");
doc.setAuthor("The Paperform demonstration project");
let page, y;
function newPage() {
  page = doc.addPage([612, 792]);
  y = 725;
  page.drawText("PAPERFORM DEMONSTRATION / FICTIONAL RESEARCH", {
    x: 54,
    y: 774,
    size: 8,
    font: regular,
    color: rgb(0.5, 0.5, 0.5),
  });
  page.drawText(String(doc.getPageCount()), {
    x: 302,
    y: 15,
    size: 9,
    font: regular,
  });
}
function line(text, size = 11, font = regular) {
  page.drawText(text, { x: 54, y, size, font, color: rgb(0.16, 0.2, 0.17) });
  y -= size * 1.45;
}
function paragraph(text) {
  const words = text.split(" ");
  let row = "";
  for (const word of words) {
    if (regular.widthOfTextAtSize(row + " " + word, 11) > 500) {
      if (y < 65) newPage();
      line(row);
      row = word;
    } else row += (row ? " " : "") + word;
  }
  if (row) {
    if (y < 65) newPage();
    line(row);
  }
  y -= 12;
}
function heading(text) {
  if (y < 100) newPage();
  y -= 8;
  line(text, 13, bold);
  y -= 9;
}
newPage();
line("Small gardens, shared discoveries", 23, bold);
line("How everyday observation can bring a landscape into focus", 14, italic);
y -= 12;
line("Maya Reed, Theo Park, and the Neighborhood Field Group", 11);
y -= 13;
heading("Abstract");
paragraph(
  "This fictional paper demonstrates a browser-based reading layout. We describe a simple observation exercise across twelve neighborhood gardens, using repeated visits to record shade, flowering plants, and visiting insects. The exercise illustrates how consistent notes can make small changes easier to notice. All names, observations, and findings in this document are invented for demonstration. No scientific claims should be inferred from the example.",
);
heading("Introduction");
paragraph(
  "Research often begins with the patient act of looking. A familiar garden can hold more variation than a single visit reveals: light moves across a wall, flowers open at different hours, and the same patch of soil responds differently after rain. Keeping a record makes these ordinary changes available for comparison.",
);
paragraph(
  "Readable presentation helps readers follow an argument without changing its substance. A useful reading copy keeps the original wording, establishes a clear visual hierarchy, and gives figures enough space to be understood. This sample lets you compare the original single-column document with a newly typeset version.",
);
heading("Methods");
paragraph(
  "Twelve imaginary gardens were observed on four mornings. Each visit lasted twenty minutes. Observers noted the extent of shade, counted flowering patches, and recorded insect visits in a shared notebook. To keep the exercise consistent, all visits began within the same two-hour window. Observers reviewed their notes together after each round.",
);
paragraph(
  "The demonstration uses deliberately modest methods. It is designed to test paragraph reconstruction, heading detection, and page flow, rather than to support a biological conclusion. Longer paragraphs provide a useful check that the renderer continues text across columns without omitting words.",
);
newPage();
heading("Results");
paragraph(
  "Recorded visits increased over the four observation rounds in the fictional dataset (Figure 1). Gardens with more flowering patches showed more recorded visits, although the small invented sample cannot establish any relationship. The visual below is vector artwork, so the browser converter preserves it as a visual region for review.",
);
const cx = 85,
  cy = y - 180;
page.drawLine({
  start: { x: cx, y: cy },
  end: { x: cx + 420, y: cy },
  thickness: 1,
  color: rgb(0.6, 0.65, 0.6),
});
page.drawLine({
  start: { x: cx, y: cy },
  end: { x: cx, y: cy + 160 },
  thickness: 1,
  color: rgb(0.6, 0.65, 0.6),
});
for (let i = 0; i < 20; i++) {
  const h = 25 + i * 5 + (i % 3) * 12;
  page.drawRectangle({
    x: cx + 10 + i * 20,
    y: cy,
    width: 12,
    height: h,
    color: rgb(0.3 + i * 0.01, 0.46 + i * 0.009, 0.34 + i * 0.008),
  });
}
y = cy - 24;
line("Figure 1. Invented observations over repeated garden visits.", 10, bold);
y -= 7;
paragraph(
  "The chart is illustrative only. The converter preserves the chart and its labels together, making it possible to inspect the visual context alongside the reformatted text.",
);
heading("Discussion");
paragraph(
  "An effective reading tool should make its uncertainties visible. PDF documents describe positions on a page, not reliable paragraph boundaries or the meaning of a diagram. Reconstructing the article therefore requires interpretation. Readers should compare unfamiliar symbols, complex tables, and figure captions with the source before relying on a reformatted copy.",
);
paragraph(
  "The value of this exercise lies in a practical habit: preserve the source, inspect the result, and correct what needs attention. The downloadable manuscript lets you adjust the title or paragraph text and render a new version. This keeps the transformation reviewable while allowing a more comfortable reading experience.",
);
heading("References");
paragraph(
  "1. Neighborhood Field Group. A notebook for looking closely. Fictional demonstration material (2026).",
);
paragraph(
  "2. Paperform Project. Readable layouts for everyday research. Original sample text (2026).",
);
await mkdir("public", { recursive: true });
await writeFile("public/sample-paper.pdf", await doc.save());
console.log(`Created original sample PDF (${doc.getPageCount()} pages).`);
