// CarkedIt API — embedded default style JSON.
//
// The admin image-gen page's default style values live here as a TypeScript
// module, not as a separate .json asset, so they survive the `tsc` build
// without needing an asset-copy step. The batch-9 hotfix initially put these
// in `default-style.json` and loaded them via `fs.readFileSync` at runtime,
// but `tsc` does not copy .json files into `dist/` — so on production the
// GET /image-gen/style route fell through to `{ style: {} }` and the admin
// page showed empty fields. Embedding the default as a const solves that
// for good: it's part of the compiled output by definition.
//
// Runtime saves still land at `<api-root>/data/image-gen-style.json` via
// POST /image-gen/style — once the admin clicks Save there, that file
// becomes the source of truth and this default is only used on a fresh
// install.

import type { StyleJson } from "./types.js";

export const DEFAULT_STYLE: StyleJson = {
  renderStyle: "Flat vector illustration style",
  lineWork: "Bold black outlines with consistent medium-heavy stroke weight",
  shading: "Cel-shaded with limited color palette (3-5 colors per illustration)",
  texture: "Halftone dot patterns and cross-hatch textures used for shading and background depth",
  aesthetic: "Retro graphic novel aesthetic",
  composition: "Isolated subject centered on solid or simply-patterned background with subtle radial/circular motif behind subject",
  colorPalette: "Muted pastel + saturated accent color combination (dusty blues, sage greens, warm yellows, coral reds, soft purples)",
  fills: "No gradients — flat fills only with occasional subtle highlight shapes",
  mood: "Slightly vintage/folk art feel",
  editorialStyle: "Clean editorial illustration style",
  brandAesthetic: "Australian indie board game aesthetic",
  // @ts-expect-error — nested object doesn't match the flat StyleJson type,
  // but buildPrompt() extracts `decks` out of the style object before
  // iterating, so the runtime shape is correct. Accepting this type fudge
  // keeps the single-file StyleJson alias unchanged.
  decks: {
    die: {
      prefix: "Died from",
      annotation: "a death-themed playing card illustration",
      splitCompositionA: "Subject positioned in the top-left of the frame",
      splitCompositionB: "Subject positioned in the bottom-right of the frame",
      mysteryPrefix: "texture the ? and background inspired by the following",
    },
    bye: {
      prefix: "",
      annotation: "a death-themed playing card illustration",
    },
    live: {
      prefix: "",
      annotation: "a death-themed playing card illustration",
    },
  },
};
