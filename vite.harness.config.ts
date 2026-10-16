import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * The renderer alone, in a browser, over a fixture transport (src/renderer/dev-harness): `bun run harness`
 * serves it, and e2e/mobile-shell.e2e.ts drives it in Chromium and WebKit device emulation. Not part of the
 * packaged app; the real web client has its own entry (web.html) and talks to the host.
 */
export default defineConfig({
	root: resolve(__dirname, "src/renderer"),
	plugins: [tailwindcss()],
	resolve: {
		alias: {
			"@renderer": resolve(__dirname, "src/renderer"),
			"@shared": resolve(__dirname, "src/shared"),
		},
	},
	server: { host: "127.0.0.1", port: 5199, strictPort: true },
	esbuild: { target: "es2022" },
	build: { target: "es2022" },
});
