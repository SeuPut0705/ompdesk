import { describe, expect, it } from "vitest";
import type { ExtensionMethod } from "../../shared/extension-update";
import type { McpBinary, McpOwner } from "./mcp-owner";
import { deferForRunning, runningServer, scansProcesses } from "./running";

describe("deferForRunning", () => {
	const owners: ExtensionMethod[] = ["npm", "bun", "brew", "brew-cask", "pipx", "uv", "pip"];

	it("a script waits for every owner that replaces files in place or whole", () => {
		for (const method of owners) expect(deferForRunning(method, true)).toBe(true);
	});

	it("a native binary keeps its old inode and updates at once, whoever owns it", () => {
		for (const method of owners) expect(deferForRunning(method, false)).toBe(false);
	});

	it("nothing else waits", () => {
		expect(deferForRunning("winget", true)).toBe(false);
		expect(deferForRunning(null, true)).toBe(false);
		expect(deferForRunning("registry", true)).toBe(false);
	});

	it("only macOS scans processes", () => {
		expect(scansProcesses("darwin")).toBe(true);
		expect(scansProcesses("win32")).toBe(false);
	});
});

function binary(owner: McpOwner | null, over: Partial<McpBinary> = {}): McpBinary {
	return {
		command: "thing",
		path: "/usr/local/bin/thing",
		real: "/usr/local/lib/node_modules/thing/bin/cli.js",
		owner,
		skip: null,
		installed: "1.0.0",
		script: true,
		...over,
	};
}

describe("runningServer", () => {
	const npm: McpOwner = {
		method: "npm",
		name: "thing",
		prefix: "/usr/local",
		root: "/usr/local/lib/node_modules/thing",
	};

	it("finds the executable, the package dir and the command name", () => {
		const ps = ["/sbin/launchd", "/usr/bin/vim notes.md"].join("\n");
		expect(runningServer(ps, { command: "thing" }, binary(npm))).toBe(false);
		expect(
			runningServer(
				`${ps}\nnode /usr/local/lib/node_modules/thing/bin/cli.js --stdio`,
				{ command: "thing" },
				binary(npm),
			),
		).toBe(true);
		expect(runningServer(`${ps}\nnode /usr/local/bin/thing --stdio`, { command: "thing" }, binary(npm))).toBe(true);
		expect(runningServer(`${ps}\n/Users/u/bin/thing --stdio`, { command: "thing" }, binary(npm))).toBe(true);
		expect(
			runningServer(
				`${ps}\nnode /usr/local/lib/node_modules/thing/node_modules/dep/x.js`,
				{ command: "thing" },
				binary(npm),
			),
		).toBe(true);
	});

	it("a neighbour with a longer name is not the server", () => {
		const ps = "node /usr/local/lib/node_modules/thing-other/bin/cli.js\n/usr/local/bin/thing-two --x";
		expect(runningServer(ps, { command: "thing" }, binary(npm))).toBe(false);
	});

	it("a Homebrew keg, a pipx venv and a uv tool dir count as the server's files", () => {
		const brew = binary(
			{ method: "brew", name: "thing", brew: "/opt/homebrew/bin/brew" },
			{ real: "/opt/homebrew/Cellar/thing/1.0.0/bin/thing", path: "/opt/homebrew/bin/thing" },
		);
		expect(runningServer("/opt/homebrew/Cellar/thing/1.0.0/libexec/helper --x", { command: "other" }, brew)).toBe(
			true,
		);
		const pipx = binary(
			{ method: "pipx", name: "t", venv: "/h/pipx/venvs/t" },
			{ real: "/h/pipx/venvs/t/bin/t", path: "/h/.local/bin/t" },
		);
		expect(runningServer("/h/pipx/venvs/t/bin/python /h/pipx/venvs/t/bin/t", { command: "t" }, pipx)).toBe(true);
		const uv = binary(
			{ method: "uv", name: "t", dir: "/h/uv/tools/t" },
			{ real: "/h/uv/tools/t/bin/t", path: "/h/.local/bin/t" },
		);
		expect(runningServer("/h/uv/tools/t/bin/python /h/uv/tools/t/bin/t", { command: "other" }, uv)).toBe(true);
		expect(runningServer("/usr/bin/python3 -m http.server", { command: "other" }, uv)).toBe(false);
	});

	it("tolerates empty output", () => {
		expect(runningServer("", { command: "thing" }, binary(npm))).toBe(false);
		expect(runningServer("\n\n", { command: "thing" }, binary(null))).toBe(false);
	});
});
