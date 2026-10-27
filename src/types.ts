export type Box = [number, number, number, number];
export type Span = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  script?: "super" | "sub";
};
export type Block = {
  id: string;
  kind: "paragraph" | "heading" | "caption" | "equation";
  text: string;
  spans: Span[];
  source_pages: number[];
  bbox: Box;
};
export type Figure = {
  id: string;
  kind: "figure" | "table" | "equation" | "source-page";
  label: string;
  source_page: number;
  bbox: Box;
  anchor: string | null;
  caption?: string;
  caption_spans?: Span[];
};
export type Manuscript = {
  schema_version: "paperform-1";
  source_name: string;
  source_sha256: string;
  metadata: {
    title: string;
    authors: string;
    doi: string;
    author_spans?: Span[];
    abstract?: string;
    abstract_spans?: Span[];
    affiliations?: string;
    affiliation_spans?: Span[];
    posted?: string;
    preprint?: boolean;
  };
  blocks: Block[];
  floats: Figure[];
  warnings: string[];
  extraction: {
    pages: number;
    characters: number;
    page_sizes: [number, number][];
  };
};
export type Settings = {
  bodySize: number;
  top: number;
  bottom: number;
  preserveVisuals: boolean;
};
export type ReferenceFont = {
  name: string;
  data: Uint8Array;
  unicodeMap?: [number, number][];
};
export type TypographyReference = {
  name: string;
  width: number;
  height: number;
  fonts: ReferenceFont[];
};
export type Progress = (percent: number, label: string) => void;
export type Report = {
  source: string;
  source_sha256: string;
  output_pages: number;
  source_pages: number;
  blocks: number;
  visual_regions: number;
  missing_glyphs: string[];
  warnings: string[];
  text_check: { checked_blocks: number; unmatched_blocks: string[] };
  note: string;
  visual_pages?: Record<string, number>;
  typography?: {
    reference?: string;
    width: number;
    height: number;
    body_size: number;
    fonts: string[];
  };
};
export type ImageAsset = {
  id: string;
  sourcePage: number;
  bounds: { left: number; bottom: number; right: number; top: number };
  matrix: [number, number, number, number, number, number];
  width: number;
  height: number;
};
