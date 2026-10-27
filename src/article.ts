import { OPS, Util, type PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { clean, hash, pause } from "./pdf";
import type {
  Block,
  Box,
  Figure,
  Manuscript,
  Progress,
  Settings,
  Span,
} from "./types";

type Piece = {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  font: string;
};
type Row = {
  text: string;
  spans: Span[];
  bbox: Box;
  size: number;
  bold: boolean;
  page: number;
  baseline: number;
  pieces: Piece[];
};
type SourcePage = {
  rows: Row[];
  images: Box[];
  drawings: Box[];
  paths: number;
  size: [number, number];
};
const section =
  /^(?:\d+[.\s]+)?(?:Abstract|Introduction|Results|Discussion|Methods|Materials and methods|Conclusion[s]?|References|Bibliography|Acknowledg[e]?ments|Supplementary.*|Extended data.*|Data availability|Author contributions|Competing interests|Funding)$/i;
const caption = /^(Fig(?:ure)?\.?|Table)\s*(\d+)\s*[.:|]\s*/i;
const merge = (a: Box, b: Box): Box => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const inside = (a: Box, b: Box) =>
  a[0] >= b[0] - 2 && a[1] >= b[1] - 2 && a[2] <= b[2] + 2 && a[3] <= b[3] + 2;
const combine = (rows: { spans: Span[] }[]): Span[] =>
  rows.flatMap((r, i) => (i ? [{ text: " " }, ...r.spans] : r.spans));
const plain = (spans: Span[]) =>
  spans
    .map((s) => s.text)
    .join("")
    .trim();

function makeRows(pieces: Piece[], page: number): Row[] {
  const rows: Row[] = [];
  // Establish the main baselines before attaching superscripts/subscripts. A
  // y-first sort incorrectly puts every affiliation number before its author.
  for (const p of [...pieces].sort((a, b) => b.size - a.size || a.y - b.y)) {
    const candidates = rows.filter(
      (r) =>
        Math.abs(p.y - r.baseline) <=
        (p.size < r.size * 0.86 ? r.size * 0.65 : 2),
    );
    let row = candidates.sort(
      (a, b) => Math.abs(p.y - a.baseline) - Math.abs(p.y - b.baseline),
    )[0];
    if (!row) {
      row = {
        text: "",
        spans: [],
        bbox: [p.x, p.y - p.size, p.x + p.width, p.y + p.size * 0.18],
        size: p.size,
        bold: false,
        page,
        baseline: p.y,
        pieces: [],
      };
      rows.push(row);
    }
    row.pieces.push(p);
    row.bbox = merge(row.bbox, [
      p.x,
      p.y - p.size,
      p.x + p.width,
      p.y + p.size * 0.18,
    ]);
  }
  for (const row of rows) {
    row.pieces.sort((a, b) => a.x - b.x);
    let end = -Infinity;
    for (const p of row.pieces) {
      if (
        end !== -Infinity &&
        p.x - end > Math.max(1.6, p.size * 0.14) &&
        !row.spans.at(-1)?.text.endsWith(" ") &&
        !p.text.startsWith(" ")
      )
        row.spans.push({ text: " " });
      row.spans.push({
        text: clean(p.text),
        bold: /bold|black|semibold/i.test(p.font),
        italic: /italic|oblique/i.test(p.font),
        ...(p.size < row.size * 0.86
          ? {
              script:
                p.y < row.baseline ? ("super" as const) : ("sub" as const),
            }
          : {}),
      });
      end = Math.max(end, p.x + p.width);
    }
    if (row.spans.length) {
      row.spans[0].text = row.spans[0].text.trimStart();
      row.spans.at(-1)!.text = row.spans.at(-1)!.text.trimEnd();
    }
    row.text = plain(row.spans);
    row.bold = row.pieces
      .filter((p) => p.size >= row.size * 0.9)
      .every((p) => /bold|black|semibold/i.test(p.font));
  }
  return rows.sort((a, b) => a.baseline - b.baseline);
}

export async function extractArticle(
  doc: PDFDocumentProxy,
  bytes: Uint8Array,
  name: string,
  settings: Settings,
  progress: Progress,
  signal: AbortSignal,
): Promise<Manuscript> {
  const pages: SourcePage[] = [],
    warnings: string[] = [],
    floats: Figure[] = [];
  let firstRaw = "",
    preprint = false;
  for (let n = 0; n < doc.numPages; n++) {
    signal.throwIfAborted();
    progress(
      12 + (35 * (n + 1)) / doc.numPages,
      `Reading page ${n + 1} of ${doc.numPages}`,
    );
    const page = await doc.getPage(n + 1),
      vp = page.getViewport({ scale: 1 });
    if (vp.width > 2400 || vp.height > 2400)
      throw new Error(
        "This PDF uses unusually large pages. Use a standard paper-size PDF.",
      );
    const content = await page.getTextContent(),
      ops = await page.getOperatorList();
    const items = content.items.filter(
      (i): i is TextItem => "str" in i && !!i.str.trim(),
    );
    if (n === 0) {
      firstRaw = items.map((i) => i.str).join(" ");
      preprint = /bioRxiv|medRxiv/i.test(firstRaw);
    }
    const pieces: Piece[] = items
      .map((item) => {
        const t = Util.transform(vp.transform, item.transform);
        const font = page.commonObjs.has(item.fontName)
          ? page.commonObjs.get(item.fontName)?.name
          : "";
        return {
          text: item.str,
          x: t[4],
          y: t[5],
          width: item.width,
          size: Math.hypot(t[2], t[3]) || item.height || 10,
          font: font || content.styles[item.fontName]?.fontFamily || "",
        };
      })
      .filter(
        (p) =>
          p.y - p.size >= Math.max(settings.top, preprint ? 33 : 0) &&
          p.y <= vp.height - settings.bottom &&
          !(p.x < 28 && /^\d+$/.test(p.text.trim())),
      );
    const rows = makeRows(pieces, n).filter(
      (r) => !(/^\d+$/.test(r.text) && r.bbox[1] > vp.height - 60),
    );
    const images: Box[] = [],
      drawings: Box[] = [];
    let paths = 0,
      matrix = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const op = ops.fnArray[i],
        args = ops.argsArray[i];
      if (op === OPS.save) stack.push([...matrix]);
      else if (op === OPS.restore) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (op === OPS.transform) matrix = Util.transform(matrix, args);
      else if (op === OPS.constructPath) {
        paths++;
        const bounds = args[2];
        if (bounds && bounds.length === 4) {
          const t = Util.transform(vp.transform, matrix),
            pts = [
              [bounds[0], bounds[1]],
              [bounds[2], bounds[1]],
              [bounds[0], bounds[3]],
              [bounds[2], bounds[3]],
            ].map(([x, y]) => [
              t[0] * x + t[2] * y + t[4],
              t[1] * x + t[3] * y + t[5],
            ]);
          drawings.push([
            Math.min(...pts.map((p) => p[0])),
            Math.min(...pts.map((p) => p[1])),
            Math.max(...pts.map((p) => p[0])),
            Math.max(...pts.map((p) => p[1])),
          ]);
        }
      } else if (
        op === OPS.paintImageXObject ||
        op === OPS.paintInlineImageXObject
      ) {
        const t = Util.transform(vp.transform, matrix);
        const pts = [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].map(([x, y]) => [
          t[0] * x + t[2] * y + t[4],
          t[1] * x + t[3] * y + t[5],
        ]);
        const b: Box = [
          Math.max(0, Math.min(...pts.map((p) => p[0]))),
          Math.max(0, Math.min(...pts.map((p) => p[1]))),
          Math.min(vp.width, Math.max(...pts.map((p) => p[0]))),
          Math.min(vp.height, Math.max(...pts.map((p) => p[1]))),
        ];
        if (b[2] - b[0] > 90 && b[3] - b[1] > 45) images.push(b);
      }
    }
    pages.push({ rows, images, drawings, paths, size: [vp.width, vp.height] });
    page.cleanup();
    await pause();
  }
  const chars = pages
    .flatMap((p) => p.rows)
    .reduce((a, r) => a + r.text.length, 0);
  if (chars < 200)
    throw new Error(
      "There is too little selectable text to reformat this PDF. Scanned papers need OCR before conversion.",
    );
  if (chars > 600000)
    throw new Error(
      "This document contains too much text for browser conversion. Use a shorter PDF.",
    );
  const excluded = new Set<Row>();
  if (settings.preserveVisuals)
    for (let n = 0; n < pages.length; n++) {
      const page = pages[n],
        {
          rows,
          images,
          size: [w, h],
        } = page;
      const tables = rows.filter((r) => /^Table\s*\d+\s*[.:|]/i.test(r.text));
      if (tables.length && page.paths > 12) {
        for (let i = 0; i < tables.length; i++) {
          const cap = tables[i],
            end =
              tables[i + 1]?.bbox[1] ??
              Math.max(...rows.map((r) => r.bbox[3])) + 3;
          const tableRows = rows.filter(
            (r) => r.bbox[1] >= cap.bbox[1] - 1 && r.bbox[1] < end - 2,
          );
          let bounds = tableRows.reduce((b, r) => merge(b, r.bbox), cap.bbox);
          for (const drawing of page.drawings)
            if (drawing[1] >= cap.bbox[1] && drawing[3] < end)
              bounds = merge(bounds, drawing);
          floats.push({
            id: `table-${n}-${i}`,
            kind: "table",
            label: cap.text,
            source_page: n,
            bbox: [
              Math.max(0, bounds[0] - 2),
              Math.max(0, bounds[1] - 2),
              Math.min(w, bounds[2] + 2),
              Math.min(h, end - 3),
            ],
            anchor: null,
          });
          tableRows.forEach((r) => excluded.add(r));
        }
        rows
          .filter((r) => /^Tables$/i.test(r.text))
          .forEach((r) => excluded.add(r));
        continue;
      }
      let associated = false;
      for (const [index, image] of images.entries()) {
        const cap = rows.find(
          (r) =>
            caption.test(r.text) &&
            !/^Table/i.test(r.text) &&
            r.bbox[1] >= image[3] - 10 &&
            r.bbox[1] - image[3] < 90,
        );
        const legend: Row[] = [];
        if (cap) {
          associated = true;
          let pn = n,
            start = rows.indexOf(cap);
          while (pn < pages.length) {
            const rr = pages[pn].rows;
            let j = start;
            for (; j < rr.length; j++) {
              const r = rr[j];
              if (
                legend.length &&
                (section.test(r.text) ||
                  caption.test(r.text) ||
                  r.size > cap.size * 1.2)
              )
                break;
              legend.push(r);
              excluded.add(r);
            }
            if (
              j < rr.length ||
              !rr.length ||
              rr.at(-1)!.bbox[3] < pages[pn].size[1] - 85
            )
              break;
            pn++;
            start = 0;
            if (
              !pages[pn] ||
              pages[pn].images.length ||
              pages[pn].rows[0]?.bbox[1] > 85
            )
              break;
          }
        }
        rows
          .filter((r) => inside(r.bbox, image) || /^Figures$/i.test(r.text))
          .forEach((r) => excluded.add(r));
        const spans = combine(legend);
        floats.push({
          id: `figure-${n}-${index}`,
          kind: "figure",
          label: cap
            ? cap.text.match(/^(Fig(?:ure)?\.?)\s*\d+/i)![0]
            : `Image from source page ${n + 1}`,
          source_page: n,
          bbox: image,
          anchor: null,
          caption: plain(spans),
          caption_spans: spans,
        });
      }
      if (!images.length && page.paths > 15) {
        const cap = rows.find(
          (r) => caption.test(r.text) && r.bbox[1] > h * 0.3,
        );
        if (cap) {
          const marks = page.drawings.filter(
            (b) =>
              b[1] >= Math.max(settings.top, preprint ? 33 : 0) &&
              b[3] < cap.bbox[1] &&
              b[2] - b[0] > 1 &&
              b[3] - b[1] < h * 0.8,
          );
          if (marks.length) {
            const bounds = marks.reduce(merge);
            const bbox: Box = [
              Math.max(0, bounds[0] - 5),
              Math.max(0, bounds[1] - 5),
              Math.min(w, bounds[2] + 5),
              Math.min(cap.bbox[1] - 3, bounds[3] + 5),
            ];
            const overlapsProse = rows.some(
              (r) =>
                inside(r.bbox, bbox) &&
                (r.text.length > 90 || section.test(r.text)),
            );
            if (!overlapsProse && bbox[3] - bbox[1] > 40) {
              const legend: Row[] = [];
              for (const r of rows.slice(rows.indexOf(cap))) {
                if (
                  legend.length &&
                  (section.test(r.text) ||
                    caption.test(r.text) ||
                    (r.bold && r.text.length < 130))
                )
                  break;
                legend.push(r);
                excluded.add(r);
              }
              const spans = combine(legend);
              floats.push({
                id: `vector-${n}`,
                kind: "figure",
                label:
                  cap.text.match(/^(Fig(?:ure)?\.?)\s*\d+/i)?.[0] ||
                  `Figure from page ${n + 1}`,
                source_page: n,
                bbox,
                anchor: null,
                caption: plain(spans),
                caption_spans: spans,
              });
              rows
                .filter((r) => inside(r.bbox, bbox))
                .forEach((r) => excluded.add(r));
              associated = true;
            }
          }
        }
        if (!associated) {
          floats.push({
            id: `source-${n}`,
            kind: "source-page",
            label: `Source page ${n + 1} · visual reference`,
            source_page: n,
            bbox: [0, 0, w, h],
            anchor: null,
          });
          warnings.push(
            `Source page ${n + 1} has complex vector content retained in the visual appendix; check its extraction.`,
          );
        }
      }
      if (
        rows.reduce((sum, r) => sum + r.text.length, 0) < 50 &&
        !images.length
      ) {
        floats.push({
          id: `scan-${n}`,
          kind: "source-page",
          label: `Source page ${n + 1}`,
          source_page: n,
          bbox: [0, 0, w, h],
          anchor: null,
        });
        warnings.push(
          `Source page ${n + 1} has little selectable text and is preserved as an image.`,
        );
      }
    }
  if (!settings.preserveVisuals)
    warnings.push(
      "Visual preservation was disabled. Figures and non-text content may be absent.",
    );
  const rows = pages.flatMap((p) => p.rows).filter((r) => !excluded.has(r));
  const sizes = new Map<number, number>();
  for (const r of rows)
    if (r.text.length > 50) {
      const s = Math.round(r.size);
      sizes.set(s, (sizes.get(s) ?? 0) + r.text.length);
    }
  const typical = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;
  const first = rows.filter((r) => r.page === 0),
    ai = first.findIndex((r) => /^Abstract$/i.test(r.text));
  const candidates = (ai > 0 ? first.slice(0, ai) : first.slice(0, 12)).filter(
    (r) => !/doi|copyright|license|https?:/i.test(r.text),
  );
  const maxSize = Math.max(...candidates.map((r) => r.size));
  const tr = candidates.find((r) => r.size >= maxSize - 0.5) ?? first[0];
  const titles: Row[] = [tr];
  let ti = first.indexOf(tr) + 1;
  while (
    ti < first.length &&
    first[ti].size >= tr.size - 0.5 &&
    first[ti].bbox[1] - titles.at(-1)!.bbox[3] < typical &&
    tr.size > typical * 1.15
  )
    titles.push(first[ti++]);
  titles.forEach((r) => excluded.add(r));
  const title = plain(combine(titles));
  const front = ai > 0 ? first.slice(ti, ai) : [];
  let affIndex = front.findIndex(
    (r) =>
      /^\d+\s+(Institute|Department|Division|School|University|Faculty|College|Center|Centre|Howard|Herbold|Bioengineering|Inceptive)/i.test(
        r.text,
      ) ||
      (r.spans[0]?.script === "super" && /^\d/.test(r.text)),
  );
  if (affIndex < 0) affIndex = front.length;
  const authorRows = front.slice(0, affIndex),
    affRows = front.slice(affIndex);
  const authorSpans = combine(authorRows),
    affSpans = combine(affRows);
  const abstractRows: Row[] = [];
  if (ai >= 0) {
    excluded.add(first[ai]);
    front.forEach((r) => excluded.add(r));
    const index = rows.indexOf(first[ai]);
    for (let j = index + 1; j < rows.length; j++) {
      const r = rows[j];
      if (
        section.test(r.text) ||
        (r.bold && r.text.length < 130 && r.size >= typical) ||
        r.size > typical * 1.25
      )
        break;
      abstractRows.push(r);
      excluded.add(r);
    }
  } else
    warnings.push(
      "No Abstract heading was found. Check the inferred title and section structure.",
    );
  const blocks: Block[] = [];
  let prev: Row | undefined;
  for (const r of rows.filter((r) => !excluded.has(r))) {
    const kind =
      section.test(r.text) ||
      r.size > typical * 1.2 ||
      (r.bold && r.text.length < 160)
        ? "heading"
        : r.pieces.some((p) => /math|cmmi|cmsy|cmex/i.test(p.font)) &&
            r.text.length < 170 &&
            r.bbox[0] > 75
          ? "equation"
          : "paragraph";
    const last = blocks.at(-1);
    const numbered = /^\d+\.\s/.test(r.text);
    const start =
      !last ||
      !prev ||
      kind !== last.kind ||
      kind === "heading" ||
      kind === "equation" ||
      numbered ||
      (r.page === prev.page &&
        (r.bbox[1] - prev.bbox[3] > typical * 0.7 ||
          r.bbox[0] - prev.bbox[0] > 18)) ||
      (r.page !== prev.page && /[.!?:]$/.test(prev.text));
    if (start)
      blocks.push({
        id: `b${blocks.length.toString().padStart(4, "0")}`,
        kind,
        text: r.text,
        spans: [...r.spans],
        source_pages: [r.page],
        bbox: [...r.bbox],
      });
    else {
      last.text += " " + r.text;
      last.spans.push({ text: " " }, ...r.spans);
      if (r.page === prev!.page) last.bbox = merge(last.bbox, r.bbox);
      if (!last.source_pages.includes(r.page)) last.source_pages.push(r.page);
    }
    prev = r;
  }
  if (settings.preserveVisuals)
    for (const b of blocks)
      if (b.kind === "equation") {
        const [w, h] = pages[b.source_pages[0]].size;
        floats.push({
          id: `eq-${b.id}`,
          kind: "equation",
          label: "Displayed equation",
          source_page: b.source_pages[0],
          bbox: [
            Math.max(0, b.bbox[0] - 3),
            Math.max(0, b.bbox[1] - 3),
            Math.min(w, b.bbox[2] + 3),
            Math.min(h, b.bbox[3] + 3),
          ],
          anchor: b.id,
        });
      }
  const splitRows = rows.filter(
    (r) =>
      !excluded.has(r) &&
      r.pieces.some(
        (p, i) =>
          i > 0 &&
          p.x > pages[r.page].size[0] * 0.42 &&
          p.x < pages[r.page].size[0] * 0.7 &&
          p.x - r.pieces[i - 1].x - r.pieces[i - 1].width > 25,
      ),
  );
  if (splitRows.length > 12)
    warnings.push(
      "Possible multi-column source: compare reading order with the original.",
    );
  for (const f of floats) {
    const num = f.label.match(/(?:Fig(?:ure)?\.?|Table)\s*(\d+)/i)?.[1];
    if (num) {
      const regex = new RegExp(
        `\\b${f.kind === "table" ? "Table" : "Fig(?:ure)?\\.?"}\\s*${num}(?!\\d)`,
        "i",
      );
      f.anchor = blocks.find((b) => regex.test(b.text))?.id ?? null;
    } else if (f.kind === "figure")
      f.anchor =
        blocks.find(
          (b) =>
            b.source_pages.includes(f.source_page) && b.bbox[1] > f.bbox[3],
        )?.id ?? null;
  }
  if (rows.some((r) => r.text.includes("\u0000") || r.text.includes("\ufffd")))
    warnings.push(
      "The source contains unencoded characters. They are marked visibly; compare these words with the original PDF.",
    );
  warnings.push(
    "Paragraphs and reading order are inferred. Compare the result with the original; no wording is intentionally rewritten.",
  );
  const rawDate = firstRaw.match(
    /version posted\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
  )?.[1];
  const date = rawDate ? new Date(rawDate) : undefined;
  return {
    schema_version: "paperform-1",
    source_name: name,
    source_sha256: await hash(bytes),
    metadata: {
      title,
      authors: plain(authorSpans),
      author_spans: authorSpans,
      affiliations: plain(affSpans),
      affiliation_spans: affSpans,
      abstract: plain(combine(abstractRows)),
      abstract_spans: combine(abstractRows),
      doi:
        firstRaw.match(/10\.\d{4,9}\/[\w.()/-]+/)?.[0]?.replace(/\.$/, "") ??
        "",
      posted:
        date && !isNaN(date.getTime())
          ? date.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })
          : (rawDate ?? ""),
      preprint,
    },
    blocks,
    floats,
    warnings,
    extraction: {
      pages: doc.numPages,
      characters: chars,
      page_sizes: pages.map((p) => p.size),
    },
  };
}
