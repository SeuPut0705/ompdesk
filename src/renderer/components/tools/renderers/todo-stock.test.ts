/**
 * The todo card's phase numerals (TodoRenderer.tsx) against stock
 * `phaseRomanNumeral` (pi-tui/src/tools/todo.ts), which the renderer cannot
 * import: both run in Bun over the same indexes.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-tui");
const renderer = path.resolve("src/renderer/components/tools/renderers/TodoRenderer.tsx");

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(stockRoot))("todo phase numerals against stock", () => {
	it("numbers phases exactly as stock's todo renderer", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-todo-"));
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "dir");
			const script = `
import assert from "node:assert/strict";
import { phaseRomanNumeral as stock } from "@oh-my-pi/pi-tui/tools/todo";
import { phaseRomanNumeral } from ${JSON.stringify(renderer)};
for (let index = -2; index <= 4000; index++) assert.equal(phaseRomanNumeral(index), stock(index), String(index));
console.log("stock todo assertions passed");
`;
			fs.writeFileSync(path.join(dir, "check.ts"), script);
			expect(
				execFileSync("bun", [path.join(dir, "check.ts")], {
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			).toContain("stock todo assertions passed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
