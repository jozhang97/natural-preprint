# Natural Preprint

A static website that turns single-column preprint PDFs into two-column reading copies. Conversion runs on the user's device. Host it entirely on GitHub Pages: no API server, database, accounts, or document storage.

## Run locally

Requires Node.js 22.12+ (Node 22 recommended).

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. Select a PDF, paste a public HTTPS PDF link, or choose **Try a sample**. The bundled sample contains original fictional research text, not scientific findings.

```sh
npm run build       # Type check and build into dist/
npm run preview     # Serve the production build locally
```

## Publish on GitHub Pages

1. Push this project to a GitHub repository with a `main` branch.
2. Open **Settings → Pages** and select **GitHub Actions** as the build and deployment source.
3. Push to `main`, or run **Build and deploy Natural Preprint** from the Actions tab.

The included `.github/workflows/pages.yml` builds the app, runs Chromium browser tests, and deploys `dist/`. Change the workflow branch if your default branch is not `main`. Relative asset URLs support both repository paths and custom domains. No secrets or API keys are required. Serve the app over HTTPS (or localhost), not from an HTML file on disk.

This local directory was not initialized as a Git repository when the website was built. Adding the workflow does not publish the site or configure a GitHub repository automatically.

## Usage analytics

The GitHub Pages workflow is configured for the [jozhang97 GoatCounter dashboard](https://jozhang97.goatcounter.com). Tracking starts once these changes are deployed. The public site code, `jozhang97`, is set as `VITE_GOATCOUNTER_CODE` in `.github/workflows/pages.yml`; no API key or repository secret is needed. For another site, replace that value with its GoatCounter site code.

Open `https://jozhang97.goatcounter.com` to view visits over time and usage events:

- `conversion-completed`: a user's paper successfully converted.
- `sample-completed`: the bundled sample successfully converted.
- `edit-completed`: an edited manuscript successfully rendered.
- `pdf-downloaded`: a generated PDF download was requested (including samples).

Visits use a fixed `/natural-preprint/` path and title, keeping them separate from homepage visits recorded as `/` in the same dashboard. Events contain only the fixed labels above; no document metadata, source links, query strings, or referrers are sent in analytics payloads. The analytics provider receives normal network connection information. GoatCounter's [JavaScript API](https://www.goatcounter.com/help/js) handles counting; analytics failures do not block the app. Blocked scripts and Do Not Track visitors are not counted, so counts are approximate.

Tracking runs only in production builds served over HTTPS, excluding localhost and visitors with Do Not Track enabled. Local development and browser tests do not send analytics. For a manual check, visit the deployed site, convert the sample, download it, and check the dashboard. Set `VITE_GOATCOUNTER_CODE` to an empty string in the workflow and redeploy to disable tracking. For a separate hosting setup, copy `.env.example` to `.env.local`, set the code, and rebuild.

Run `npm run test:analytics` to check configuration gating, event payloads, and failure handling without contacting GoatCounter.

## Features

- Local PDFs and direct HTTPS PDF links that permit cross-origin requests.
- Positioned-text extraction with PDF.js; inferred paragraphs, headings, captions, and basic styles. Labeled front matter (including `Title:`, `Authors:`, `Abstract:`, and `SUMMARY`) is recognized. NIH author manuscripts omit cover banners and repeated manuscript furniture, retain summaries across page breaks, and keep first-page correspondence and contribution notes separate.
- Compact journal-style pages (595.276 × 790.866 points by default), justified 8.25-point body text, and narrow two-column gutters.
- A structured first page: title, DOI/date sidebar, authors, abstract, and affiliation footnotes.
- Figures and tables embed cropped source PDF content directly, retaining vector paths, text, and original image resolution without rasterizing or downsampling.
- Full-width figure plates with balanced two-column captions, scheduled using their first citations. Standalone labeled plates retain their panels and annotations together and match separately collected legends, including supplementary figures and tables. Captions continuing onto another source page stay with their figure. Tables are cropped separately, including their borders and notes.
- Local typography-reference PDFs for embedded Harding/Graphik fonts and page dimensions; bundled Noto fonts remain the fallback.
- Source-page visual appendices for uncertain artwork and pages with little selectable text.
- Original/result previews, processing stages, cancellation, extraction notes, and text checks.
- Downloads for the PDF, editable manuscript JSON, and verification report.
- A JSON editor with import and re-rendering against the same source PDF.

Selected documents and outputs remain in memory. Reloading or **Start another paper** clears the source and result. An optional typography reference remains available until cleared or the page is reloaded. Optional GoatCounter analytics count visits and fixed usage events; no document contents, filenames, pasted PDF links, or error messages are included. No remote font services, AI, or conversion servers are used. Pasting a link makes a request directly to that source website; local files are never uploaded. The site serves its own fonts and PDF.js support assets.

## Match an article's typography

Open **Layout preferences** and choose a local PDF under **Typography reference PDF**. Keep **Journal · 8.25 pt** in **Layout preferences**. The downloadable report records whether a reference or bundled fonts were used. A reference containing embedded Harding/Graphik TrueType or OpenType fonts supplies those typefaces without uploading or publishing them. PDF subset character codes are mapped back through the reference's ToUnicode tables, so punctuation and Greek letters retain their original Unicode values. Missing characters fall back to bundled fonts.

The reference changes fonts and page size. It does not copy the reference's text, highlights, handwritten annotations, or editorial changes. Raw CFF font subsets are not supported. Other reference font families currently use the bundled article faces. Tables preserve the source PDF artwork rather than being reconstructed as editable journal tables.

## Limits

This is an assisted reading tool, not a lossless PDF parser or journal submission formatter. Always compare the result with the original.

- PDFs above **100 MB** require confirmation before proceeding (local files, PDF links, and typography references). Source PDFs above **200 pages** also require confirmation. Maximum extracted text: **600,000 characters**. Maximum output: 250 pages. Conversion timeout: three minutes. Device memory can impose tighter limits.
- Best input: digital, single-column preprints with selectable text. Scans need OCR elsewhere. Password-protected PDFs must be unlocked first.
- Links: the source must permit browser access through CORS. There is no proxy to bypass CORS, authentication, or paywalls. Article landing pages are unsupported. Download and select the PDF locally if a link fails.
- Text: reading order, paragraph boundaries, and styles are inferred. Multi-column sources, unusual encodings, and mathematical notation need review. Missing font glyphs are flagged and replaced visibly.
- Visuals: figure/table crops are removed from the body stream to avoid duplication. Uncertain artwork is preserved as source-page crops; on those fallback pages, extracted text also remains in the article. Detection is heuristic and does not guarantee complete coverage.
- Fonts: redistributable Noto Serif, Noto symbol, and Noto Sans Math fonts are bundled. Reference fonts are used only in the local session, not copied into the website. Crops are rendered at up to 144 DPI, with a maximum 1,800-pixel longest edge.
- Reports: normalized manuscript text excerpts are compared against output text, ignoring whitespace and hyphens. Page/column breaks can cause false mismatches. This does not prove complete source extraction or correct layout.

Default margin trimming excludes 33 PDF points at the top and 20 at the bottom. Recognized bioRxiv/medRxiv banners are excluded automatically. Adjust **Layout preferences** for larger banners or content near page edges.

## Edit a manuscript

After conversion, choose **Edit manuscript**. Edit JSON directly or import a downloaded Natural Preprint manuscript. Its SHA-256 must match the source PDF; select and convert that PDF first to open the editor.

The browser schema, `paperform-1`, is separate from the Python CLI schema:

- `metadata`: title, authors, abstract, affiliations, DOI, posting date, and optional styled spans for front matter.
- `blocks`: ordered paragraphs, headings, captions, or equations. `text` is authoritative. If styled `spans` do not match edited text, formatting resets to plain text.
- `floats`: visual crops with zero-based `source_page`, top-left PDF-point `bbox: [left, top, right, bottom]`, caption text/spans, and optional body-block `anchor`. Figures and tables are scheduled using a text-only measurement pass and citation order. Unanchored figures follow the text. `source-page` visuals go in the appendix. An `equation` crop replaces its anchored equation block.
- `warnings` and `extraction`: extraction context and page sizes.

Crop boxes can be corrected, added, or removed in the editor. Imported data is validated before rendering. Manuscript text is never executed as HTML.

## Tests

```sh
npx playwright install chromium firefox webkit
npm run build
npm test
```

Tests run against the production build on port 4186. They cover conversion, downloads, local-only network behavior, links, cancellation, bad files, scan rejection, manuscript editing, crop validation, responsive layout, accessibility, and long-word wrapping. Screenshots and traces go in the ignored `test-results/` directory.

An additional local TCR-paper regression test is enabled by `PAPERFORM_TEST_SOURCE` and `PAPERFORM_TEST_REFERENCE` paths. It checks author superscripts, DOI, reference page dimensions/fonts, the 12-page output, and figure/table placement. These user documents and extracted reference fonts are never included in the repository or public build.

Set `PAPERFORM_TEST_CD4` to a local copy of the CD4/MHC-II lung-cancer manuscript to check separate title-page metadata and detached main/extended-data legends. A generated fixture also checks double-spaced paragraph reconstruction.

Set `PAPERFORM_TEST_PLATES` to a local copy of the Liu/Baker immunogenicity preprint to check detached plates, supplementary captions, labeled front matter, complete equation crops, and math glyph coverage. This PDF is not bundled or uploaded. Set `PAPERFORM_TEST_NIH` to the local NIH-format Ruiz Cuevas manuscript to check continued summaries, manuscript furniture removal, figure legends, and resource tables.

Regenerate the original sample with `npm run make:demo`.

## Code map

- `src/main.ts`: input, previews, downloads, editor, and session lifecycle.
- `src/article.ts`: baseline-aware extraction, front matter, captions, tables, and citation anchors.
- `src/pdf.ts`: PDF loading, URL fetching, crops, and manuscript validation.
- `src/reference.ts`: local embedded-font extraction and PDF subset Unicode maps.
- `src/typeset.worker.ts`: fonts, line wrapping, pagination, and PDF generation in a worker.
- `src/convert.ts`: worker orchestration and output text checks.
- `src/style.css`: responsive styles.
- `scripts/`: reproducible demo and local PDF.js asset preparation.
- `.github/workflows/pages.yml`: build, browser tests, and deployment.

## Original Python CLI

The existing Python converter remains available and is not used by the website. The two implementations have different extraction/rendering behavior.

```sh
pip install "pymupdf>=1.24" "reportlab>=4" "fonttools>=4.40" pyphen
python paper_reformat.py convert paper.pdf -o formatted.pdf --reference nature-example.pdf --previews preview
```

## Assets and licenses

Noto fonts use the SIL Open Font License, included in `public/fonts/OFL.txt` and `public/fonts/NotoSansMath-OFL.txt`. Noto Sans Math is sourced from the Google Fonts `ofl/notosansmath` distribution. PDF.js (Apache-2.0), pdf-lib (MIT), and fontkit licenses are included in their npm packages. Decorative paper illustrations are HTML/CSS/SVG. The original sample PDF and its text were created for this project.
