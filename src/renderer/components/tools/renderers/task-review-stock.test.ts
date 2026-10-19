/**
 * The task card's review verdict (task-render-utils.ts) against stock: the
 * renderer cannot load stock modules, so its copies of `assembleYieldResult`
 * (pi-tui/src/tools/task-yield-assembly.ts, called with stock's reviewer
 * section shapes) and `parseFindingDetails` (pi-tui/src/tools/task.ts) are
 * run beside the installed omp's on the same yield sequences.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-tui");
const utils = path.resolve("src/renderer/components/tools/renderers/task-render-utils.ts");

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(stockRoot))("task review assembly against stock", () => {
	it("assembles yields and accepts findings exactly as stock's task renderer", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-review-"));
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "junction");
			const script = `
import assert from "node:assert/strict";
import { assembleYieldResult } from "@oh-my-pi/pi-tui/tools/task-yield-assembly";
import { parseFindingDetails } from "@oh-my-pi/pi-tui/tools/task";
import { assembleReviewYield, parseFinding } from ${JSON.stringify(utils)};

const shapes = new Map([
	["findings", "array"],
	["overall_correctness", "scalar"],
	["explanation", "scalar"],
	["confidence", "scalar"],
]);
const finding = (title, extra = {}) => ({
	title, body: "why", priority: "P1", confidence: 0.8, file_path: "src/a.ts", line_start: 3, line_end: 4, ...extra,
});
const verdict = { overall_correctness: "incorrect", explanation: "broken", confidence: 0.7 };
const sequences = [
	[],
	[{ data: { ...verdict, findings: [finding("t")] } }],
	[{ data: verdict, type: "result" }],
	[{ type: ["findings"], data: finding("a") }, { type: ["findings"], data: finding("b") }, { type: ["overall_correctness"], data: "correct" }, { type: ["explanation"], data: "ok" }, { type: ["confidence"], data: 0.9 }],
	[{ type: ["findings"], data: [finding("a"), finding("b")] }, { type: ["findings"], data: finding("c") }],
	[{ type: ["overall_correctness"], data: "correct" }, { type: ["overall_correctness"], data: "incorrect" }],
	[{ type: ["findings"], data: finding("a"), status: "aborted" }, { type: ["findings"], data: finding("b") }],
	[{ type: ["notes"], data: "x" }, { type: ["notes"], data: "y" }, { type: ["notes"], data: "z" }],
	[{ type: ["notes"], data: ["x"] }, { type: ["notes"], data: "y" }],
	[{ type: ["explanation", "notes"], data: "both" }],
	[{ type: ["findings"], data: finding("a") }, { type: "result" }],
	[{ type: ["findings"], data: finding("a") }, { data: verdict }],
	[{ data: verdict, status: "aborted" }],
	[{ data: verdict }, { type: [] }],
	[{ data: verdict }, { data: { ...verdict, overall_correctness: "correct" } }],
	[{ type: [" findings ", ""], data: finding("trim") }],
	[{ type: "result" }],
];
for (const items of sequences) {
	assert.deepEqual(assembleReviewYield(items), assembleYieldResult(items, undefined, shapes)?.data, JSON.stringify(items));
}

const findings = [
	finding("ok"),
	finding("[P2] prefixed"),
	finding("", {}),
	finding("n", { priority: 0 }),
	finding("n", { priority: "P4" }),
	finding("n", { body: undefined }),
	finding("n", { confidence: 1.5 }),
	finding("n", { confidence: -0.1 }),
	finding("n", { confidence: "0.5" }),
	finding("n", { file_path: "" }),
	finding("n", { line_start: Number.NaN }),
	finding("n", { line_end: undefined }),
	finding("n", { title: 3 }),
	null,
	"text",
	[finding("array")],
];
for (const value of findings) {
	assert.equal(parseFinding(value) !== undefined, parseFindingDetails(value) !== undefined, JSON.stringify(value));
}
console.log("stock review assertions passed");
`;
			fs.writeFileSync(path.join(dir, "check.ts"), script);
			expect(
				execFileSync("bun", [path.join(dir, "check.ts")], {
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			).toContain("stock review assertions passed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
