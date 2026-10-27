import { cp, mkdir } from "node:fs/promises";

// Keep PDF.js character maps, standard fonts, and decoders on the same static
// host. No document should trigger a dependency on a third-party asset CDN.
await mkdir("public/pdfjs", { recursive: true });
for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
  await cp(
    `node_modules/pdfjs-dist/${directory}`,
    `public/pdfjs/${directory}`,
    { recursive: true },
  );
}
await cp("node_modules/pdfjs-dist/LICENSE", "public/pdfjs/LICENSE");
