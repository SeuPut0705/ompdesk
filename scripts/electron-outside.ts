/**
 * Main's setup code run by a Bun script, outside Electron (`omp-update-lock-check.ts`, `setup-install-check.ts`).
 * Under Bun the "electron" package is only the binary's path, so `import { app } from "electron"` (runtime-log.ts,
 * which setup's detection and service write to) fails to link and the script never starts. This registers an
 * "electron" whose `app` keeps the runtime log under `userData`. Import main's modules dynamically after calling
 * it: a static import links before any code runs.
 */
import { plugin } from "bun";

export function electronOutside(userData: string, version: string): void {
	plugin({
		name: "electron-outside",
		setup(build) {
			build.module("electron", () => ({
				loader: "object",
				exports: { app: { getPath: () => userData, getVersion: () => version, isPackaged: false } },
			}));
		},
	});
}
