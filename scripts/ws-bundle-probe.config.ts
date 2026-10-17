/**
 * electron-vite config of the ws probe in scripts/check-main-bundle.ts: the main build of electron.vite.config.ts
 * (its plugins, `define`s, minifier and externals) with scripts/ws-bundle-probe.ts as its only entry. Run as
 * `electron-vite build -c scripts/ws-bundle-probe.config.ts --outDir <dir>`, the way scripts/build-cache.ts runs
 * the real build: under Node, never Bun, whose `builtinModules` lists `ws` and would leave it un-bundled.
 * This file is a `BUILD_SCRIPTS` input of scripts/build-cache.ts.
 */
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";
import config from "../electron.vite.config";

const main = config.main as UserConfig;

export default {
	main: {
		...main,
		build: {
			...main.build,
			rollupOptions: {
				...main.build?.rollupOptions,
				input: { "ws-probe": fileURLToPath(new URL("./ws-bundle-probe.ts", import.meta.url)) },
			},
		},
	},
};
