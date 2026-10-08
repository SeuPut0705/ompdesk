/**
 * Ambient declarations for Vite `?raw` and `?url` imports (embed file contents as
 * strings; used by ChangelogDialog for the bundled CHANGELOG.md). Must live
 * in a non-module .d.ts — wildcard module declarations are ignored in module
 * files like global.d.ts.
 */
declare module "*.md?raw" {
	const content: string;
	export default content;
}

/** Vite `?url` imports: the emitted asset's URL (the pdf.js worker). */
declare module "*?url" {
	const url: string;
	export default url;
}
