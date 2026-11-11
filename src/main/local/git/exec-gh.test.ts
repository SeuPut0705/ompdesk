/**
 * gh's two runs for callers that keep their logic in main (`gh` and `ghText`, core methods `gh.run` and `gh.text`),
 * with node standing in for gh so the file runs on every platform; and the promise that a failing gh whose environment
 * carries a token reports nothing of it: not in a message, not in the stderr a text run answers, not in a line the core
 * process writes to its log.
 */
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gh, ghText } from "./exec";

const TOKEN = `ghp_${"Q7w3".repeat(9)}`;
const node = process.execPath;
const cwd = os.tmpdir();
const script = (code: string) => ["-e", code];

afterEach(() => {
	delete process.env.GH_TOKEN;
	vi.restoreAllMocks();
});

describe("gh through the core", () => {
	it("answers stdout, a failure in gh's own words, and every exit code of a text run", async () => {
		expect(await gh(cwd, node, script("process.stdout.write('{\"a\":1}')"))).toBe('{"a":1}');
		await expect(gh(cwd, node, script("process.stderr.write(' HTTP 401 \\n'); process.exit(1)"))).rejects.toThrow(
			/^HTTP 401$/,
		);
		await expect(gh(cwd, node, script("process.exit(5)"))).rejects.toThrow(
			"gh -e process.exit(5) exited with code 5",
		);
		expect(
			await ghText(cwd, node, script("process.stdout.write('o'); process.stderr.write('e'); process.exit(3)")),
		).toEqual({ code: 3, stdout: "o", stderr: "e" });
		const env =
			"const e = process.env; process.stdout.write(JSON.stringify([e.GH_PROMPT_DISABLED, e.GH_NO_UPDATE_NOTIFIER, e.NO_COLOR, e.GH_HOST ?? null]))";
		expect(JSON.parse(await gh(cwd, node, script(env)))).toEqual(["1", "1", "1", null]);
		expect(JSON.parse(await gh(cwd, node, script(env), { env: { GH_HOST: "ghe.example.com" } }))).toEqual([
			"1",
			"1",
			"1",
			"ghe.example.com",
		]);
		const missing = path.join(cwd, "ompdesk-no-such-gh");
		await expect(gh(cwd, missing, ["api"])).rejects.toThrow(`spawn ${missing} ENOENT`);
		await expect(gh(cwd, node, script("setTimeout(() => {}, 20_000)"), { timeoutMs: 300 })).rejects.toThrow(
			"-e timed out after 300ms",
		);
	});

	it("reports nothing of a token in a failing gh's environment", async () => {
		process.env.GH_TOKEN = TOKEN;
		const logged = vi.spyOn(console, "warn");
		const missing = path.join(cwd, "ompdesk-no-such-gh");
		const reports = await Promise.all([
			gh(
				cwd,
				node,
				script("process.stderr.write('bad credentials ' + process.env.GH_TOKEN); process.exit(1)"),
			).catch((error: Error) => error.message),
			gh(cwd, node, script("process.stdout.write('x'.repeat(9 * 1024 * 1024) + process.env.GH_TOKEN)")).catch(
				(error: Error) => error.message,
			),
			gh(cwd, node, script("console.error(process.env.GH_TOKEN); setTimeout(() => {}, 20_000)"), {
				timeoutMs: 300,
			}).catch((error: Error) => error.message),
			gh(cwd, missing, ["api"]).catch((error: Error) => error.message),
			ghText(cwd, node, script("process.stderr.write(process.env.GH_TOKEN); process.exit(2)")).then(
				result => result.stderr,
			),
		]);
		expect(reports[0]).toBe("bad credentials ***");
		expect(reports[4]).toBe("***");
		for (const text of [...reports, ...logged.mock.calls.flat().map(String)]) {
			expect(text).not.toContain(TOKEN);
			expect(text).not.toContain(TOKEN.slice(4, 20));
		}
	});
});
