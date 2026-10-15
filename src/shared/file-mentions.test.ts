/**
 * `extractFileMentions` is a copy of stock's (AGENTS.md: a copy is pinned to
 * stock); on a machine with omp the cases also run through the installed
 * stock function.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { extractFileMentions, removeFileMention } from "./file-mentions";

const stockFile = path.join(
	os.homedir(),
	".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/utils/file-mentions.ts",
);

const CASES: Array<[string, string[]]> = [
	["read @src/a.ts please", ["src/a.ts"]],
	["(see @docs/My.md), then @b.ts.", ["docs/My.md", "b.ts"]],
	['@"/Users/me/My Report.pdf" and @\'it"s.txt\'', ["/Users/me/My Report.pdf", 'it"s.txt']],
	["mail me at a@b.com, ping @x", ["x"]],
	["@a.ts @a.ts `@c.ts`", ["a.ts", "c.ts"]],
	["@ alone, @... and @)", []],
];

describe("file mentions", () => {
	it("extracts what stock's grammar extracts", () => {
		for (const [text, expected] of CASES) expect(extractFileMentions(text)).toEqual(expected);
	});
	it.skipIf(!existsSync(stockFile))("matches the installed stock function", () => {
		// Stock modules need Bun's runtime; vitest runs on Node, so a Bun child evaluates them.
		const script = `import { extractFileMentions } from ${JSON.stringify(stockFile)};\nconsole.log(JSON.stringify(${JSON.stringify(CASES.map(([text]) => text))}.map(extractFileMentions)));`;
		const stock = JSON.parse(execFileSync("bun", ["-e", script], { encoding: "utf8" })) as string[][];
		expect(CASES.map(([text]) => extractFileMentions(text))).toEqual(stock);
	});

	it("removes every mention of one path and the space after it", () => {
		expect(removeFileMention("read @src/a.ts and @b.ts", "src/a.ts")).toBe("read and @b.ts");
		expect(removeFileMention('@"My Report.pdf" now', "My Report.pdf")).toBe("now");
		expect(removeFileMention("(see @a.ts)", "a.ts")).toBe("(see )");
		expect(removeFileMention("@a.ts, @a.ts", "a.ts")).toBe(", ");
		expect(removeFileMention("mail a@b.com", "b.com")).toBe("mail a@b.com");
	});
});
