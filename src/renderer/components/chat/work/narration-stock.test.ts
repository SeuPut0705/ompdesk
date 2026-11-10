/**
 * The transcript's narration rule (work-turn.ts `presentNarrationAsAnswer`) against stock's own (pi-ai
 * utils/narration.ts): stock runs in Bun over messages with and without narration blocks; the renderer copy must
 * turn each into the same content.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { presentNarrationAsAnswer } from "./work-turn";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");

const cases: AgentMessage[] = [
	{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "plain" }] },
	{
		role: "assistant",
		timestamp: 2,
		content: [
			{ type: "thinking", thinking: "reasoning" },
			{ type: "thinking", thinking: "said to the person", narration: true },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
		],
	},
	{
		role: "assistant",
		timestamp: 3,
		content: [
			{ type: "thinking", thinking: "first", narration: true },
			{ type: "text", text: "then text" },
			{ type: "thinking", thinking: "second", narration: false },
		],
	},
];

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(path.join(stockModules, "@oh-my-pi/pi-ai")))("narration against stock", () => {
	it("presents narration as the answer exactly as stock does", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-narration-"));
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "junction");
			fs.writeFileSync(
				path.join(dir, "check.ts"),
				`
import { presentNarrationAsAnswer } from "@oh-my-pi/pi-ai/utils/narration";
const cases = ${JSON.stringify(cases)};
console.log(JSON.stringify(cases.map(message => presentNarrationAsAnswer(message).content)));
`,
			);
			const stock = JSON.parse(
				execFileSync("bun", [path.join(dir, "check.ts")], {
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			) as unknown[];
			expect(cases.map(message => presentNarrationAsAnswer(message).content)).toEqual(stock);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
