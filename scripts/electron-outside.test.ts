import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs `code` the way CI runs the setup scripts: plain Bun, no Electron. */
function bun(code: string): { status: number | null; output: string } {
	const result = spawnSync("bun", ["-e", code], { cwd: join(__dirname, ".."), encoding: "utf8" });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("main's setup code in a Bun script", () => {
	it("loads and writes its runtime log under the userData the script names", () => {
		const userData = mkdtempSync(join(tmpdir(), "electron-outside-"));
		dirs.push(userData);
		const run = bun(`
			const { electronOutside } = await import("./scripts/electron-outside.ts");
			electronOutside(${JSON.stringify(userData)}, "9.9.9");
			await import("./src/main/setup/service.ts");
			const { writeRuntimeLog } = await import("./src/main/runtime-log.ts");
			writeRuntimeLog({ source: "app-update", message: "from a script" });
		`);
		expect(run.output).not.toContain("SyntaxError");
		expect(run.status).toBe(0);
		const line = JSON.parse(readFileSync(join(userData, "logs", "gui-runtime.jsonl"), "utf8").trim());
		expect(line).toMatchObject({ source: "app-update", message: "from a script", appVersion: "9.9.9" });
	});
});
