/**
 * prCreate (pr.ts, run by the core process: crates/core/src/gh/pr.rs) against its stock counterpart,
 * tools/gh-pr-checkout.ts#executePrCreate: for the same input, both hand a recording `gh` the same flags with the same
 * body text, and read the same PR number from gh's output (stock's follow-up `gh pr view <n>` names it).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { prCreate } from "./pr";
import { initRepo } from "./test-repos";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-coding-agent");
const GH_OUTPUT = "Creating pull request for feat into main in o/r\n\nhttps://github.com/o/r/pull/7\n";

/** `--flag value` pairs and bare flags, order-free; the body file is compared by content. */
function flagSet(args: string[]): string[] {
	const flags: string[] = [];
	for (let index = 2; index < args.length; index++) {
		const flag = args[index] ?? "";
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) flags.push(flag);
		else {
			flags.push(`${flag}=${flag === "--body-file" ? "<file>" : value}`);
			index++;
		}
	}
	return flags.sort();
}

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker. The recording `gh` is a shebang
// script Windows cannot start, so there stock would find the user's real gh and talk to GitHub.
describe.skipIf(!fs.existsSync(stockRoot) || process.platform === "win32")(
	"prCreate against stock executePrCreate",
	() => {
		it("passes stock's gh pr create flags and reads stock's PR number", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-pr-"));
			const savedPath = process.env.PATH;
			try {
				const bin = path.join(dir, "bin");
				fs.mkdirSync(bin);
				fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "junction");
				fs.writeFileSync(
					path.join(bin, "gh"),
					`#!/bin/sh
if [ "$1 $2" = "pr create" ]; then
	: > "${dir}/create.args"
	prev=""
	for arg in "$@"; do
		printf '%s\\n' "$arg" >> "${dir}/create.args"
		if [ "$prev" = "--body-file" ]; then cp "$arg" "${dir}/body.md"; fi
		prev="$arg"
	done
	printf '${GH_OUTPUT.replaceAll("\n", "\\n")}'
	exit 0
fi
if [ "$1 $2" = "repo view" ]; then printf '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}'; exit 0; fi
if [ "$1 $2" = "pr view" ]; then printf '%s\\n' "$3" > "${dir}/view.args"; fi
exit 1
`,
					{ mode: 0o755 },
				);
				const input = {
					title: "Add feature",
					body: "Line one\n\nLine two",
					base: "main",
					head: "feat",
					draft: true,
				};
				fs.writeFileSync(
					path.join(dir, "check.ts"),
					`import { executePrCreate } from "@oh-my-pi/pi-coding-agent/tools/gh-pr-checkout";
await executePrCreate({ cwd: process.argv[2] }, ${JSON.stringify({ repo: "o/r", ...input })}, undefined);
console.log("stock pr create done");
`,
				);
				expect(
					execFileSync("bun", [path.join(dir, "check.ts"), dir], {
						encoding: "utf8",
						env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
						timeout: 30_000,
					}),
				).toContain("stock pr create done");
				const stockArgs = fs.readFileSync(path.join(dir, "create.args"), "utf8").trimEnd().split("\n");
				const stockBody = fs.readFileSync(path.join(dir, "body.md"), "utf8");
				const stockNumber = Number(fs.readFileSync(path.join(dir, "view.args"), "utf8").trim());
				fs.rmSync(path.join(dir, "create.args"));
				fs.rmSync(path.join(dir, "body.md"));

				// The recording gh answers before any gh the machine has: `resolveBin` reads the inherited PATH first.
				process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
				process.env.OMP_GUI_TEST_BREW_DIRS = "";
				const repo = path.join(dir, "repo");
				await initRepo(repo);
				const created = await prCreate(repo, input);
				const ourArgs = fs.readFileSync(path.join(dir, "create.args"), "utf8").trimEnd().split("\n");

				expect(stockArgs.slice(0, 2)).toEqual(["pr", "create"]);
				expect(ourArgs.slice(0, 2)).toEqual(["pr", "create"]);
				expect(flagSet(ourArgs)).toEqual(flagSet(stockArgs));
				expect(stockBody).toBe(input.body);
				expect(fs.readFileSync(path.join(dir, "body.md"), "utf8")).toBe(stockBody);
				expect(created).toEqual({ url: "https://github.com/o/r/pull/7", number: stockNumber });
			} finally {
				process.env.PATH = savedPath;
				delete process.env.OMP_GUI_TEST_BREW_DIRS;
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	},
);
