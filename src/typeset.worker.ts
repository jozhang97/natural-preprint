import {
  PDFDocument,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFPage,
  type PDFEmbeddedPage,
  beginMarkedContent,
  endMarkedContent,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type {
  ImageAsset,
  Manuscript,
  Report,
  Settings,
  Span,
  TypographyReference,
  ReferenceFont,
  Figure,
} from "./types";

type Input = {
  manuscript: Manuscript;
  settings: Settings;
  assets: ImageAsset[];
  sourceBytes?: Uint8Array;
  fonts: ArrayBuffer[];
  reference?: TypographyReference;
};
type Token = {
  text: string;
  font: PDFFont;
  size: number;
  shift: number;
  width: number;
};
type Line = { tokens: Token[]; indent: number; width: number };
self.onmessage = async ({ data }: MessageEvent<Input>) => {
  try {
    const { manuscript: m, settings, assets, reference } = data;
    const doc = await PDFDocument.create();
    const fontMappings = new Map<Uint8Array, ReferenceFont>();
    doc.registerFontkit({
      create(bytes: Uint8Array) {
        const font = fontkit.create(bytes);
        const ref = fontMappings.get(bytes);
        if (ref?.unicodeMap?.length) {
          const mapping = new Map(ref.unicodeMap),
            original = font.glyphForCodePoint.bind(font);
          Object.defineProperty(font, "characterSet", {
            value: [...mapping.keys()],
          });
          font.glyphForCodePoint = (cp: number) => {
            const glyph = original(mapping.get(cp) ?? 0);
            // Preserve the original Unicode value for the generated PDF's ToUnicode.
            const result = Object.create(glyph);
            result.codePoints = [cp];
            return result;
          };
          font.hasGlyphForCodePoint = (cp: number) => mapping.has(cp);
        }
        return font;
      },
    });
    const defaults = await Promise.all(
      data.fonts.map((b) => doc.embedFont(b, { subset: true })),
    );
    const sans = await doc.embedFont(StandardFonts.Helvetica),
      sansbold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fonts: PDFFont[] = [
      ...defaults.slice(0, 4),
      defaults[1],
      sans,
      sansbold,
      defaults[1],
    ];
    const imported = new Map<string, PDFFont>();
    for (const f of reference?.fonts ?? []) {
      try {
        fontMappings.set(f.data, f);
        imported.set(f.name, await doc.embedFont(f.data, { subset: true }));
      } catch {
        /* Other reference faces and the bundled fonts remain usable. */
      }
    }
    const find = (pattern: RegExp) =>
      [...imported].find(([name]) => pattern.test(name))?.[1];
    fonts[0] = find(/^HardingText-Regular$/i) ?? fonts[0];
    fonts[1] = find(/^HardingText-Bold$/i) ?? fonts[1];
    fonts[2] = find(/^HardingText-RegularItalic$/i) ?? fonts[2];
    fonts[3] = fonts[1] === defaults[1] ? defaults[3] : fonts[1];
    fonts[4] = find(/^Harding-Bold$/i) ?? fonts[4];
    fonts[5] = find(/^GraphikNaturel-Regular$/i) ?? fonts[5];
    fonts[6] = find(/^GraphikNaturel-Semibold$/i) ?? fonts[6];
    fonts[7] = find(/^Harding-Extrabold$/i) ?? fonts[7];
    const fallbacks = [
      ...[...imported]
        .filter(([name]) => !/Harding|Graphik/i.test(name))
        .map(([, f]) => f),
      ...defaults,
    ];
    const sets = new Map<PDFFont, Set<number>>(
      [...new Set([...fonts, ...fallbacks])].map((f) => [
        f,
        new Set(f.getCharacterSet()),
      ]),
    );
    const missing = new Set<string>();
    const W = reference?.width ?? 595.276,
      H = reference?.height ?? 790.866;
    const left = 39.685,
      right = 32.59,
      gap = 10.4,
      full = W - left - right,
      cw = (full - gap) / 2;
    const ink = rgb(0, 0, 0),
      gray = rgb(0.65, 0.65, 0.65);
    let page!: PDFPage;
    let y = 0,
      col = 0,
      top = 0,
      firstFloor = 70;
    const layoutSchedule = new Map<number, Figure[]>(),
      drawn = new Set<string>();
    const visualPages: Record<string, number> = {};
    const images = new Map<
      string,
      { asset: ImageAsset; image: PDFEmbeddedPage }
    >();
    if (assets.length) {
      const source = await PDFDocument.load(data.sourceBytes!);
      const embedded = await doc.embedPages(
        assets.map((a) => source.getPage(a.sourcePage)),
        assets.map((a) => a.bounds),
        assets.map((a) => a.matrix),
      );
      assets.forEach((asset, i) =>
        images.set(asset.id, { asset, image: embedded[i] }),
      );
    }
    function drawArtwork(
      data: { asset: ImageAsset; image: PDFEmbeddedPage },
      x: number,
      y: number,
      width: number,
      height: number,
    ) {
      page.pushOperators(beginMarkedContent("PaperformVisual"));
      page.drawPage(data.image, {
        x,
        y,
        xScale: width / data.asset.width,
        yScale: height / data.asset.height,
      });
      page.pushOperators(endMarkedContent());
    }
    const widths = new Map<string, number>();
    function tokens(
      spans: Span[],
      size: number,
      role = 0,
      bold = false,
    ): Token[] {
      const result: Token[] = [];
      for (const s of spans) {
        const index =
          role === 0 ? (bold || s.bold ? 1 : 0) + (s.italic ? 2 : 0) : role;
        const fs = s.script ? size * 0.8 : size,
          shift =
            s.script === "super"
              ? size * 0.5
              : s.script === "sub"
                ? -size * 0.18
                : 0;
        // Fallback by character, but keep runs in one font for normal shaping.
        const runs: { text: string; font: PDFFont }[] = [];
        for (let ch of s.text) {
          if (/\s/.test(ch)) ch = " ";
          const cp = ch.codePointAt(0)!;
          let font = fonts[index];
          if (!sets.get(font)!.has(cp))
            font = fallbacks.find((f) => sets.get(f)!.has(cp)) ?? font;
          if (cp < 32 || !sets.get(font)!.has(cp)) {
            missing.add(ch);
            ch = "?";
            font = defaults[0];
          }
          const last = runs.at(-1);
          if (last?.font === font) last.text += ch;
          else runs.push({ text: ch, font });
        }
        for (const run of runs)
          for (const piece of run.text.split(/(\s+)/).filter(Boolean)) {
            const text = /^\s+$/.test(piece) ? " " : piece,
              key = `${run.font.ref.tag}/${fs}/${text}`;
            let width = widths.get(key);
            if (width === undefined) {
              width = run.font.widthOfTextAtSize(text, fs);
              widths.set(key, width);
            }
            result.push({ text, font: run.font, size: fs, shift, width });
          }
      }
      return result;
    }
    function wrap(
      spans: Span[],
      width: number,
      size: number,
      role = 0,
      bold = false,
      indent = 0,
    ): Line[] {
      const lines: Line[] = [];
      let line: Token[] = [],
        used = 0;
      const flush = () => {
        while (line.at(-1)?.text === " ") line.pop();
        if (line.length)
          lines.push({
            tokens: line,
            indent: lines.length ? 0 : indent,
            width: line.reduce((s, t) => s + t.width, 0),
          });
        line = [];
        used = 0;
      };
      for (const token of tokens(spans, size, role, bold)) {
        const available = width - (lines.length ? 0 : indent);
        if (used + token.width > available && token.text !== " ") {
          const lastSpace = line.map((t) => t.text).lastIndexOf(" "),
            tail = lastSpace >= 0 ? line.slice(lastSpace + 1) : [];
          const tw = tail.reduce((s, t) => s + t.width, 0);
          if (tail.length && tw + token.width <= width) {
            line = line.slice(0, lastSpace);
            flush();
            line = tail;
            used = tw;
          } else flush();
        }
        if (token.text === " " && !line.length) continue;
        if (token.width > width) {
          for (const ch of token.text) {
            const w = token.font.widthOfTextAtSize(ch, token.size);
            if (used + w > width - (lines.length ? 0 : indent)) flush();
            line.push({ ...token, text: ch, width: w });
            used += w;
          }
        } else {
          line.push(token);
          used += token.width;
        }
      }
      flush();
      return lines;
    }
    function drawLine(
      line: Line,
      x: number,
      baseline: number,
      width: number,
      justify = false,
    ) {
      x += line.indent;
      const spaces = line.tokens.filter((t) => t.text === " ").length;
      const extra =
        justify && spaces
          ? Math.max(0, (width - line.indent - line.width) / spaces)
          : 0;
      for (const t of line.tokens) {
        page.drawText(t.text, {
          x,
          y: baseline + t.shift,
          size: t.size,
          font: t.font,
          color: ink,
        });
        x += t.width + (t.text === " " ? extra : 0);
      }
    }
    function fixed(
      spans: Span[],
      x: number,
      baseline: number,
      width: number,
      size: number,
      leading: number,
      role = 0,
      bold = false,
      justify = false,
    ) {
      const lines = wrap(spans, width, size, role, bold);
      for (let i = 0; i < lines.length; i++)
        drawLine(
          lines[i],
          x,
          baseline - i * leading,
          width,
          justify && i < lines.length - 1,
        );
      return lines.length * leading;
    }
    function lineRule(at: number, x = left, width = full) {
      page.drawLine({
        start: { x, y: at },
        end: { x: x + width, y: at },
        thickness: 0.35,
        color: gray,
      });
    }
    const floor = () => (doc.getPageCount() === 1 ? firstFloor : 45);
    function visualHeight(f: Figure) {
      const a = images.get(f.id);
      if (!a) return 0;
      const captionLines = wrap(
        f.caption_spans?.length ? f.caption_spans : [{ text: f.caption ?? "" }],
        cw,
        7,
      );
      const capHeight = Math.ceil(captionLines.length / 2) * 9;
      const maxHeight = Math.min(460, H - 120 - capHeight);
      return (
        Math.min(full / a.asset.width, maxHeight / a.asset.height) *
          a.asset.height +
        capHeight +
        (f.caption ? 20 : 12)
      );
    }
    function drawVisual(f: Figure) {
      const data = images.get(f.id);
      if (!data || drawn.has(f.id)) return;
      drawn.add(f.id);
      visualPages[f.id] = doc.getPageCount();
      const lines = wrap(
          f.caption_spans?.length
            ? f.caption_spans
            : [{ text: f.caption ?? "" }],
          cw,
          7,
        ),
        split = Math.ceil(lines.length / 2);
      const capHeight = split * 9,
        maxHeight = Math.min(460, H - 120 - capHeight),
        scale = Math.min(
          full / data.asset.width,
          maxHeight / data.asset.height,
        );
      const w = data.asset.width * scale,
        h = data.asset.height * scale;
      drawArtwork(data, left + (full - w) / 2, y - h, w, h);
      y -= h;
      if (lines.length) {
        y -= 9;
        for (let i = 0; i < lines.length; i++) {
          const c = i < split ? 0 : 1,
            row = i < split ? i : i - split;
          drawLine(lines[i], left + c * (cw + gap), y - row * 9, cw, false);
        }
        y -= capHeight;
      }
      y -= 10;
      lineRule(y + 3);
      y -= 8;
    }
    function newPage(appendix = false) {
      if (doc.getPageCount() >= 250)
        throw new Error(
          "The formatted document exceeds 250 pages. Use a shorter manuscript.",
        );
      page = doc.addPage([W, H]);
      col = 0;
      y = H - 49;
      fixed(
        [{ text: appendix ? "Visual reference" : "Article" }],
        left,
        H - 38.56,
        full,
        14,
        16,
        7,
      );
      lineRule(H - 44.5);
      const footer = [
        m.metadata.preprint ? "Preprint" : "Natural Preprint",
        m.metadata.posted,
        `${doc.getPageCount()}`,
      ]
        .filter(Boolean)
        .join("  |  ");
      const footerWidth = tokens([{ text: footer }], 7, 5).reduce(
        (s, t) => s + t.width,
        0,
      );
      fixed(
        [{ text: footer }],
        W - right - footerWidth,
        20,
        footerWidth + 1,
        7,
        8,
        5,
      );
      if (!appendix && doc.getPageCount() > 1)
        for (const f of layoutSchedule.get(doc.getPageCount()) ?? [])
          drawVisual(f);
      top = y - 8;
      y = top;
    }
    function advance() {
      if (col === 0) {
        col = 1;
        y = top;
      } else newPage();
    }
    function ensure(h: number) {
      if (y - h < floor()) advance();
      if (y - h < floor()) newPage();
    }
    function body(
      spans: Span[],
      size: number,
      heading = false,
      referenceText = false,
    ) {
      const leading = heading
          ? 10.5
          : referenceText
            ? 8
            : size * (10.75 / 8.25),
        indent = heading || referenceText ? 0 : size;
      const lines = wrap(
        spans,
        cw,
        size,
        referenceText ? 5 : 0,
        heading,
        indent,
      );
      if (heading) {
        ensure(leading * 3 + 15.5);
        y -= 15.5;
      }
      for (let i = 0; i < lines.length; i++) {
        ensure(leading);
        drawLine(
          lines[i],
          left + col * (cw + gap),
          y,
          cw,
          !heading && !referenceText && i < lines.length - 1,
        );
        y -= leading;
      }
      y += heading ? -3 : referenceText ? -2 : 0;
    }
    doc.setTitle(m.metadata.title);
    doc.setAuthor(m.metadata.authors);
    doc.setCreator("Natural Preprint · local article reformatting");
    newPage();
    const titleLines = wrap([{ text: m.metadata.title }], full, 26, 4);
    y = H - 75;
    for (const l of titleLines) {
      drawLine(l, left, y, full);
      y -= 28;
    }
    y -= 18;
    lineRule(y + 13);
    const frontY = y,
      ax = left + full * (177.615 / 523.001),
      aw = W - right - ax;
    const authors = m.metadata.author_spans?.length
      ? m.metadata.author_spans
      : [{ text: m.metadata.authors }];
    const abstract = m.metadata.abstract_spans?.length
      ? m.metadata.abstract_spans
      : [{ text: m.metadata.abstract ?? "" }];
    const aff = m.metadata.affiliation_spans?.length
      ? m.metadata.affiliation_spans
      : [{ text: m.metadata.affiliations ?? "" }];
    const affLines = wrap(aff, full, 6, 5),
      affHeight = affLines.length * 7.8;
    firstFloor = Math.max(affHeight ? 130 : 70, affHeight + 70);
    const authorHeight = wrap(authors, aw, 8, 6).length * 11;
    const abstractHeight = wrap(abstract, aw, 9).length * 12;
    const hasFront = !!(m.metadata.authors || m.metadata.abstract);
    if (
      hasFront &&
      frontY - authorHeight - abstractHeight - 30 > firstFloor + 35
    ) {
      let metaY = frontY + 0.2;
      const sidebarWidth = full * (166 / 523.001);
      const details = [
        m.metadata.doi ? `doi: ${m.metadata.doi}` : "",
        m.metadata.posted ? `Posted: ${m.metadata.posted}` : "",
        m.metadata.preprint ? "bioRxiv preprint" : "Reformatted Natural Preprint",
        m.metadata.preprint ? "Not peer reviewed" : "",
      ];
      for (const [i, s] of details.entries())
        if (s) {
          const leading = 10;
          const h = fixed(
            [{ text: s }],
            left,
            metaY,
            sidebarWidth,
            i === 0 ? 6.8 : 8,
            leading,
            5,
          );
          // fixed() returns line count × leading, not the last baseline.
          // Place the rule below the final line, then leave room above the next row.
          const lastBaseline = metaY - h + leading;
          const dividerY = lastBaseline - (i === 0 ? 6.2 : 5);
          lineRule(dividerY, left, sidebarWidth);
          metaY = dividerY - (i === 0 ? 13 : 11);
        }
      y -= fixed(authors, ax, y, aw, 8, 11, 6);
      if (authorHeight) {
        y -= 19;
        lineRule(y + 14, ax, aw);
      }
      y -= fixed(abstract, ax, y, aw, 9, 12);
      y -= 12;
      lineRule(y + 5);
      y -= 8.25;
      top = y;
      if (affLines.length) {
        lineRule(firstFloor - 5);
        for (let i = 0; i < affLines.length; i++)
          drawLine(affLines[i], left, firstFloor - 16 - i * 7.8, full);
      }
    } else {
      // Long front matter must flow rather than overlap affiliations or body text.
      firstFloor = 45;
      top = y;
      for (const [spans, size] of [
        [authors, 8],
        [abstract, 9],
        [aff, 6],
      ] as const)
        if (spans.some((s) => s.text)) body([...spans], size);
      y -= 12;
      top = y;
    }
    // A measurement pass places full-width visuals at the page where their
    // first citation would occur. Preserve citation order and reserve consecutive
    // pages when several plates compete for the same page; tables can share one.
    const estimated = new Map<string, number>();
    let ep = 1,
      ey = y,
      ec = 0,
      et = top,
      refs = false;
    const eAdvance = () => {
      if (ec === 0) {
        ec = 1;
        ey = et;
      } else {
        ep++;
        ec = 0;
        et = H - 57;
        ey = et;
      }
    };
    const eEnsure = (h: number) => {
      if (ey - h < (ep === 1 ? firstFloor : 45)) eAdvance();
    };
    for (const b of m.blocks) {
      if (/^(references|bibliography)$/i.test(b.text.trim())) refs = true;
      const heading = b.kind === "heading",
        size = heading ? 9.75 : refs ? 6.3 : settings.bodySize;
      const lead = heading ? 10.5 : refs ? 8 : size * (10.75 / 8.25);
      const lines = wrap(
        b.spans,
        cw,
        size,
        refs && !heading ? 5 : 0,
        heading,
        heading || refs ? 0 : size,
      );
      if (heading) {
        eEnsure(lead * 3 + 15.5);
        ey -= 15.5;
      }
      eEnsure(lead);
      estimated.set(b.id, ep);
      for (const _line of lines) {
        eEnsure(lead);
        ey -= lead;
      }
      ey += heading ? -3 : refs ? -2 : 0;
    }
    const order = new Map(m.blocks.map((b, i) => [b.id, i]));
    const ordered = m.floats
      .filter((f) => f.kind !== "source-page" && f.kind !== "equation")
      .sort(
        (a, b) =>
          (order.get(a.anchor ?? "") ?? 1e9) -
            (order.get(b.anchor ?? "") ?? 1e9) ||
          (a.kind === "table" ? 1 : 0) - (b.kind === "table" ? 1 : 0),
      );
    let lastSlot = 1;
    const assigned = new Set<string>();
    for (const f of ordered) {
      if (assigned.has(f.id)) continue;
      const group = [f];
      assigned.add(f.id);
      if (f.kind === "table")
        for (const other of ordered)
          if (
            other.kind === "table" &&
            other.source_page === f.source_page &&
            !assigned.has(other.id) &&
            group.reduce((sum, g) => sum + visualHeight(g), 0) +
              visualHeight(other) <
              H - 105
          ) {
            group.push(other);
            assigned.add(other.id);
          }
      const slot = Math.max(
        2,
        estimated.get(f.anchor ?? "") ?? ep + 1,
        lastSlot + 1,
      );
      layoutSchedule.set(slot, group);
      lastSlot = slot;
    }
    let references = false;
    for (const [i, b] of m.blocks.entries()) {
      if (i % 12 === 0)
        self.postMessage({
          type: "progress",
          percent: 66 + (23 * i) / m.blocks.length,
          label: `Typesetting section ${i + 1} of ${m.blocks.length}`,
        });
      const eq = m.floats.find(
        (f) => f.kind === "equation" && f.anchor === b.id,
      );
      if (eq && images.has(eq.id)) {
        const data = images.get(eq.id)!,
          scale = Math.min(cw / data.asset.width, 1),
          height = data.asset.height * scale;
        ensure(height + 10);
        drawArtwork(
          data,
          left + col * (cw + gap),
          y - height,
          data.asset.width * scale,
          height,
        );
        y -= height + 10;
        drawn.add(eq.id);
        continue;
      }
      if (/^(references|bibliography)$/i.test(b.text.trim())) references = true;
      body(
        b.spans,
        b.kind === "heading" ? 9.75 : references ? 6.3 : settings.bodySize,
        b.kind === "heading",
        references && b.kind !== "heading",
      );
    }
    while (doc.getPageCount() < lastSlot) newPage();
    for (const f of m.floats.filter((f) => f.kind === "source-page")) {
      newPage(true);
      drawVisual(f);
    }
    const bytes = await doc.save(),
      warnings = [...m.warnings];
    if (missing.size)
      warnings.push(
        `Some source characters could not be represented and are marked with ?: ${[...missing].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`).join(", ")}. Compare them with the original.`,
      );
    if (reference && !find(/^HardingText-Regular$/i))
      warnings.push(
        "The reference did not contain a supported Harding text font; bundled serif fonts were used.",
      );
    const report: Report = {
      source: m.source_name,
      source_sha256: m.source_sha256,
      source_pages: m.extraction.pages,
      output_pages: doc.getPageCount(),
      blocks: m.blocks.length,
      visual_regions: assets.length,
      missing_glyphs: [...missing],
      warnings,
      text_check: { checked_blocks: 0, unmatched_blocks: [] },
      visual_pages: visualPages,
      typography: {
        reference: reference?.name,
        width: W,
        height: H,
        body_size: settings.bodySize,
        fonts: fonts.map((f) => f.name),
      },
      note: "Compare the Natural Preprint against the original. Text checks cover the extracted manuscript, not completeness of source extraction. The reference controls typography, not its annotations or editorial changes.",
    };
    self.postMessage({ type: "done", bytes, report });
  } catch (error) {
    self.postMessage({
      type: "error",
      message:
        error instanceof Error ? error.message : "PDF generation failed.",
    });
  }
};
