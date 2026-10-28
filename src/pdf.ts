import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  PDFDocumentProxy,
  TextItem,
} from "pdfjs-dist/types/src/display/api";
import type {
  Block,
  Box,
  Figure,
  ImageAsset,
  Manuscript,
  Progress,
  Settings,
  Span,
} from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export const LARGE_PDF_BYTES = 100 * 1024 * 1024;
export const LARGE_PDF_PAGES = 200;
export function pdfOptions() {
  const base = new URL(import.meta.env.BASE_URL, document.baseURI);
  return {
    cMapUrl: new URL("pdfjs/cmaps/", base).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("pdfjs/standard_fonts/", base).href,
    wasmUrl: new URL("pdfjs/wasm/", base).href,
    useSystemFonts: true,
    fontExtraProperties: true,
  };
}
export const pause = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
export const clean = (s: string) =>
  s
    .replace(
      /[ﬀﬁﬂﬃﬄ]/g,
      (c) => ({ ﬀ: "ff", ﬁ: "fi", ﬂ: "fl", ﬃ: "ffi", ﬄ: "ffl" })[c]!,
    )
    .replace(/[\u200b\u00ad]/g, "");
export const canonical = (s: string) => clean(s).replace(/[\s\-‐‑–]/g, "");
export async function hash(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}

export async function openPdf(
  bytes: Uint8Array,
  signal?: AbortSignal,
  confirmManyPages: (pages: number) => boolean = () => false,
): Promise<PDFDocumentProxy> {
  if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes("%PDF-"))
    throw new Error("This file is not a PDF. Please choose a PDF document.");
  const task = pdfjs.getDocument({ data: bytes.slice(), ...pdfOptions() });
  const abort = () => {
    void task.destroy();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const doc = await task.promise;
    if (doc.numPages > LARGE_PDF_PAGES && !confirmManyPages(doc.numPages)) {
      await doc.loadingTask.destroy();
      throw new DOMException("Large PDF conversion cancelled.", "AbortError");
    }
    return doc;
  } catch (error) {
    if ((error as Error).name === "PasswordException")
      throw new Error(
        "This PDF is password protected. Choose an unlocked copy.",
      );
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export { extractArticle as extract } from "./article";

export async function cropAssets(
  doc: PDFDocumentProxy,
  m: Manuscript,
  progress: Progress,
  signal: AbortSignal,
): Promise<ImageAsset[]> {
  const assets: ImageAsset[] = [];
  for (const [i, f] of m.floats.entries()) {
    signal.throwIfAborted();
    progress(
      48 + (17 * (i + 1)) / m.floats.length,
      `Preserving visual ${i + 1} of ${m.floats.length}`,
    );
    const page = await doc.getPage(f.source_page + 1);
    const [x0, y0, x1, y1] = f.bbox;
    const viewport = page.getViewport({ scale: 1 });
    const corners = [
      viewport.convertToPdfPoint(x0, y0),
      viewport.convertToPdfPoint(x1, y1),
    ];
    const [a, b, c, d, e, f0] = viewport.transform;
    // Map native PDF coordinates into the crop's bottom-left coordinate system.
    // This includes page rotation, CropBox offsets, and UserUnit scaling.
    assets.push({
      id: f.id,
      sourcePage: f.source_page,
      bounds: {
        left: Math.min(corners[0][0], corners[1][0]),
        right: Math.max(corners[0][0], corners[1][0]),
        bottom: Math.min(corners[0][1], corners[1][1]),
        top: Math.max(corners[0][1], corners[1][1]),
      },
      matrix: [a, -b, c, -d, e - x0, y1 - f0],
      width: x1 - x0,
      height: y1 - y0,
    });
    await pause();
  }
  return assets;
}

export function validateManifest(
  value: unknown,
  sourceHash: string,
  pageSizes: [number, number][],
): Manuscript {
  const m = value as Manuscript;
  const fail = () => {
    throw new Error(
      "Invalid manuscript JSON. Use a Natural Preprint manuscript with valid blocks and crop coordinates.",
    );
  };
  if (!m || m.schema_version !== "paperform-1")
    throw new Error(
      "This is not a Natural Preprint browser manuscript (paperform-1). Python manifests use a different schema.",
    );
  if (m.source_sha256 !== sourceHash)
    throw new Error(
      "This manuscript belongs to a different PDF. Select its original source PDF first.",
    );
  if (
    !m.metadata ||
    typeof m.metadata.title !== "string" ||
    m.metadata.title.length > 2000 ||
    typeof m.metadata.doi !== "string" ||
    m.metadata.doi.length > 500 ||
    typeof m.metadata.authors !== "string" ||
    m.metadata.authors.length > 5000 ||
    typeof m.source_name !== "string"
  )
    fail();
  function normalizedSpans(value: unknown, text: string): Span[] {
    if (
      !Array.isArray(value) ||
      value.some(
        (s) =>
          !s ||
          typeof s.text !== "string" ||
          (s.script !== undefined && !["super", "sub"].includes(s.script)),
      ) ||
      value.map((s) => s.text).join("") !== text
    )
      return [{ text }];
    return value;
  }
  for (const [textKey, spanKey] of [
    ["authors", "author_spans"],
    ["abstract", "abstract_spans"],
    ["affiliations", "affiliation_spans"],
  ] as const) {
    const value = m.metadata[textKey];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > 100000)
    )
      fail();
    m.metadata[spanKey] = normalizedSpans(m.metadata[spanKey], value ?? "");
  }
  if (
    m.metadata.posted !== undefined &&
    (typeof m.metadata.posted !== "string" || m.metadata.posted.length > 100)
  )
    fail();
  if (
    !Array.isArray(m.blocks) ||
    m.blocks.length > 15000 ||
    !m.blocks.length ||
    !Array.isArray(m.floats) ||
    m.floats.length > 200
  )
    fail();
  const ids = new Set<string>();
  let textLength = 0;
  for (const b of m.blocks) {
    if (
      !b ||
      typeof b.id !== "string" ||
      ids.has(b.id) ||
      !["paragraph", "heading", "caption", "equation"].includes(b.kind) ||
      typeof b.text !== "string" ||
      !Array.isArray(b.source_pages) ||
      !b.source_pages.length ||
      b.source_pages.some(
        (n) => !Number.isInteger(n) || n < 0 || n >= pageSizes.length,
      )
    )
      fail();
    ids.add(b.id);
    textLength += b.text.length;
    // Plain text is authoritative when an editor changes it without updating spans.
    if (
      !Array.isArray(b.spans) ||
      b.spans.some(
        (s) =>
          !s ||
          typeof s.text !== "string" ||
          (s.script !== undefined && !["super", "sub"].includes(s.script)),
      ) ||
      b.spans.map((s) => s.text).join("") !== b.text
    )
      b.spans = [{ text: b.text }];
  }
  if (textLength > 600_000) fail();
  const floatIds = new Set<string>();
  for (const f of m.floats) {
    if (
      !f ||
      typeof f.id !== "string" ||
      floatIds.has(f.id) ||
      !["figure", "table", "equation", "source-page"].includes(f.kind) ||
      typeof f.label !== "string" ||
      f.label.length > 300 ||
      !Number.isInteger(f.source_page) ||
      f.source_page < 0 ||
      f.source_page >= pageSizes.length ||
      (f.anchor !== null && !ids.has(f.anchor))
    )
      fail();
    floatIds.add(f.id);
    if (
      f.caption !== undefined &&
      (typeof f.caption !== "string" || f.caption.length > 100000)
    )
      fail();
    f.caption_spans = normalizedSpans(f.caption_spans, f.caption ?? "");
    const [w, h] = pageSizes[f.source_page];
    if (
      !Array.isArray(f.bbox) ||
      f.bbox.length !== 4 ||
      f.bbox.some((n) => !Number.isFinite(n)) ||
      f.bbox[0] < 0 ||
      f.bbox[1] < 0 ||
      f.bbox[2] > w ||
      f.bbox[3] > h ||
      f.bbox[2] - f.bbox[0] < 1 ||
      f.bbox[3] - f.bbox[1] < 1
    )
      fail();
  }
  if (
    !Array.isArray(m.warnings) ||
    m.warnings.some((w) => typeof w !== "string")
  )
    fail();
  m.extraction = {
    pages: pageSizes.length,
    page_sizes: pageSizes,
    characters: textLength,
  };
  return m;
}

export async function fetchPdf(
  urlText: string,
  signal: AbortSignal,
  progress: Progress,
  confirmLargePdf: (bytes: number) => boolean = () => false,
): Promise<{ bytes: Uint8Array; name: string }> {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("Enter a complete HTTPS link to a PDF.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Use a public HTTPS PDF link without login credentials.");
  let response: Response;
  try {
    response = await fetch(url.href, {
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      "The PDF could not be fetched. The host may block browser access (CORS), or the link may be unavailable. Download it from the source website, then choose the file here.",
    );
  }
  if (!response.ok)
    throw new Error(
      `The source returned HTTP ${response.status}. Download the PDF from its website and select it here.`,
    );
  const total = Number(response.headers.get("content-length"));
  let largePdfApproved = false;
  if (total > LARGE_PDF_BYTES) {
    largePdfApproved = confirmLargePdf(total);
    if (!largePdfApproved) {
      await response.body?.cancel();
      throw new DOMException("Large PDF download cancelled.", "AbortError");
    }
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error(
      "This browser could not read the download. Try selecting a local PDF.",
    );
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > LARGE_PDF_BYTES && !largePdfApproved) {
        largePdfApproved = confirmLargePdf(length);
        if (!largePdfApproved)
          throw new DOMException("Large PDF download cancelled.", "AbortError");
      }
      chunks.push(value);
      progress(
        total ? Math.min(10, (length / total) * 10) : 5,
        `Downloading PDF · ${(length / 1024 / 1024).toFixed(1)} MB`,
      );
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const rawName = url.pathname.split("/").pop() || "linked-paper.pdf";
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    /* Keep valid URL text. */
  }
  return {
    bytes,
    name: name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`,
  };
}
