// Lazy boundary for lib/markdown.tsx: KaTeX's JS and its stylesheet (and the
// fonts it references) load together, on the first content that has math.
import "katex/dist/katex.min.css";

export { default } from "rehype-katex";
