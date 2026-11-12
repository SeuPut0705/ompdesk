import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appDirOfEntry,
	devToolsPort,
	evaluateExpression,
	inspectorUrl,
	stagedShell,
	userDataFromArgs,
} from "./shell-launch";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the shell launcher's pure parts", () => {
	it("stages the shell per platform and arch", () => {
		expect(stagedShell("win32", "x64", "/r")).toBe(
			path.join("/r", "resources", "ompdesk-shell", "win32-x64", "ompdesk-shell.exe"),
		);
		expect(stagedShell("darwin", "arm64", "/r")).toBe(
			path.join("/r", "resources", "ompdesk-shell", "darwin-arm64", "ompdesk-shell"),
		);
	});

	it("finds the user-data dir in both switch spellings", () => {
		expect(userDataFromArgs(["/p", "--user-data-dir=/a b"])).toBe("/a b");
		expect(userDataFromArgs(["--user-data-dir", "/c"])).toBe("/c");
		expect(userDataFromArgs(["/p"])).toBeUndefined();
	});

	it("takes the checkout of a snapshot or of out/", () => {
		expect(appDirOfEntry(path.join("/repo", "out-0123456789ab", "main", "index.js"))).toBe(path.resolve("/repo"));
		expect(appDirOfEntry(path.join("/repo", "out", "main", "index.js"))).toBe(path.resolve("/repo"));
	});

	it("reads Node's inspector url from the shell's stderr", () => {
		const stderr =
			"Debugger listening on ws://127.0.0.1:51234/0a1b-2c\nFor help, see: https://nodejs.org/en/docs/inspector\n";
		expect(inspectorUrl(stderr)).toBe("ws://127.0.0.1:51234/0a1b-2c");
		expect(inspectorUrl("Debugger listening on ws://127.0.0.1:5")).toBe("ws://127.0.0.1:5");
		expect(inspectorUrl("nothing yet")).toBeUndefined();
	});

	it("reads DevToolsActivePort only once it holds a port and its path line", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-devtools-port-"));
		dirs.push(dir);
		const file = path.join(dir, "DevToolsActivePort");
		expect(devToolsPort(file)).toBeUndefined();
		writeFileSync(file, "9333");
		expect(devToolsPort(file)).toBeUndefined();
		writeFileSync(file, "9333\n/devtools/browser/abc");
		expect(devToolsPort(file)).toBe(9333);
		writeFileSync(file, "0\n/x");
		expect(devToolsPort(file)).toBeUndefined();
	});

	it("evaluates fn(electron, arg) with an undefined arg spelled as undefined", async () => {
		const run = (expression: string, electron: unknown) =>
			new Function("globalThis", `return ${expression}`)({ __ompdeskElectron: electron });
		const electron = { app: { name: "x" } };
		expect(
			await run(
				evaluateExpression(({ app }: { app: { name: string } }, n: number) => `${app.name}${n}`, 2),
				electron,
			),
		).toBe("x2");
		expect(
			await run(
				evaluateExpression((_e: unknown, arg: unknown) => arg === undefined, undefined),
				electron,
			),
		).toBe(true);
		await expect(
			run(
				evaluateExpression(() => 1, undefined),
				undefined,
			),
		).rejects.toThrow("__ompdeskElectron");
	});
});
