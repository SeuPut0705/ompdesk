/**
 * The renderer's freeform edit-input walk (edit-args.ts `editInputSections`) against stock
 * pi-tui `tools/edit.ts` (`getEditInputPaths`, the edit renderer's activity summary), which the
 * renderer cannot import: both run in Bun over the same streamed hashline payloads.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { editArgumentPaths, editInputSections } from "./edit-args";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-tui");
const editArgs = path.resolve("src/renderer/components/tools/edit-args.ts");

const CASES = [
	"[e2e/work-replay.test.ts#F879]\nP|",
	"[src/a.ts#ABCD]\nPUT 1.=1:\n+x\n[src/b.ts#1234]\nREM\n",
	"[src/a.ts#ABCD]\nMV src/c.ts\n",
	"[src/a.ts#ABCD]\nPUT 2.=3:\n+kept\nMV src/moved.ts\n",
	'["spaced name.ts"#ABCD]\nCUT 3\n',
	"[src/partial",
	"\uFEFF[src/bom.ts#0F0F]\r\nPUT >1:\r\n+y\r\n",
	"",
];

describe("edit input sections", () => {
	it("names the streamed file and operation without the DSL", () => {
		expect(editInputSections("[e2e/work-replay.test.ts#F879]\nP|")).toEqual([{ path: "e2e/work-replay.test.ts" }]);
		expect(editInputSections("[src/b.ts#1234]\nREM\n")).toEqual([{ path: "src/b.ts", op: "delete" }]);
		expect(editInputSections("*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n")).toEqual([
			{ path: "a.ts", op: "update", rename: "b.ts" },
		]);
		expect(editArgumentPaths({ input: "[a.ts#A1B2] PUT 1.=1:\n+first\n" })).toEqual(["a.ts"]);
	});
});

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(stockRoot))("edit input sections against stock", () => {
	it("finds the same files and file operations as stock's streaming edit call", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-edit-"));
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "junction");
			const script = `
import assert from "node:assert/strict";
import { editToolRenderer, getEditInputPaths } from "@oh-my-pi/pi-tui/tools/edit";
import { editArgumentPaths, editInputSections } from ${JSON.stringify(editArgs)};
for (const input of ${JSON.stringify(CASES)}) {
	assert.deepEqual(editArgumentPaths({ input }), [...new Set(getEditInputPaths(input, "hashline"))], input);
	const first = editInputSections(input)[0];
	const summary = editToolRenderer.activitySummary({ input }, { isPartial: true, renderContext: { editMode: "hashline" } });
	assert.equal(summary.label, first?.op === "delete" ? "Delete" : "Edit", input);
	if (first?.rename) assert.ok(summary.detail?.includes(first.rename), input);
}
console.log("stock edit input assertions passed");
`;
			fs.writeFileSync(path.join(dir, "check.ts"), script);
			expect(
				execFileSync("bun", [path.join(dir, "check.ts")], {
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			).toContain("stock edit input assertions passed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
