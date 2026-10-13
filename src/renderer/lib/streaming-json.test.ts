import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseStreamingArgs, streamingParseStep } from "./streaming-json";

const stockPath = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-utils/src/json-parse.ts");

// Argument objects as providers stream them: every prefix of their strict JSON.
const SAMPLES: readonly Record<string, unknown>[] = [
	{ i: "Running requested sleep command", command: "sleep 60", timeout: 70, cwd: null, pty: false, async: false },
	{ path: "src/a.ts", content: 'line "one"\n\\tab\u00e9 \\u0041 end\r\n\ttwo', overwrite: true },
	{
		edits: [
			{ path: "x.ts", old_text: "a", new_text: "b" },
			{ path: "y.ts", op: "delete", lines: [1, -2, 3.25] },
		],
		n: -1.5e3,
		big: 6.02e23,
		tiny: 1e-7,
		zero: 0,
		ok: null,
		f: false,
		t: true,
	},
	{ text: "emoji 😀 and 한국어 \u0000 control \u001f", nested: { deep: { deeper: [[], {}, [{ a: [] }]] } } },
	{ script: "#!/bin/sh\nset -e\nfor f in *.ts; do\n  echo \"$f\" | sed 's/\\/x/g'\ndone\n", empty: "", list: [] },
];

describe("parseStreamingArgs", () => {
	it.each([
		["", {}],
		["{", {}],
		['{"comm', {}],
		['{"command"', {}],
		['{"command":', {}],
		['{"command":"sl', { command: "sl" }],
		['{"command":"sleep 60","timeout":7', { command: "sleep 60", timeout: 7 }],
		['{"command":"sleep 60","timeout":-', { command: "sleep 60" }],
		['{"command":"sleep 60","pty":fal', { command: "sleep 60" }],
		['{"command":"sleep 60","pty":false', { command: "sleep 60", pty: false }],
		['{"command":"a\\', { command: "a\\" }],
		['{"command":"a\\u00', { command: "a\\u00" }],
		['{"command":"a\\"b\\u00e9', { command: 'a"bé' }],
		['{"env":{"A":"1","B', { env: { A: "1" } }],
		['{"paths":["a","b', { paths: ["a", "b"] }],
		['{"paths":[1,2', { paths: [1, 2] }],
		['{"command":"echo {not json}","cwd":null}', { command: "echo {not json}", cwd: null }],
	])("reads %j", (text, expected) => {
		expect(parseStreamingArgs(text)).toEqual(expected);
	});
});

describe.skipIf(!existsSync(stockPath))("parseStreamingArgs against installed stock parseStreamingJson", () => {
	it("returns what stock returns for every prefix of streamed argument objects", async () => {
		// The installed stock module is located at run time; CI without omp skips this pin.
		const stock: { parseStreamingJson: (json: string) => unknown } = await import(stockPath);
		for (const sample of SAMPLES) {
			const json = JSON.stringify(sample);
			for (let length = 0; length <= json.length; length++) {
				const prefix = json.slice(0, length);
				expect([prefix, parseStreamingArgs(prefix)]).toEqual([prefix, stock.parseStreamingJson(prefix)]);
			}
		}
	});
});

describe("streamingParseStep", () => {
	it("steps every character for short buffers and geometrically for long ones", () => {
		expect(streamingParseStep(10)).not.toBe(streamingParseStep(11));
		expect(streamingParseStep(255)).not.toBe(streamingParseStep(256));
		expect(streamingParseStep(100_000)).toBe(streamingParseStep(100_001));
		expect(streamingParseStep(100_000)).not.toBe(streamingParseStep(104_000));
	});
});
