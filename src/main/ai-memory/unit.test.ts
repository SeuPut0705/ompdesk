import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import { type ExecFile, LAUNCHD_LABEL, launchdControl, logonControl, pidFileControl, runEntryCommand } from "./unit";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ai-memory-unit-"));
});
afterEach(async () => {
	await rm(root, RM_TEMP);
});

function recorder(
	answer: (file: string, args: string[]) => { code: number; stdout: string } = () => ({ code: 0, stdout: "" }),
) {
	const calls: string[] = [];
	const exec: ExecFile = async (file, args) => {
		calls.push([file, ...args].join(" "));
		return answer(file, args);
	};
	return { calls, exec };
}

describe("launchdControl", () => {
	const staged = join("/tools", "ai-memory");
	async function plist(text: string): Promise<string> {
		const dir = join(root, "Library", "LaunchAgents");
		await mkdir(dir, { recursive: true });
		const file = join(dir, `${LAUNCHD_LABEL}.plist`);
		await writeFile(file, text);
		return file;
	}

	it("no plist: not installed", async () => {
		const { exec } = recorder();
		const control = launchdControl({ home: root, owned: () => [staged], uid: 501, exec });
		expect(await control.inspect()).toEqual({ installed: false, ours: false });
	});

	it("a plist that runs a binary under the staged folder is OMPdesk's; one that runs another is not", async () => {
		const { exec } = recorder();
		const control = launchdControl({ home: root, owned: () => [staged], uid: 501, exec });
		await plist(`<string>${join(staged, "3.1.1", "ai-memory")}</string>`);
		expect(await control.inspect()).toEqual({ installed: true, ours: true });
		await plist("<string>/opt/homebrew/bin/ai-memory</string>");
		expect(await control.inspect()).toEqual({ installed: true, ours: false });
	});

	it("the binary in use counts as owned too", async () => {
		const { exec } = recorder();
		const control = launchdControl({ home: root, owned: () => [staged, "/dev/build/ai-memory"], uid: 501, exec });
		await plist("<string>/dev/build/ai-memory</string>");
		expect(await control.inspect()).toEqual({ installed: true, ours: true });
	});

	it("remove boots the label out of the user's domain and deletes the plist", async () => {
		const { calls, exec } = recorder();
		const control = launchdControl({ home: root, owned: () => [staged], uid: 501, exec });
		const file = await plist("x");
		await control.remove();
		expect(calls).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
		expect(existsSync(file)).toBe(false);
	});
});

describe("logonControl", () => {
	const staged = String.raw`C:\Users\me\AppData\Local\ompdesk\tools\ai-memory`;
	const query = (command: string) =>
		`\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    ai-memory    REG_SZ    ${command}\r\n\r\n`;

	it("reads the entry's command from `reg query`", () => {
		expect(runEntryCommand(query('"C:\\x\\ai-memory.exe" service-host --data-dir "D"'))).toBe(
			'"C:\\x\\ai-memory.exe" service-host --data-dir "D"',
		);
		expect(runEntryCommand("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
	});

	it("absent: not installed; a command in the staged folder (any case or slash) is OMPdesk's; another is not", async () => {
		const answers: { code: number; stdout: string }[] = [
			{ code: 1, stdout: "" },
			{ code: 0, stdout: query(`"${staged}\\3.1.1\\ai-memory.exe" service-host`) },
			{ code: 0, stdout: query(`"${staged.toUpperCase().replaceAll("\\", "/")}/3.1.1/ai-memory.exe" service-host`) },
			{ code: 0, stdout: query('"C:\\Users\\me\\.local\\bin\\ai-memory.exe" service-host') },
		];
		const { calls, exec } = recorder(() => answers.shift() ?? { code: 1, stdout: "" });
		const control = logonControl({ owned: () => [staged], dataDir: () => null, exec });
		expect(await control.inspect()).toEqual({ installed: false, ours: false });
		expect(await control.inspect()).toEqual({ installed: true, ours: true });
		expect(await control.inspect()).toEqual({ installed: true, ours: true });
		expect(await control.inspect()).toEqual({ installed: true, ours: false });
		expect(calls[0]).toBe("reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v ai-memory");
	});

	it("remove deletes the Run value, then ends the supervisor and the server it recorded, never by image name", async () => {
		const { calls, exec } = recorder();
		await writeFile(join(root, "service-host.json"), JSON.stringify({ supervisor_pid: 4001, server_pid: 4002 }));
		const control = logonControl({ owned: () => [staged], dataDir: () => root, exec });
		await control.remove();
		expect(calls).toEqual([
			"reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v ai-memory /f",
			"taskkill /PID 4001 /T /F",
			"taskkill /PID 4002 /T /F",
		]);
	});

	it("without a readable service-host.json only the entry goes", async () => {
		const { calls, exec } = recorder();
		const control = logonControl({ owned: () => [staged], dataDir: () => join(root, "none"), exec });
		await control.remove();
		expect(calls).toHaveLength(1);
		await writeFile(join(root, "service-host.json"), "{broken");
		await logonControl({ owned: () => [staged], dataDir: () => root, exec }).remove();
		expect(calls.filter(call => call.startsWith("taskkill"))).toEqual([]);
	});
});

describe("pidFileControl", () => {
	it("a pid file is the unit; remove kills that process and deletes the file", async () => {
		const file = join(root, "server.pid");
		const control = pidFileControl(file);
		expect(await control.inspect()).toEqual({ installed: false, ours: false });
		await writeFile(file, "999999999\n");
		expect(await control.inspect()).toEqual({ installed: true, ours: true });
		await control.remove();
		expect(existsSync(file)).toBe(false);
	});
});
