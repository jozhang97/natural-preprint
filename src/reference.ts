import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import type { ReferenceFont, TypographyReference } from "./types";

// PDF subsets can use arbitrary character codes. Keep their ToUnicode map so
// imported Greek letters and punctuation are not silently interpreted as ASCII.
function unicodeMap(stream: PDFRawStream): [number, number][] {
  const source = new TextDecoder().decode(decodePDFRawStream(stream).decode());
  const result = new Map<number, number>();
  const add = (code: number, hex: string) => {
    const units = hex.match(/.{4}/g)?.map((x) => parseInt(x, 16));
    if (!units) return;
    const text = String.fromCharCode(...units);
    if ([...text].length === 1 && text.codePointAt(0)! > 0)
      result.set(text.codePointAt(0)!, code);
  };
  for (const section of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of section[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi))
      add(parseInt(m[1], 16), m[2]);
  for (const section of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of section[1].matchAll(
      /<([\da-f]+)>\s*<([\da-f]+)>\s*(<([\da-f]+)>|\[([^\]]+)\])/gi,
    )) {
      const start = parseInt(m[1], 16),
        end = Math.min(parseInt(m[2], 16), start + 65535);
      const array = m[5]?.match(/<([\da-f]+)>/gi);
      for (let code = start; code <= end; code++) {
        const hex = array
          ? array[code - start]?.slice(1, -1)
          : (parseInt(m[4], 16) + code - start)
              .toString(16)
              .padStart(m[4].length, "0");
        if (hex) add(code, hex);
      }
    }
  }
  return [...result];
}

export async function readReference(
  bytes: Uint8Array,
  name: string,
): Promise<TypographyReference> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (!doc.getPageCount())
    throw new Error("The typography reference has no pages.");
  const { width, height } = doc.getPage(0).getSize();
  if (width < 400 || width > 800 || height < 500 || height > 1100)
    throw new Error("Choose a reference with standard portrait article pages.");
  const fonts: ReferenceFont[] = [];
  const seen = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (
      !(obj instanceof PDFDict) ||
      obj.get(PDFName.of("Type"))?.toString() !== "/Font"
    )
      continue;
    let descriptor = obj.lookup(PDFName.of("FontDescriptor"));
    if (!(descriptor instanceof PDFDict)) {
      const descendants = obj.lookup(PDFName.of("DescendantFonts"));
      if (descendants instanceof PDFArray) {
        const child = descendants.lookup(0);
        if (child instanceof PDFDict)
          descriptor = child.lookup(PDFName.of("FontDescriptor"));
      }
    }
    if (!(descriptor instanceof PDFDict)) continue;
    const fontName = (descriptor.get(PDFName.of("FontName"))?.toString() || "")
      .replace(/^\//, "")
      .replace(/^[A-Z]{6}\+/, "");
    if (!fontName || seen.has(fontName)) continue;
    const file =
      descriptor.lookup(PDFName.of("FontFile2")) ??
      descriptor.lookup(PDFName.of("FontFile3"));
    if (!(file instanceof PDFRawStream)) continue;
    const data = decodePDFRawStream(file).decode();
    // Raw CFF subsets need a proper OpenType wrapper; do not pretend they can
    // be embedded directly. TrueType/OpenType references are supported here.
    if (
      data.length < 4 ||
      !(
        (data[0] === 0 && data[1] === 1) ||
        new TextDecoder().decode(data.slice(0, 4)) === "OTTO"
      )
    )
      continue;
    const toUnicode = obj.lookup(PDFName.of("ToUnicode"));
    fonts.push({
      name: fontName,
      data,
      unicodeMap:
        toUnicode instanceof PDFRawStream ? unicodeMap(toUnicode) : undefined,
    });
    seen.add(fontName);
  }
  if (!fonts.length)
    throw new Error(
      "No reusable TrueType or OpenType fonts were found in this PDF. The bundled article fonts are still available.",
    );
  return { name, width, height, fonts };
}
