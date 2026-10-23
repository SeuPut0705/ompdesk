import { describe, expect, it } from "vitest";
import { changedScope } from "./changed-scope";

describe("changedScope", () => {
	it("checks a root configuration change instead of calling it nothing", () => {
		expect(changedScope(["vitest.config.ts"])).toEqual({ files: ["vitest.config.ts"], build: false, allTests: true });
		expect(changedScope(["electron.vite.config.ts"])).toEqual({
			files: ["electron.vite.config.ts"],
			build: true,
			allTests: false,
		});
		expect(changedScope(["package.json"])).toMatchObject({ build: true, allTests: true });
		expect(changedScope(["tsconfig.node.json", "biome.json"])).toMatchObject({ build: true, allTests: false });
		// The shared test setup every test file runs first.
		expect(changedScope(["vitest.setup.ts"])).toEqual({ files: ["vitest.setup.ts"], build: false, allTests: true });
		expect(changedScope(["vitest.renderer-setup.ts"])).toMatchObject({ allTests: true });
	});

	it("keeps source as before and leaves docs and other root files out", () => {
		expect(
			changedScope(["src/main/ipc.ts", "AGENTS.md", "docs/updates.md", "README.ko.md", "src/main/ipc.ts"]),
		).toEqual({
			files: ["src/main/ipc.ts"],
			build: true,
			allTests: false,
		});
		expect(changedScope(["AGENTS.md"]).files).toEqual([]);
	});

	it("builds for app source and resources even when no e2e spec matches, never for a main test or a script alone", () => {
		expect(changedScope(["src/main/sidecar-factory.ts"]).build).toBe(true);
		expect(changedScope(["resources/gui-bridge/modes/plan.ts"]).build).toBe(true);
		// Tailwind scans the renderer's tests for class names.
		expect(changedScope(["src/renderer/hooks/use-tray-sync.test.ts"]).build).toBe(true);
		expect(changedScope(["src/main/sidecar-factory.test.ts", "e2e/smoke.e2e.ts"]).build).toBe(false);
		expect(changedScope(["scripts/changed-scope.ts"]).build).toBe(false);
		expect(changedScope(["scripts/check-main-bundle.ts"]).build).toBe(true);
	});
});
