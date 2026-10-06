/**
 * Ambient declarations for Vite query imports in the main bundle: `?raw` for
 * bundled prompt files, `?inline` for the tray PNGs (base64 data URLs).
 */
declare module "*.md?raw" {
	const content: string;
	export default content;
}
declare module "*.png?inline" {
	const dataUrl: string;
	export default dataUrl;
}
