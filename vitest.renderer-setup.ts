// The renderer tests' DOM is linkedom, which has no `document.compatMode`. KaTeX reads it when it loads and, on a
// document that is not in standards mode, warns about quirks mode (once per test file that renders Markdown) and
// replaces its DOM renderer with one that throws. The app's pages are standards mode (index.html and web.html carry a
// doctype); linkedom's documents read the same here.
import { parseHTML } from "linkedom";

const documentProto = Object.getPrototypeOf(parseHTML("<!doctype html><html></html>").document) as object;
if (!("compatMode" in documentProto)) {
	Object.defineProperty(documentProto, "compatMode", { configurable: true, get: () => "CSS1Compat" });
}
