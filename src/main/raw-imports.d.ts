/** Ambient declarations for Vite `?raw` imports in the main bundle (bundled prompt files). */
declare module "*.md?raw" {
	const content: string;
	export default content;
}
