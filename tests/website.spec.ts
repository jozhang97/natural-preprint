import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import AxeBuilder from "@axe-core/playwright";
import { createServer } from "node:http";
import { join, extname } from "node:path";

test("sample converts locally, previews, downloads, and edits round-trip", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const external: string[] = [];
  page.on("request", (request) => {
    if (
      !request.url().startsWith("http://127.0.0.1:4186") &&
      !request.url().startsWith("blob:") &&
      !request.url().startsWith("data:")
    )
      external.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Start with a paper.",
  );
  await page.getByRole("button", { name: "Try a sample" }).click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#output-canvas")).toBeVisible();
  await expect(page.locator("#result-summary")).toContainText(
    "2 original pages",
  );
  await expect(page.locator("#error")).toBeHidden();
  const reportEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report" }).click();
  const reportDownload = await reportEvent;
  const report = JSON.parse(
    await readFile((await reportDownload.path())!, "utf8"),
  );
  expect(report.blocks).toBeGreaterThan(10);
  expect(report.visual_regions).toBeGreaterThan(0);
  expect(report.missing_glyphs).toEqual([]);
  expect(report.text_check.checked_blocks).toBeGreaterThan(10);
  expect(report.text_check.unmatched_blocks).toEqual([]);
  const pdfEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download PDF", exact: false })
    .click();
  const pdfDownload = await pdfEvent;
  const pdf = await PDFDocument.load(
    await readFile((await pdfDownload.path())!),
  );
  expect(pdf.getPageCount()).toBe(report.output_pages);
  expect(pdf.getTitle()).toBe("Small gardens, shared discoveries");
  await page.getByRole("button", { name: "Next original page" }).click();
  await expect(page.locator("#original-page")).toHaveText("Page 2 of 2");
  await page.getByRole("button", { name: "Edit manuscript" }).click();
  const editor = page.locator("#manifest-editor");
  const manuscript = JSON.parse(await editor.inputValue());
  manuscript.metadata.title = "A corrected reading title";
  manuscript.blocks[0].text = "Edited author line for the round-trip test.";
  await editor.fill(JSON.stringify(manuscript));
  await page.getByRole("button", { name: "Render changes" }).click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
  const updatedEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  const updated = await updatedEvent;
  expect(
    (
      await PDFDocument.load(await readFile((await updated.path())!))
    ).getTitle(),
  ).toBe("A corrected reading title");
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("main screens meet automated accessibility checks", async ({ page }) => {
  await page.goto("/");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Try a sample" }).click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Edit manuscript" }).click();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});

for (const rotation of [0, 90, 180, 270])
  test(`native figure artwork is preserved at ${rotation} degree page rotation`, async ({
    page,
  }) => {
    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
    pdfPage.drawText("An image preservation example", {
      x: 54,
      y: 720,
      size: 22,
      font: bold,
    });
    pdfPage.drawText("Abstract", { x: 54, y: 675, size: 13, font: bold });
    for (let i = 0; i < 5; i++)
      pdfPage.drawText(
        `Observation ${i + 1}: the source image below should appear in the new reading copy.`,
        { x: 54, y: 650 - i * 16, size: 11, font },
      );
    pdfPage.setRotation(degrees(rotation));
    // A real raster image with large placement dimensions exercises operator transforms.
    const image = await doc.embedPng(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    pdfPage.drawImage(image, { x: 80, y: 320, width: 350, height: 180 });
    pdfPage.drawText("Native vector label", { x: 100, y: 400, size: 10, font });
    pdfPage.drawLine({
      start: { x: 100, y: 380 },
      end: { x: 300, y: 380 },
      thickness: 0.2,
    });
    pdfPage.drawText("Figure 1. A raster figure retained from the source.", {
      x: 54,
      y: 290,
      size: 11,
      font,
    });
    await page.goto("/");
    await page.locator("#file-input").setInputFiles({
      name: "image.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(await doc.save()),
    });
    await page.locator("#convert-button").click();
    await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#result-summary")).toContainText(
      "1 visual regions preserved",
    );
    const event = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download manuscript JSON" })
      .click();
    const download = await event;
    const m = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(m.floats[0].kind).toBe("figure");
    expect(m.floats[0].bbox).toEqual(
      {
        0: [80, 292, 430, 472],
        90: [320, 80, 500, 430],
        180: [182, 320, 532, 500],
        270: [292, 182, 472, 532],
      }[rotation],
    );
    const pdfEvent = page.waitForEvent("download");
    await page.locator("#download-pdf").click();
    const task = getDocument({
      data: new Uint8Array(await readFile((await (await pdfEvent).path())!)),
      useSystemFonts: true,
    });
    try {
      const output = await task.promise;
      let nativeLabel = false;
      const rasterSizes: number[][] = [];
      for (let n = 1; n <= output.numPages; n++) {
        const p = await output.getPage(n);
        const text = await p.getTextContent({ includeMarkedContent: true });
        let inArtwork = false;
        for (const item of text.items) {
          if ("tag" in item && item.tag === "PaperformVisual") inArtwork = true;
          if (
            "str" in item &&
            inArtwork &&
            item.str.includes("Native vector label")
          )
            nativeLabel = true;
        }
        const ops = await p.getOperatorList();
        for (let i = 0; i < ops.fnArray.length; i++)
          if (ops.fnArray[i] === OPS.paintImageXObject)
            rasterSizes.push(ops.argsArray[i].slice(1, 3));
      }
      expect(nativeLabel).toBe(true);
      expect(rasterSizes).toContainEqual([1, 1]);
      expect(rasterSizes.every(([w, h]) => w === 1 && h === 1)).toBe(true);
    } finally {
      await task.destroy();
    }
  });

test("production assets and conversion work under a GitHub Pages repository path", async ({
  page,
}) => {
  const prefix = "/paper-reformatter/";
  const missing: string[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    if (!path.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const relative = path.slice(prefix.length) || "index.html";
    try {
      const body = await readFile(join(process.cwd(), "dist", relative));
      const types: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".css": "text/css",
        ".ttf": "font/ttf",
        ".pdf": "application/pdf",
        ".svg": "image/svg+xml",
        ".wasm": "application/wasm",
      };
      res
        .writeHead(200, {
          "Content-Type":
            types[extname(relative)] || "application/octet-stream",
        })
        .end(body);
    } catch {
      missing.push(relative);
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await page.goto(`http://127.0.0.1:${port}${prefix}`);
    await page.getByRole("button", { name: "Try a sample" }).click();
    await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#output-canvas")).toBeVisible();
    expect(missing).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("file selection, keyboard tabs, malformed PDFs, and CORS errors", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#convert-button")).toBeDisabled();
  await page.locator("#file-input").setInputFiles({
    name: "bad.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a PDF"),
  });
  await page.locator("#convert-button").click();
  await expect(page.locator("#error")).toContainText("not a PDF");
  await page.getByRole("tab", { name: "Upload PDF" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Paste a link" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.locator("#pdf-url").fill("https://blocked.example/paper.pdf");
  await page.route("https://blocked.example/**", (route) =>
    route.abort("failed"),
  );
  await page.locator("#convert-button").click();
  await expect(page.locator("#error")).toContainText("CORS");
  await page.locator("#pdf-url").fill("http://insecure.example/paper.pdf");
  await page.locator("#convert-button").click();
  await expect(page.locator("#error")).toContainText("HTTPS");
});

test("a direct PDF link converts and cancellation recovers", async ({
  page,
}) => {
  const sample = await readFile("public/sample-paper.pdf");
  await page.goto("/");
  await page.getByRole("tab", { name: "Paste a link" }).click();
  await page.locator("#pdf-url").fill("https://papers.example/direct.pdf");
  await page.route("https://papers.example/direct.pdf", (route) =>
    route.fulfill({ contentType: "application/pdf", body: sample }),
  );
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Start another paper" }).click();
  await page.route("**/sample-paper.pdf", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route
      .fulfill({ contentType: "application/pdf", body: sample })
      .catch(() => {});
  });
  await page.getByRole("button", { name: "Try a sample" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#progress-section")).toBeHidden();
  await expect(page.locator("#error")).toBeHidden();
});

test("scans and invalid manifest crops are rejected", async ({ page }) => {
  const empty = await PDFDocument.create();
  empty.addPage();
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "scan.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await empty.save()),
  });
  await page.locator("#convert-button").click();
  await expect(page.locator("#error")).toContainText("selectable text");
  await page.locator("#file-input").setInputFiles("public/sample-paper.pdf");
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Edit manuscript" }).click();
  const editor = page.locator("#manifest-editor");
  const m = JSON.parse(await editor.inputValue());
  m.floats[0].bbox = [0, 0, 999999, 999999];
  await editor.fill(JSON.stringify(m));
  await page.getByRole("button", { name: "Render changes" }).click();
  await expect(page.locator("#editor-error")).toContainText(
    "Invalid manuscript",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor-dialog")).not.toBeVisible();
});

test("mobile layout has no horizontal overflow and converts a file", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/home-mobile.png",
    fullPage: true,
  });
  await page.locator("#file-input").setInputFiles("public/sample-paper.pdf");
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/results-mobile.png",
    fullPage: true,
  });
});

test("long unbroken text wraps and selected margin limits are enforced", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles("public/sample-paper.pdf");
  await page.locator(".settings summary").click();
  await page.locator("#trim-top").fill("500");
  await page.locator("#convert-button").click();
  await expect(page.locator("#error")).toContainText("between 0 and 100");
  await page.locator("#trim-top").fill("24");
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Edit manuscript" }).click();
  const editor = page.locator("#manifest-editor");
  const m = JSON.parse(await editor.inputValue());
  m.blocks[0].text = "LongToken".repeat(100);
  await editor.fill(JSON.stringify(m));
  await page.getByRole("button", { name: "Render changes" }).click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#error")).toBeHidden();
});

test("author superscripts, affiliations, and figure citations retain their structure", async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const first = doc.addPage([612, 792]);
  first.drawText("A structured preprint example", {
    x: 40,
    y: 720,
    size: 22,
    font: bold,
  });
  first.drawText("Ada Example", { x: 40, y: 680, size: 11, font });
  const x = 40 + font.widthOfTextAtSize("Ada Example", 11);
  first.drawText("1", { x, y: 685, size: 6.6, font });
  first.drawText(", Ben Sample", { x: x + 4, y: 680, size: 11, font });
  first.drawText("2", {
    x: x + 4 + font.widthOfTextAtSize(", Ben Sample", 11),
    y: 685,
    size: 6.6,
    font,
  });
  first.drawText("1 Institute of Example Science", {
    x: 40,
    y: 650,
    size: 10,
    font,
  });
  first.drawText("2 Department of Example Research", {
    x: 40,
    y: 635,
    size: 10,
    font,
  });
  first.drawText("Abstract", { x: 40, y: 595, size: 14, font: bold });
  first.drawText(
    "This original fixture checks whether source metadata stays separate from article text.",
    { x: 40, y: 570, size: 11, font },
  );
  first.drawText("Introduction", { x: 40, y: 530, size: 14, font: bold });
  for (let i = 0; i < 8; i++)
    first.drawText(
      `Figure 1 illustrates observation ${i + 1} and its visual evidence in this fictional study.`,
      { x: 40, y: 505 - i * 16, size: 11, font },
    );
  const second = doc.addPage([612, 792]);
  const image = await doc.embedPng(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  second.drawImage(image, { x: 40, y: 440, width: 500, height: 280 });
  second.drawText(
    "Figure 1. An original fixture for testing caption placement.",
    { x: 40, y: 415, size: 11, font },
  );
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "structured.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible();
  await page.locator("#edit-manuscript").click();
  const m = JSON.parse(await page.locator("#manifest-editor").inputValue());
  expect(m.metadata.authors).toBe("Ada Example1, Ben Sample2");
  expect(
    m.metadata.author_spans.filter(
      (s: { script?: string }) => s.script === "super",
    ),
  ).toHaveLength(2);
  expect(m.metadata.affiliations).toContain("Institute of Example Science");
  expect(m.blocks[0].text).toBe("Introduction");
  expect(
    m.blocks.some((b: { text: string }) => b.text.includes("Ada Example")),
  ).toBe(false);
  expect(m.floats[0].caption).toContain("An original fixture");
  expect(m.floats[0].anchor).toBe(m.blocks[1].id);
  await page.locator("#close-editor").click();
  const event = page.waitForEvent("download");
  await page.locator("#download-report").click();
  const report = JSON.parse(
    await readFile((await (await event).path())!, "utf8"),
  );
  expect(Object.values(report.visual_pages)).toEqual([2]);
});

async function checkSidebar(bytes: Uint8Array, reference = false) {
  const task = getDocument({ data: bytes, useSystemFonts: true });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const height = page.view[3];
    const content = await page.getTextContent();
    const items = content.items.filter((item) => "str" in item);
    const ops = await page.getOperatorList();
    const rules: number[] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== OPS.constructPath) continue;
      const bounds = ops.argsArray[i][2];
      if (
        bounds &&
        Math.abs(bounds[0] - 39.685) < 0.1 &&
        Math.abs(bounds[2] - 205.685) < 0.1 &&
        bounds[1] === bounds[3]
      )
        rules.push(height - bounds[1]);
    }
    expect(rules).toHaveLength(4);
    const starts = ["doi:", "Posted:", "bioRxiv", "Not"];
    for (const [i, start] of starts.entries()) {
      const item = items.find(
        (item) => item.str.startsWith(start) && item.transform[4] < 50,
      );
      expect(item, start).toBeDefined();
      const baseline = height - item!.transform[5];
      expect(rules[i] - baseline).toBeGreaterThanOrEqual(4.9);
      if (i) expect(baseline - item!.height - rules[i - 1]).toBeGreaterThan(2);
      if (reference) {
        expect(baseline).toBeCloseTo([148.8, 168, 184, 200][i], 1);
        expect(rules[i]).toBeCloseTo([155, 173, 189, 205][i], 1);
      }
    }
  } finally {
    await task.destroy();
  }
}

test("metadata dividers clear the text with bundled fonts", async ({
  page,
}) => {
  test.skip(!process.env.PAPERFORM_TEST_SOURCE, "Local document is opt-in.");
  await page.goto("/");
  await expect(page.locator("#reference-input")).toBeHidden();
  await page
    .locator("#file-input")
    .setInputFiles(process.env.PAPERFORM_TEST_SOURCE!);
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 90000 });
  const event = page.waitForEvent("download");
  await page.locator("#download-pdf").click();
  await checkSidebar(
    new Uint8Array(await readFile((await (await event).path())!)),
  );
});

test("local TCR source matches the supplied article reference structure", async ({
  page,
}) => {
  test.skip(
    !process.env.PAPERFORM_TEST_SOURCE || !process.env.PAPERFORM_TEST_REFERENCE,
    "Local documents are opt-in and are never committed or published.",
  );
  await page.goto("/");
  await page.locator(".settings summary").click();
  await page
    .locator("#reference-input")
    .setInputFiles(process.env.PAPERFORM_TEST_REFERENCE!);
  await expect(page.locator("#reference-status")).toContainText(
    "embedded fonts ·",
  );
  await page
    .locator("#file-input")
    .setInputFiles(process.env.PAPERFORM_TEST_SOURCE!);
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 90000 });
  const event = page.waitForEvent("download");
  await page.locator("#download-report").click();
  const report = JSON.parse(
    await readFile((await (await event).path())!, "utf8"),
  );
  const pdfEvent = page.waitForEvent("download");
  await page.locator("#download-pdf").click();
  await checkSidebar(
    new Uint8Array(await readFile((await (await pdfEvent).path())!)),
    true,
  );
  expect(report.output_pages).toBe(12);
  expect(report.typography.width).toBeCloseTo(595.276, 2);
  expect(report.typography.height).toBeCloseTo(790.866, 2);
  expect(
    report.typography.fonts.some((name: string) => name.includes("Harding")),
  ).toBe(true);
  expect(report.visual_pages).toMatchObject({
    "figure-13-0": 2,
    "figure-14-0": 3,
    "table-12-0": 4,
    "table-12-1": 4,
    "figure-15-0": 5,
    "figure-17-0": 6,
  });
  expect(report.missing_glyphs).toEqual(["\u0000"]);
  await page.locator("#edit-manuscript").click();
  const m = JSON.parse(await page.locator("#manifest-editor").inputValue());
  expect(m.metadata.authors).toMatch(/^Amir Motmaen1,2,3, Kevin M. Jude4,5/);
  expect(m.metadata.doi).toBe("10.1101/2025.11.19.689381");
  expect(m.metadata.abstract).toContain("Class I major histocompatibility");
  expect(m.blocks[0].text).toBe("Introduction");
  expect(
    m.floats.filter((f: { kind: string }) => f.kind === "figure"),
  ).toHaveLength(4);
  expect(
    m.floats.filter((f: { kind: string }) => f.kind === "table"),
  ).toHaveLength(2);
  expect(
    m.floats.find((f: { id: string }) => f.id === "figure-15-0").caption,
  ).toContain("Docking geometry");
});

test("large local PDFs can be declined or selected after confirmation", async ({
  page,
}) => {
  await page.goto("/");
  for (const accept of [false, true]) {
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Continue anyway?");
      if (accept) await dialog.accept();
      else await dialog.dismiss();
    });
    await page.evaluate(() => {
      const file = new File(["%PDF-"], "large.pdf", {
        type: "application/pdf",
      });
      Object.defineProperty(file, "size", { value: 101 * 1024 * 1024 });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector<HTMLInputElement>("#file-input")!;
      input.files = transfer.files;
      input.dispatchEvent(new Event("change"));
    });
    if (accept)
      await expect(page.locator("#file-name")).toHaveText("large.pdf");
    else
      await expect(page.locator("#file-name")).toHaveText(
        "Drop your paper here",
      );
  }
});

test("source PDFs above 200 pages ask before extraction", async ({ page }) => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 201; i++) pdf.addPage();
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "long.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await pdf.save()),
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("201 pages");
    expect(dialog.message()).toContain("Continue anyway?");
    await dialog.dismiss();
  });
  await page.locator("#convert-button").click();
  await expect(page.locator("#error")).toContainText(
    "Large PDF conversion cancelled.",
  );
  await expect(page.locator("#workspace")).toBeVisible();
});

test("labeled front matter and detached supplementary figure plates stay intact", async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const first = doc.addPage([612, 792]);
  const line = (text: string, y: number, heading = false) =>
    first.drawText(text, { x: 40, y, size: 11, font: heading ? bold : font });
  line("Title:", 720, true);
  line("Function-preserving protein design", 704, true);
  line("Authors:", 680, true);
  line("Ada Example, Ben Sample", 664);
  line("1. Department of Example Science", 640);
  line("Abstract:", 610, true);
  line(
    "This fictional abstract describes a design experiment and its measured outcomes.",
    590,
  );
  line("Main text:", 555, true);
  line(
    "Figure S1 shows the complete experiment, including the annotated panels.",
    535,
  );
  line(
    "Figure 1 is cited separately and must not capture supplementary figures.",
    519,
  );
  line("Figure S1. A detached legend for a composite figure.", 470, true);
  line("Both panels and their vector annotations must remain together.", 454);
  line("Methods:", 420, true);
  line(
    "The experiment used a fictional set of measurements for this regression fixture.",
    400,
  );
  const plate = doc.addPage([612, 792]);
  plate.drawText("Figure S1", { x: 5, y: 775, size: 10, font: bold });
  const png = await doc.embedPng(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  plate.drawImage(png, { x: 40, y: 480, width: 230, height: 210 });
  plate.drawImage(png, { x: 310, y: 480, width: 230, height: 210 });
  plate.drawText("A", { x: 30, y: 710, size: 12, font: bold });
  plate.drawText("B", { x: 300, y: 710, size: 12, font: bold });
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "plates.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible();
  await page.locator("#edit-manuscript").click();
  const m = JSON.parse(await page.locator("#manifest-editor").inputValue());
  expect(m.metadata.title).toBe("Function-preserving protein design");
  expect(m.metadata.authors).toBe("Ada Example, Ben Sample");
  expect(m.metadata.abstract).toMatch(/^This fictional abstract/);
  expect(m.metadata.abstract).not.toContain("Main text");
  expect(m.blocks[0].text).toMatch(/^Figure S1 shows/);
  expect(m.metadata.affiliations).toContain("1. Department");
  expect(m.floats).toHaveLength(1);
  expect(m.floats[0].label).toBe("Figure S1");
  expect(m.floats[0].caption).toContain("Both panels");
  expect(m.floats[0].caption).not.toContain("Methods");
  expect(m.floats[0].bbox[0]).toBeLessThan(40);
  expect(m.floats[0].bbox[2]).toBeGreaterThan(540);
  expect(
    m.blocks.find((b: { id: string }) => b.id === m.floats[0].anchor).text,
  ).toMatch(/^Figure S1 shows/);
  expect(
    m.blocks.some(
      (b: { text: string }) =>
        b.text.includes("detached legend") || b.text === "A B",
    ),
  ).toBe(false);
});

test("local detached-plate paper preserves front matter, captions, and math glyphs", async ({
  page,
}) => {
  test.skip(!process.env.PAPERFORM_TEST_PLATES, "Local document is opt-in.");
  await page.goto("/");
  await page
    .locator("#file-input")
    .setInputFiles(process.env.PAPERFORM_TEST_PLATES!);
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 90000 });
  await page.locator("#edit-manuscript").click();
  const m = JSON.parse(await page.locator("#manifest-editor").inputValue());
  expect(m.metadata.title).toMatch(/^Function-preserving CD8/);
  expect(m.metadata.authors).toContain("Bingxu Liu");
  expect(m.metadata.abstract).toMatch(/^Rapid advances/);
  const plates = m.floats.filter((f: { id: string }) =>
    f.id.startsWith("plate-"),
  );
  expect(plates).toHaveLength(7);
  const equations = m.floats.filter(
    (f: { kind: string }) => f.kind === "equation",
  );
  expect(equations).toHaveLength(3);
  expect(equations.every((f: { bbox: number[] }) => f.bbox[0] < 72)).toBe(true);
  expect(equations[2].bbox[3] - equations[2].bbox[1]).toBeGreaterThan(40);
  expect(
    plates.find((f: { label: string }) => f.label === "Figure 2").caption,
  ).toContain("Cross-reactivity");
  expect(
    m.blocks.every((b: { source_pages: number[] }) =>
      b.source_pages.every((n) => n < 17),
    ),
  ).toBe(true);
  await page.locator("#close-editor").click();
  const event = page.waitForEvent("download");
  await page.locator("#download-report").click();
  const report = JSON.parse(
    await readFile((await (await event).path())!, "utf8"),
  );
  expect(report.missing_glyphs).toEqual([]);
});

test("local NIH manuscript keeps its summary, captions, and resource tables", async ({
  page,
}) => {
  test.skip(!process.env.PAPERFORM_TEST_NIH, "Local document is opt-in.");
  await page.goto("/");
  await page
    .locator("#file-input")
    .setInputFiles(process.env.PAPERFORM_TEST_NIH!);
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 90000 });
  await page.locator("#edit-manuscript").click();
  const m = JSON.parse(await page.locator("#manifest-editor").inputValue());
  expect(m.metadata.title).toBe(
    "Most non-canonical proteins uniquely populate the proteome or immunopeptidome",
  );
  expect(m.metadata.authors).toMatch(/^Maria Virginia Ruiz Cuevas/);
  expect(m.metadata.authors).toContain("Yewdell");
  expect(m.metadata.abstract).toMatch(/^Combining RNA sequencing/);
  expect(m.metadata.abstract).toMatch(/class I pathway\.$/);
  expect(m.metadata.abstract).not.toContain("CONTRIBUTIONS");
  expect(m.metadata.affiliations).toContain("Correspondence:");
  const body = m.blocks.map((b: { text: string }) => b.text).join(" ");
  expect(body).not.toMatch(
    /Author Manuscript|Cell Rep\. Author manuscript|Cuevas et al\. Page/,
  );
  expect(body).toContain("Conceptualization");
  expect(body).toContain("The authors declare no competing interests");
  expect(body).not.toContain("Graphical Abstract");
  expect(body).not.toContain("In brief");
  expect(body).not.toContain("Ruiz Cuevas et al. describe");
  expect(m.blocks[0].text).toBe("INTRODUCTION");
  expect(
    m.floats.filter((f: { kind: string }) => f.kind === "equation"),
  ).toHaveLength(4);
  expect(m.floats.some((f: { kind: string }) => f.kind === "source-page")).toBe(
    false,
  );
  expect(
    m.floats.find((f: { label: string }) => f.label === "Graphical Abstract")
      .caption,
  ).toBe("Graphical Abstract");
  const figures = m.floats.filter((f: { label: string }) =>
    /^Figure \d+$/.test(f.label),
  );
  expect(figures).toHaveLength(6);
  expect(
    figures.find((f: { label: string }) => f.label === "Figure 2").caption,
  ).toContain("genomic location");
  expect(
    figures.every(
      (f: { caption: string }) => !/Author Manuscript|Page \d+/.test(f.caption),
    ),
  ).toBe(true);
  expect(
    m.floats.filter((f: { id: string }) => f.id.startsWith("resources-")),
  ).toHaveLength(2);
  expect(
    m.blocks.every((b: { source_pages: number[] }) =>
      b.source_pages.every((n) => n < 38),
    ),
  ).toBe(true);
});

test("NIH cover furniture and footnotes do not interrupt a multi-page summary", async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const first = doc.addPage([612, 792]);
  const text = (
    p: ReturnType<typeof doc.addPage>,
    value: string,
    y: number,
    size = 10,
    heading = false,
  ) => p.drawText(value, { x: 90, y, size, font: heading ? bold : font });
  text(first, "HHS Public Access", 760, 24, true);
  text(first, "Author manuscript", 740, 16);
  text(first, "Published in final edited form as:", 710);
  text(first, "A study with a continued summary", 650, 14, true);
  text(first, "Ada Example, Ben Sample", 620);
  text(first, "1 Department of Example Research", 595);
  text(first, "SUMMARY", 560, 11, true);
  text(
    first,
    "The first part of this summary describes a fictional study whose results continue",
    540,
  );
  text(first, "*Correspondence: ada@example.org", 150, 8);
  text(first, "AUTHOR CONTRIBUTIONS", 135, 8);
  text(
    first,
    "Both authors designed this fictional study and reviewed its conclusions.",
    120,
    8,
  );
  const second = doc.addPage([612, 792]);
  text(second, "Example et al.", 750, 8);
  text(second, "Page 2", 739, 8);
  text(
    second,
    "onto a second page without any publication furniture mixed into the abstract.",
    720,
  );
  text(second, "In brief", 705, 11, true);
  text(second, "A redundant publisher summary of the findings.", 692);
  text(second, "INTRODUCTION", 680, 11, true);
  text(
    second,
    "The article begins with background and describes the experiment in detail.",
    660,
  );
  text(second, "REFERENCES", 620, 11, true);
  text(
    second,
    "Example A. A fictional reference for this original regression fixture.",
    600,
  );
  text(
    second,
    "Cell Rep. Author manuscript; available in PMC 2021 April 12.",
    70,
    8,
  );
  second.drawText("Author Manuscript", {
    x: 20,
    y: 600,
    size: 12,
    font,
    rotate: degrees(-90),
  });
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "nih-fixture.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible();
  await page.locator("#edit-manuscript").click();
  const m = JSON.parse(await page.locator("#manifest-editor").inputValue());
  expect(m.metadata.title).toBe("A study with a continued summary");
  expect(m.metadata.abstract).toMatch(/results continue onto a second page/);
  expect(m.metadata.abstract).not.toMatch(
    /Correspondence|CONTRIBUTIONS|Author manuscript|Page 2/i,
  );
  expect(m.metadata.affiliations).toContain("ada@example.org");
  const body = m.blocks.map((b: { text: string }) => b.text).join(" ");
  expect(body).toContain("Both authors designed");
  expect(body).not.toContain("In brief");
  expect(body).not.toContain("redundant publisher summary");
  expect(body).not.toMatch(
    /Author Manuscript|Example et al\.|available in PMC|Page 2/i,
  );
});

test("separate title pages and abbreviated extended-data legends retain structure", async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = (
    p: ReturnType<typeof doc.addPage>,
    value: string,
    y: number,
    heading = false,
  ) =>
    p.drawText(value, {
      x: 60,
      y,
      size: heading ? 14 : 10,
      font: heading ? bold : font,
    });
  const cover = doc.addPage();
  text(cover, "A manuscript with a separate title page", 740, true);
  text(cover, "Ada Example and Ben Sample", 710);
  text(cover, "1 Department of Fictional Research", 690);
  const body = doc.addPage();
  text(body, "Abstract", 740, true);
  text(
    body,
    "This abstract belongs in the front matter of the reading copy.",
    715,
  );
  text(body, "Introduction", 680, true);
  text(
    body,
    "The experiment is illustrated in Figure 1 and Extended Data Fig. 1,",
    655,
  );
  text(
    body,
    "with double-spaced source lines that should form one paragraph",
    630,
  );
  text(
    body,
    "when the manuscript is reformatted into a compact reading copy.",
    605,
  );
  for (const prefix of ["", "Extended Data "]) {
    const plate = doc.addPage();
    text(plate, `${prefix}Figure 1`, 740, true);
    for (let i = 0; i < 20; i++)
      plate.drawRectangle({ x: 60 + i * 20, y: 300, width: 10, height: 200 });
    const legend = doc.addPage();
    text(legend, `${prefix}Fig 1. A complete figure legend.`, 740);
    text(legend, "The panels show the fictional experimental results.", 720);
  }
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "separate-title.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible();
  await page.locator("#edit-manuscript").click();
  const m = JSON.parse(await page.locator("#manifest-editor").inputValue());
  expect(m.metadata.authors).toBe("Ada Example and Ben Sample");
  expect(m.metadata.abstract).toBe(
    "This abstract belongs in the front matter of the reading copy.",
  );
  expect(m.metadata.affiliations).toContain("Department of Fictional Research");
  expect(
    m.blocks.find((b: { text: string }) => b.text.startsWith("The experiment"))
      .text,
  ).toContain("one paragraph when the manuscript");
  expect(m.floats).toHaveLength(2);
  for (const f of m.floats) {
    expect(f.bbox[1]).toBe(0); // Panel labels above the text margin survive.
    expect(f.caption).toContain("A complete figure legend.");
    expect(f.caption).toContain("fictional experimental results.");
  }
  expect(m.blocks.map((b: { text: string }) => b.text).join(" ")).not.toMatch(
    /Ada Example|complete figure legend/,
  );
});

test("local CD4 manuscript groups front matter and detached figure legends", async ({
  page,
}) => {
  test.skip(!process.env.PAPERFORM_TEST_CD4, "Local document is opt-in.");
  await page.goto("/");
  await page
    .locator("#file-input")
    .setInputFiles(process.env.PAPERFORM_TEST_CD4!);
  await page.locator("#convert-button").click();
  await expect(page.locator("#results")).toBeVisible({ timeout: 60_000 });
  await page.locator("#edit-manuscript").click();
  const m = JSON.parse(await page.locator("#manifest-editor").inputValue());
  expect(m.metadata.authors).toContain("Sean-Luc Shanahan");
  expect(m.metadata.abstract).toContain(
    "CD4+ T cells can be either protective",
  );
  expect(m.metadata.abstract).toContain("therapeutic approach");
  for (const label of [
    "Figure 1",
    "Figure 5",
    "Extended Data Figure 1",
    "Extended Data Figure 10",
  ]) {
    const figure = m.floats.find((f: { label: string }) => f.label === label);
    expect(figure, label).toBeDefined();
    expect(figure.caption.length).toBeGreaterThan(300);
  }
});
