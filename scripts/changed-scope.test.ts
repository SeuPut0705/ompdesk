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
			build: false,
			allTests: false,
		});
		expect(changedScope(["AGENTS.md"]).files).toEqual([]);
	});
});
