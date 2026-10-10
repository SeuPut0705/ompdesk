import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage, CopyTarget } from "../../shared/rpc-types";

const stockPath = path.join(
	os.homedir(),
	".bun/install/global/node_modules/@oh-my-pi/pi-tui/src/overlays/copy-targets.ts",
);
const adapterPath = path.resolve("resources/gui-bridge/copy-targets.ts");

function targetsFor(messages: AgentMessage[]): CopyTarget[] {
	// Stock includes Bun-native dependencies; exercise it in Bun rather than replacing its extraction in vitest.
	const result = spawnSync(
		"bun",
		[
			"--eval",
			`
		const stock = await import(${JSON.stringify(stockPath)});
		const { buildCopyTargets } = await import(${JSON.stringify(adapterPath)});
		console.log(JSON.stringify(buildCopyTargets(${JSON.stringify(messages)}, stock)));
	`,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr);
	return JSON.parse(result.stdout) as CopyTarget[];
}

const assistant = (text: string, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []) =>
	({
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCalls.map((call, index) => ({ type: "toolCall" as const, id: `t${index}`, ...call })),
		],
	}) satisfies AgentMessage;

describe.skipIf(!existsSync(stockPath))("copy picker using installed stock extraction", () => {
	it("ranks messages newest first with code children and the commands each turn ran", () => {
		const targets = targetsFor([
			assistant("older answer"),
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "ls -la" } }],
			},
			assistant("```sh\necho 1\n```\n```py\nprint(2)\n```", [
				{ name: "eval", arguments: { cells: [{ code: "1+1", language: "js" }] } },
			]),
		]);
		expect(targets.map(target => target.id)).toEqual(["msg:1", "cmd:1", "msg:2", "cmd:2"]);
		expect(targets[0]?.children?.map(child => child.id)).toEqual(["msg:1:code:0", "msg:1:code:1", "msg:1:all"]);
		expect(targets[0]?.children?.[2]?.content).toBe("echo 1\n\nprint(2)");
		expect(targets[1]).toMatchObject({ content: "1+1", language: "javascript" });
		expect(targets[2]).toMatchObject({ label: "older answer" });
		expect(targets[3]).toMatchObject({ content: "ls -la", language: "bash" });
	});

	it("keeps stock quote extraction and masks quotes inside fences", () => {
		const targets = targetsFor([assistant("> quoted\n>tight\n```ts\n> not a quote\n```\n```js\nunclosed")]);
		expect(targets[0]?.children?.map(child => child.content)).toEqual(["quoted\ntight", "> not a quote"]);
	});

	it("falls back to the displayed handoff when no assistant text exists", () => {
		const targets = targetsFor([
			{ role: "custom", customType: "handoff", display: true, content: [{ type: "text", text: "ctx\nmore" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "pwd" } }] },
		]);
		expect(targets.map(target => target.id)).toEqual(["handoff", "cmd:1"]);
		expect(targets[0]?.content).toBe("ctx\nmore");
	});
});
