// Lazy boundary for lib/markdown.tsx: KaTeX's JS and its stylesheet (and the
// fonts it references) load together, on the first content that has math.
import "katex/dist/katex.min.css";
import { copyMathAsTex } from "./math-copy";

// From the first rendered formula on, a copied selection carries TeX for math
// (server rendering and tests may load this without a document).
globalThis.document?.addEventListener("copy", copyMathAsTex);

export { default } from "rehype-katex";
