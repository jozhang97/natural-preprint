import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import TypesetWorker from "./typeset.worker?worker";
import { canonical, cropAssets, pdfOptions } from "./pdf";
import type {
  Manuscript,
  Progress,
  Report,
  Settings,
  TypographyReference,
} from "./types";

let fontCache: Promise<ArrayBuffer[]> | undefined;
function fonts(signal: AbortSignal): Promise<ArrayBuffer[]> {
  return (fontCache ??= Promise.all(
    [
      "NotoSerif-Regular",
      "NotoSerif-Bold",
      "NotoSerif-Italic",
      "NotoSerif-BoldItalic",
      "NotoSansSymbols2-Regular",
      "NotoSansSymbols-Regular",
    ].map(async (style) => {
      const res = await fetch(`${import.meta.env.BASE_URL}fonts/${style}.ttf`, {
        signal,
      });
      if (!res.ok)
        throw new Error(
          "The bundled fonts could not be loaded. Reload the website and try again.",
        );
      return res.arrayBuffer();
    }),
  ).catch((error) => {
    fontCache = undefined;
    throw error;
  }));
}

export async function convert(
  doc: PDFDocumentProxy,
  m: Manuscript,
  settings: Settings,
  progress: Progress,
  signal: AbortSignal,
  reference?: TypographyReference,
): Promise<{ bytes: Uint8Array; report: Report }> {
  const assets = await cropAssets(doc, m, progress, signal);
  const sourceBytes = assets.length ? await doc.getData() : undefined;
  const fontBytes = await fonts(signal);
  signal.throwIfAborted();
  progress(66, "Preparing the reading layout");
  const worker = new TypesetWorker();
  const result = await new Promise<{ bytes: Uint8Array; report: Report }>(
    (resolve, reject) => {
      const finish = () => {
        worker.terminate();
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        finish();
        reject(new DOMException("Conversion cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = () => {
        finish();
        reject(
          new Error(
            "The conversion worker stopped. Try a smaller PDF or reload the website.",
          ),
        );
      };
      worker.onmessage = ({ data }) => {
        if (data.type === "progress") progress(data.percent, data.label);
        else if (data.type === "done") {
          finish();
          resolve(data);
        } else if (data.type === "error") {
          finish();
          reject(new Error(data.message));
        }
      };
      worker.postMessage({
        manuscript: m,
        settings,
        assets,
        sourceBytes,
        fonts: fontBytes,
        reference,
      });
    },
  );
  signal.throwIfAborted();
  progress(92, "Checking the rendered text");
  // Generated output can exceed the source-file/page limits; load it directly.
  const task = getDocument({ data: result.bytes.slice(), ...pdfOptions() });
  const abort = () => {
    void task.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const output = await task.promise;
    const parts: string[] = [];
    for (let n = 1; n <= output.numPages; n++) {
      signal.throwIfAborted();
      const page = await output.getPage(n);
      // Copied PDF crops can contain clipped source text. Exclude their marked
      // content so the text check verifies only newly typeset manuscript text.
      let visualDepth = 0;
      for (const item of (
        await page.getTextContent({ includeMarkedContent: true })
      ).items) {
        if ("str" in item) {
          if (!visualDepth) parts.push(item.str);
        } else if (
          item.type === "beginMarkedContent" ||
          item.type === "beginMarkedContentProps"
        ) {
          if (visualDepth || ("tag" in item && item.tag === "PaperformVisual"))
            visualDepth++;
        } else if (item.type === "endMarkedContent" && visualDepth)
          visualDepth--;
      }
      page.cleanup();
    }
    const rendered = canonical(parts.join(" "));
    // Headers/footers interrupt blocks across pages. Check short consecutive
    // excerpts to detect omissions without calling a page break a text loss.
    const checked = [
      ...m.blocks.filter(
        (b) =>
          !m.floats.some((f) => f.kind === "equation" && f.anchor === b.id),
      ),
      ...(["title", "authors", "abstract", "affiliations"] as const)
        .filter((key) => m.metadata[key])
        .map((key) => ({ id: `metadata-${key}`, text: m.metadata[key]! })),
      ...m.floats
        .filter((f) => f.caption)
        .map((f) => ({ id: `caption-${f.id}`, text: f.caption! })),
    ];
    const unmatched = checked
      .filter((b) => {
        const expected = canonical(b.text);
        for (let i = 0; i < expected.length; i += 60)
          if (!rendered.includes(expected.slice(i, i + 60))) return true;
        return false;
      })
      .map((b) => b.id);
    result.report.text_check = {
      checked_blocks: checked.length,
      unmatched_blocks: unmatched,
    };
    if (unmatched.length)
      result.report.warnings.push(
        `${unmatched.length} text block(s) need review. Font substitutions or page breaks can also cause a mismatch; see the report for block IDs.`,
      );
  } finally {
    signal.removeEventListener("abort", abort);
    await task.destroy();
  }
  progress(100, "Your Natural Preprint is ready");
  return result;
}
