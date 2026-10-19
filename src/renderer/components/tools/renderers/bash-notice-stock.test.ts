/**
 * The background-job footer the bash and eval cards strip (BashRenderer.tsx
 * `stripBackgroundNotice`) against stock: every notice stock's own
 * `formatBackgroundNotice` (pi-tui/src/tools/bash.ts) writes comes off exactly
 * as stock's `stripTrailingNotice` (pi-tui/src/tools/output-meta.ts) removes it.
 * Stock's matcher, `isBackgroundNotice`, is not exported, and the renderer
 * cannot import stock: both run in Bun over the same texts.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-tui");
const renderer = path.resolve("src/renderer/components/tools/renderers/BashRenderer.tsx");

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(stockRoot))("background notice against stock", () => {
	it("strips every notice stock writes, exactly as stock strips it", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-bg-notice-"));
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "junction");
			const script = `
import assert from "node:assert/strict";
import { formatBackgroundNotice } from "@oh-my-pi/pi-tui/tools/bash";
import { stripTrailingNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { stripBackgroundNotice } from ${JSON.stringify(renderer)};
const bodies = ["", "server ready", "a\\nb\\n", "started\\n\\n", "  indented"];
for (const id of ["bg_1", "bg-7", "ev_2"]) {
	for (const timeout of [undefined, 1, 30, 300]) {
		const notice = formatBackgroundNotice(id, timeout);
		for (const body of bodies) {
			const text = body ? body + (body.endsWith("\\n") ? "" : "\\n") + notice : notice;
			assert.equal(stripBackgroundNotice(text, id), stripTrailingNotice(text, notice), JSON.stringify(text));
		}
	}
}
// Another job's notice, or a notice that is not the last line, stays as stock leaves it.
for (const text of [
	"x\\n" + formatBackgroundNotice("bg_10", 30),
	formatBackgroundNotice("bg_1", 30) + "\\nmore output",
]) {
	assert.equal(stripBackgroundNotice(text, "bg_1"), text);
}
console.log("stock background notice assertions passed");
`;
			fs.writeFileSync(path.join(dir, "check.ts"), script);
			expect(
				execFileSync("bun", [path.join(dir, "check.ts")], {
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			).toContain("stock background notice assertions passed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
