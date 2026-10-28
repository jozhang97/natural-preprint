import "./style.css";
import { initAnalytics, trackUsage } from "./analytics";
import {
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import { convert } from "./convert";
import {
  extract,
  fetchPdf,
  hash,
  MAX_BYTES,
  openPdf,
  pdfOptions,
  validateManifest,
} from "./pdf";
import type {
  Manuscript,
  Report,
  Settings,
  TypographyReference,
} from "./types";

initAnalytics();

const arrow =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
const fileIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 13h8m-8 4h5"/></svg>';
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <a class="skip-link" href="#workspace">Skip to converter</a>
  <header class="site-header wrap">
    <a class="brand" href="./" aria-label="Natural Preprint home"><span class="brand-icon">${fileIcon}</span>Natural Preprint</a>
  </header>
  <main>
    <section class="workspace wrap" id="workspace" aria-labelledby="workspace-title">
      <div class="converter" id="converter">
        <div class="card-header"><div><h1 id="workspace-title">Start with a paper.</h1></div></div>
        <div class="input-tabs" role="tablist" aria-label="PDF input method"><button id="upload-tab" role="tab" aria-selected="true" aria-controls="upload-panel" type="button">${fileIcon} Upload PDF</button><button id="link-tab" role="tab" aria-selected="false" aria-controls="link-panel" tabindex="-1" type="button"><span aria-hidden="true">↗</span> Paste a link</button></div>
        <div id="upload-panel" role="tabpanel" aria-labelledby="upload-tab">
          <button class="dropzone" id="dropzone" type="button"><span class="upload-icon">${fileIcon}<span>+</span></span><strong id="file-name">Drop your paper here</strong><span id="file-description">or <u>browse files</u> to get started</span><small>PDF · up to 100 MB · 80 pages</small></button>
          <input id="file-input" type="file" accept="application/pdf,.pdf" hidden />
        </div>
        <div id="link-panel" role="tabpanel" aria-labelledby="link-tab" hidden><label for="pdf-url">Direct PDF link</label><div class="url-field"><span aria-hidden="true">↗</span><input type="url" id="pdf-url" placeholder="https://example.org/paper.pdf" autocomplete="off" spellcheck="false" /></div><p class="field-help">Use a public link to the PDF itself. Some websites block browser access; download the paper and upload it here if that happens.</p></div>
        
        <details class="settings"><summary>Layout preferences <span>Two columns · Serif type</span></summary><div class="settings-grid"><label>Text size<select id="body-size"><option value="8.25" selected>Journal · 8.25 pt</option><option value="9">Compact · 9 pt</option><option value="10">Comfortable · 10 pt</option><option value="11">Large · 11 pt</option></select></label><label>Trim top margin <span class="unit">PDF points</span><input id="trim-top" type="number" min="0" max="100" value="33" /></label><label>Trim bottom margin <span class="unit">PDF points</span><input id="trim-bottom" type="number" min="0" max="100" value="20" /></label></div><div class="reference-picker"><label for="reference-input">Typography reference PDF <span>(experimental)</span></label><input id="reference-input" type="file" accept="application/pdf,.pdf" /><p id="reference-status" class="field-help">Using bundled fonts. To match another article’s typography, choose its PDF here before converting. It stays on your device.</p><button id="clear-reference" type="button" class="text-button" hidden>Use bundled fonts instead</button></div><label class="check-label"><input id="preserve-visuals" type="checkbox" checked /> Preserve figures and visual source pages</label><p class="field-help">Figures and tables appear near their first citation. Uncertain artwork is kept in a visual appendix. Margin trimming removes running headers and footers from extracted text.</p></details>
        <div id="error" class="error-box" role="alert" hidden></div>
        <button class="primary convert-button" id="convert-button" type="button" disabled>Reformat paper ${arrow}</button>
        <div class="card-bottom"><button class="text-button" id="demo-button" type="button">Try a sample <span aria-hidden="true">↗</span></button></div>
      </div>
      <aside class="workspace-aside"><h2>A clearer reading layout</h2><p>Create a Natural Preprint with two readable columns, without rewriting the text.</p><p>Everything runs in your browser.</p><p><strong>Best for single-column preprints with selectable text.</strong></p></aside>
    </section>

    <section id="progress-section" class="wrap" hidden aria-labelledby="progress-title"><div class="progress-card"><div class="progress-top"><span class="working-icon">${fileIcon}</span><div><h2 id="progress-title">Preparing your paper</h2></div><button id="cancel-button" class="secondary" type="button">Cancel</button></div><div class="progress-meta"><span id="progress-label" role="status">Reading your PDF</span><span id="progress-percent">0%</span></div><progress id="progress-bar" value="0" max="100" aria-label="Conversion progress"></progress><p>Processing locally on your device. Larger papers can take a little longer.</p></div></section>

    <section id="results" class="wrap results" hidden aria-labelledby="results-title"><div class="results-heading"><div><h2 id="results-title" tabindex="-1">Your Natural Preprint is ready.</h2><p id="result-summary"></p></div><button class="primary" id="download-pdf" type="button">Download PDF <span aria-hidden="true">↓</span></button></div><div class="review-note"><span aria-hidden="true">ⓘ</span><p>Take a moment to compare. PDF structure is inferred, so paragraphs, symbols, and figures may need a closer look.</p></div><div class="preview-grid"><article class="preview-pane"><div class="preview-heading"><h3>Original</h3><span id="original-count"></span></div><div class="canvas-stage" tabindex="0" role="region" aria-label="Scrollable original PDF preview"><canvas id="original-canvas" aria-label="Original PDF page preview"></canvas></div><div class="page-controls"><button id="original-prev" type="button" aria-label="Previous original page">←</button><span id="original-page"></span><button id="original-next" type="button" aria-label="Next original page">→</button></div></article><article class="preview-pane"><div class="preview-heading"><h3>Natural Preprint</h3><span class="preview-badge">REFORMATTED</span></div><div class="canvas-stage" tabindex="0" role="region" aria-label="Scrollable reformatted PDF preview"><canvas id="output-canvas" aria-label="Reformatted PDF page preview"></canvas></div><div class="page-controls"><button id="output-prev" type="button" aria-label="Previous reformatted page">←</button><span id="output-page"></span><button id="output-next" type="button" aria-label="Next reformatted page">→</button></div></article></div><p id="preview-error" class="error-box" hidden role="alert"></p><details class="review-details"><summary><span>Extraction notes & text checks</span><span id="warning-count"></span></summary><p id="text-check-summary"></p><ul id="warning-list"></ul></details><div class="result-actions"><button class="secondary" id="edit-manuscript" type="button">Edit manuscript</button><button class="text-button" id="download-json" type="button">Download manuscript JSON ↓</button><button class="text-button" id="download-report" type="button">Download report ↓</button><button class="text-button start-over" id="start-over" type="button">Start another paper ${arrow}</button></div></section>

    <p class="wrap field-help">When enabled, usage analytics count visits, conversions, and downloads. PDF contents, filenames, and pasted links are excluded.</p>
  </main>
  <dialog id="editor-dialog" aria-labelledby="editor-title"><div class="dialog-heading"><div><div class="eyebrow">FINE-TUNE THE DETAILS</div><h2 id="editor-title">Edit your manuscript</h2></div><button class="icon-button" id="close-editor" aria-label="Close editor" type="button">×</button></div><p>Edit text, block types, or visual crop boxes, then render again. If you change a block’s text, its formatting resets unless you also update its spans. Crop coordinates use PDF points from the top left; source pages start at zero.</p><label class="sr-only" for="manifest-editor">Manuscript JSON</label><textarea id="manifest-editor" spellcheck="false"></textarea><div id="editor-error" class="error-box" role="alert" hidden></div><div class="dialog-actions"><button class="secondary" id="import-json" type="button">Import JSON</button><input id="json-input" type="file" accept="application/json,.json" hidden /><button class="primary" id="render-edits" type="button">Render changes ${arrow}</button></div></dialog>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id)! as T;
let inputMode: "upload" | "link" = "upload",
  selectedFile: File | undefined;
let sourceBytes: Uint8Array | undefined,
  sourceDoc: PDFDocumentProxy | undefined,
  outputDoc: PDFDocumentProxy | undefined;
let manuscript: Manuscript | undefined,
  report: Report | undefined,
  outputBytes: Uint8Array | undefined;
let controller: AbortController | undefined,
  busy = false;
let typographyReference: TypographyReference | undefined;
let referenceLoading = false;
const previews: Record<
  string,
  { page: number; version: number; task?: RenderTask }
> = { original: { page: 1, version: 0 }, output: { page: 1, version: 0 } };

function showError(message: string) {
  $("error").textContent = message;
  $("error").hidden = false;
}
function clearError() {
  $("error").hidden = true;
}
function updateButton() {
  $<HTMLButtonElement>("convert-button").disabled =
    busy ||
    referenceLoading ||
    (inputMode === "upload"
      ? !selectedFile
      : !$<HTMLInputElement>("pdf-url").value.trim());
}
function selectTab(mode: "upload" | "link") {
  inputMode = mode;
  for (const tab of ["upload", "link"]) {
    $(tab + "-tab").setAttribute("aria-selected", String(tab === mode));
    $(tab + "-tab").tabIndex = tab === mode ? 0 : -1;
    $(tab + "-panel").hidden = tab !== mode;
  }
  clearError();
  updateButton();
}
for (const mode of ["upload", "link"] as const) {
  $(mode + "-tab").addEventListener("click", () => selectTab(mode));
  $(mode + "-tab").addEventListener("keydown", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next =
        e.key === "Home"
          ? "upload"
          : e.key === "End"
            ? "link"
            : mode === "upload"
              ? "link"
              : "upload";
      selectTab(next);
      $(next + "-tab").focus();
    }
  });
}
function chooseFile(file: File) {
  clearError();
  if (file.size > MAX_BYTES) {
    showError(
      "This file exceeds the 100 MB limit. Please choose a smaller PDF.",
    );
    return;
  }
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    showError("Please choose a PDF file.");
    return;
  }
  selectedFile = file;
  selectTab("upload");
  $("file-name").textContent = file.name;
  $("file-description").textContent =
    `${(file.size / 1024 / 1024).toFixed(2)} MB · Click to choose a different paper`;
  $("dropzone").classList.add("has-file");
  updateButton();
}
$("dropzone").addEventListener("click", () =>
  $<HTMLInputElement>("file-input").click(),
);
$("file-input").addEventListener("change", () => {
  const f = $<HTMLInputElement>("file-input").files?.[0];
  if (f) chooseFile(f);
});
for (const type of ["dragenter", "dragover"])
  $("dropzone").addEventListener(type, (e) => {
    e.preventDefault();
    $("dropzone").classList.add("dragging");
  });
for (const type of ["dragleave", "drop"])
  $("dropzone").addEventListener(type, (e) => {
    e.preventDefault();
    $("dropzone").classList.remove("dragging");
  });
$("dropzone").addEventListener("drop", (e) => {
  const files = (e as DragEvent).dataTransfer?.files;
  if (files?.length) chooseFile(files[0]);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
$("pdf-url").addEventListener("input", updateButton);
$("pdf-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$<HTMLButtonElement>("convert-button").disabled)
    void run();
});

function getSettings(): Settings {
  const top = Number($<HTMLInputElement>("trim-top").value),
    bottom = Number($<HTMLInputElement>("trim-bottom").value);
  if (![top, bottom].every((n) => Number.isFinite(n) && n >= 0 && n <= 100))
    throw new Error("Margin trimming must be between 0 and 100 PDF points.");
  return {
    top,
    bottom,
    bodySize: Number($<HTMLSelectElement>("body-size").value),
    preserveVisuals: $<HTMLInputElement>("preserve-visuals").checked,
  };
}
function progress(percent: number, label: string) {
  $<HTMLProgressElement>("progress-bar").value = percent;
  $("progress-percent").textContent = `${Math.round(percent)}%`;
  $("progress-label").textContent = label;
}
async function destroyPreviews(keepSource = false) {
  for (const state of Object.values(previews)) {
    state.version++;
    state.task?.cancel();
    state.task = undefined;
    state.page = 1;
  }
  if (outputDoc) {
    await outputDoc.loadingTask.destroy();
    outputDoc = undefined;
  }
  if (!keepSource && sourceDoc) {
    await sourceDoc.loadingTask.destroy();
    sourceDoc = undefined;
  }
}
async function run(edited?: Manuscript, demo = false) {
  if (busy || referenceLoading) return;
  clearError();
  let settings: Settings;
  try {
    settings = getSettings();
  } catch (e) {
    showError((e as Error).message);
    return;
  }
  busy = true;
  updateButton();
  controller = new AbortController();
  const signal = controller.signal;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller?.abort();
  }, 180_000);
  $("workspace").hidden = true;
  $("results").hidden = true;
  $("progress-section").hidden = false;
  $("progress-title").textContent = edited
    ? "Refining your Natural Preprint"
    : "Preparing your paper";
  progress(1, "Opening your PDF");
  $("progress-section").scrollIntoView({ behavior: "smooth", block: "center" });
  try {
    await destroyPreviews(!!edited);
    report = undefined;
    outputBytes = undefined;
    if (!edited) {
      manuscript = undefined;
      let name: string;
      if (demo) {
        const res = await fetch(`${import.meta.env.BASE_URL}sample-paper.pdf`, {
          signal,
        });
        if (!res.ok)
          throw new Error(
            "The sample could not be loaded. Please select a PDF instead.",
          );
        sourceBytes = new Uint8Array(await res.arrayBuffer());
        name = "sample-paper.pdf";
      } else if (inputMode === "link") {
        const result = await fetchPdf(
          $<HTMLInputElement>("pdf-url").value.trim(),
          signal,
          progress,
        );
        sourceBytes = result.bytes;
        name = result.name;
      } else {
        if (!selectedFile) throw new Error("Choose a PDF to get started.");
        sourceBytes = new Uint8Array(await selectedFile.arrayBuffer());
        name = selectedFile.name;
      }
      signal.throwIfAborted();
      sourceDoc = await openPdf(sourceBytes, signal);
      const destroyOnAbort = () => {
        void sourceDoc?.loadingTask.destroy();
      };
      signal.addEventListener("abort", destroyOnAbort, { once: true });
      try {
        manuscript = await extract(
          sourceDoc,
          sourceBytes,
          name,
          settings,
          progress,
          signal,
        );
      } finally {
        signal.removeEventListener("abort", destroyOnAbort);
      }
    } else manuscript = edited;
    if (!sourceDoc || !manuscript)
      throw new Error("Select the original PDF again before rendering.");
    const result = await convert(
      sourceDoc,
      manuscript,
      settings,
      progress,
      signal,
      typographyReference,
    );
    signal.throwIfAborted();
    outputBytes = result.bytes;
    report = result.report;
    outputDoc = await getDocument({
      data: outputBytes.slice(),
      ...pdfOptions(),
    }).promise;
    signal.throwIfAborted();
    await showResults();
    trackUsage(edited ? "edit-completed" : demo ? "sample-completed" : "conversion-completed");
  } catch (e) {
    await destroyPreviews();
    $("workspace").hidden = false;
    if (timedOut)
      showError(
        "This conversion exceeded the three-minute browser limit. Try a smaller paper.",
      );
    else if (signal.aborted) {
      $("file-description").textContent = selectedFile
        ? "Conversion cancelled. You can try again."
        : "Conversion cancelled. Choose a paper to start again.";
    } else
      showError(
        (e as Error).message ||
          "This PDF could not be converted. Try another document.",
      );
    $("workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    clearTimeout(timeout);
    busy = false;
    controller = undefined;
    $("progress-section").hidden = true;
    updateButton();
  }
}
$("convert-button").addEventListener("click", () => {
  void run();
});
$("demo-button").addEventListener("click", () => {
  void run(undefined, true);
});
$("cancel-button").addEventListener("click", () => controller?.abort());

async function renderPreview(which: "original" | "output") {
  const doc = which === "original" ? sourceDoc : outputDoc,
    state = previews[which];
  if (!doc) return;
  state.task?.cancel();
  const version = ++state.version;
  $(which + "-page").textContent = `Page ${state.page} of ${doc.numPages}`;
  $<HTMLButtonElement>(which + "-prev").disabled = state.page === 1;
  $<HTMLButtonElement>(which + "-next").disabled = state.page === doc.numPages;
  try {
    // Wait for the prior canvas render before reusing its canvas.
    await state.task?.promise.catch(() => {});
    if (version !== state.version) return;
    const page = await doc.getPage(state.page);
    if (version !== state.version) return;
    const vp = page.getViewport({ scale: 1 });
    const canvas = $<HTMLCanvasElement>(which + "-canvas");
    const width = Math.min(
      1100,
      Math.max(
        500,
        canvas.parentElement!.clientWidth *
          Math.min(window.devicePixelRatio || 1, 2),
      ),
    );
    const viewport = page.getViewport({ scale: width / vp.width });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    state.task = page.render({ canvas, viewport });
    await state.task.promise;
  } catch (e) {
    if (
      (e as Error).name !== "RenderingCancelledException" &&
      version === state.version
    ) {
      $("preview-error").textContent =
        "This page preview could not be rendered. You can still download the PDF and inspect it in your PDF reader.";
      $("preview-error").hidden = false;
    }
  }
}
for (const which of ["original", "output"] as const)
  for (const [direction, delta] of [
    ["prev", -1],
    ["next", 1],
  ] as const)
    $(which + "-" + direction).addEventListener("click", () => {
      previews[which].page += delta;
      void renderPreview(which);
    });
async function showResults() {
  $("results").hidden = false;
  $("preview-error").hidden = true;
  $("result-summary").textContent =
    `${report!.source_pages} original pages → ${report!.output_pages} reformatted pages · ${report!.visual_regions} visual regions preserved`;
  $("original-count").textContent = `${sourceDoc!.numPages} PAGES`;
  $("warning-count").textContent = `${report!.warnings.length} notes`;
  $("text-check-summary").textContent =
    `${report!.text_check.checked_blocks} text blocks checked against the output. ${report!.text_check.unmatched_blocks.length} need review. This check does not verify that source extraction was complete.`;
  $("warning-list").replaceChildren(
    ...report!.warnings.map((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      return li;
    }),
  );
  $("results-title").focus({ preventScroll: true });
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  await Promise.all([renderPreview("original"), renderPreview("output")]);
}
function download(bytes: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function filename(extension: string) {
  return `${(manuscript?.source_name || "paper")
    .replace(/\.pdf$/i, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .slice(0, 100)}-natural-preprint.${extension}`;
}
$("download-pdf").addEventListener("click", () => {
  if (outputBytes) {
    download(outputBytes.slice().buffer, filename("pdf"), "application/pdf");
    trackUsage("pdf-downloaded");
  }
});
$("download-json").addEventListener("click", () =>
  download(
    JSON.stringify(manuscript, null, 2),
    filename("manuscript.json"),
    "application/json",
  ),
);
$("download-report").addEventListener("click", () =>
  download(
    JSON.stringify(report, null, 2),
    filename("report.json"),
    "application/json",
  ),
);
$("start-over").addEventListener("click", async () => {
  await destroyPreviews();
  sourceBytes = undefined;
  manuscript = undefined;
  report = undefined;
  outputBytes = undefined;
  selectedFile = undefined;
  $<HTMLInputElement>("file-input").value = "";
  $<HTMLInputElement>("pdf-url").value = "";
  $("file-name").textContent = "Drop your paper here";
  $("file-description").innerHTML = "or <u>browse files</u> to get started";
  $("dropzone").classList.remove("has-file");
  $("results").hidden = true;
  $("workspace").hidden = false;
  selectTab("upload");
  updateButton();
  $("workspace").scrollIntoView({ behavior: "smooth" });
  $("dropzone").focus({ preventScroll: true });
});
const dialog = $<HTMLDialogElement>("editor-dialog");
$("edit-manuscript").addEventListener("click", () => {
  $<HTMLTextAreaElement>("manifest-editor").value = JSON.stringify(
    manuscript,
    null,
    2,
  );
  $("editor-error").hidden = true;
  dialog.showModal();
});
$("close-editor").addEventListener("click", () => dialog.close());
$("import-json").addEventListener("click", () =>
  $<HTMLInputElement>("json-input").click(),
);
$("json-input").addEventListener("change", async () => {
  const file = $<HTMLInputElement>("json-input").files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    $("editor-error").textContent =
      "Manuscript JSON must be smaller than 8 MB.";
    $("editor-error").hidden = false;
    return;
  }
  $<HTMLTextAreaElement>("manifest-editor").value = await file.text();
  $<HTMLInputElement>("json-input").value = "";
});
$("render-edits").addEventListener("click", async () => {
  try {
    if (!sourceBytes || !manuscript)
      throw new Error("Choose the original PDF first.");
    const value = $<HTMLTextAreaElement>("manifest-editor").value;
    if (value.length > 8 * 1024 * 1024)
      throw new Error("Manuscript JSON must be smaller than 8 MB.");
    const edited = validateManifest(
      JSON.parse(value),
      await hash(sourceBytes),
      manuscript.extraction.page_sizes,
    );
    dialog.close();
    void run(edited);
  } catch (e) {
    $("editor-error").textContent =
      e instanceof SyntaxError
        ? "This JSON has a syntax error. Check commas, brackets, and quotation marks."
        : (e as Error).message;
    $("editor-error").hidden = false;
  }
});

$("reference-input").addEventListener("change", async () => {
  const file = $<HTMLInputElement>("reference-input").files?.[0];
  if (!file) return;
  clearError();
  referenceLoading = true;
  $<HTMLButtonElement>("demo-button").disabled = true;
  const button = $<HTMLButtonElement>("convert-button");
  button.disabled = true;
  $("reference-status").textContent = "Reading embedded fonts…";
  try {
    if (file.size > MAX_BYTES)
      throw new Error("The reference PDF must be smaller than 100 MB.");
    const { readReference } = await import("./reference");
    typographyReference = await readReference(
      new Uint8Array(await file.arrayBuffer()),
      file.name,
    );
    $("reference-status").textContent =
      `${file.name} · ${typographyReference.fonts.length} embedded fonts · used locally for this session`;
    $("clear-reference").hidden = false;
  } catch (error) {
    typographyReference = undefined;
    $("reference-status").textContent = (error as Error).message;
    $("clear-reference").hidden = true;
  } finally {
    referenceLoading = false;
    $<HTMLButtonElement>("demo-button").disabled = false;
    updateButton();
  }
});
$("clear-reference").addEventListener("click", () => {
  typographyReference = undefined;
  $<HTMLInputElement>("reference-input").value = "";
  $("reference-status").textContent = "Using bundled article fonts.";
  $("clear-reference").hidden = true;
});
