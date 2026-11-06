import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAgentDesktop } from "./detect";
import { managedAgentDesktop } from "./paths";

const made: string[] = [];
afterEach(async () => {
	await Promise.all(made.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tools(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-setup-agent-desktop-"));
	made.push(dir);
	return dir;
}

/** A managed agent-desktop that runs `body` (shell). */
async function install(toolsDir: string, body: string): Promise<string> {
	const exe = managedAgentDesktop(toolsDir, "darwin");
	await fs.mkdir(path.dirname(exe), { recursive: true });
	await fs.writeFile(exe, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return exe;
}

describe.skipIf(process.platform === "win32")("machine setup's agent-desktop detection", () => {
	it("counts only the copy in the managed tools dir: one on PATH is the user's", async () => {
		const toolsDir = await tools();
		const elsewhere = await tools();
		await fs.writeFile(path.join(elsewhere, "agent-desktop"), "#!/bin/sh\necho 'agent-desktop 1.2.0'\n", {
			mode: 0o755,
		});
		const env = { ...process.env, PATH: `${elsewhere}:${process.env.PATH}` };
		expect(await detectAgentDesktop("darwin", toolsDir, env)).toEqual({ kind: "missing" });
		expect(await detectAgentDesktop("other", toolsDir, env)).toEqual({ kind: "missing" });
	});

	it("reads the version `--version` prints", async () => {
		const toolsDir = await tools();
		const exe = await install(toolsDir, "echo 'agent-desktop 1.2.3'");
		expect(await detectAgentDesktop("darwin", toolsDir, process.env)).toEqual({
			kind: "present",
			version: "1.2.3",
			path: exe,
		});
	});

	it("calls a copy below 1.2.0 outdated (no `agent-desktop mcp` before it), 1.2.0 itself present", async () => {
		const toolsDir = await tools();
		const exe = await install(toolsDir, "echo 'agent-desktop 1.1.9'");
		expect(await detectAgentDesktop("darwin", toolsDir, process.env)).toEqual({
			kind: "outdated",
			version: "1.1.9",
			minimum: "1.2.0",
			path: exe,
		});
		await install(toolsDir, "echo 'agent-desktop 1.2.0'");
		expect(await detectAgentDesktop("darwin", toolsDir, process.env)).toMatchObject({ kind: "present" });
	});

	it("calls a copy that fails, or prints no version, broken", async () => {
		const toolsDir = await tools();
		await install(toolsDir, "echo 'dyld: Library not loaded' >&2; exit 1");
		expect(await detectAgentDesktop("darwin", toolsDir, process.env)).toMatchObject({
			kind: "broken",
			detail: "dyld: Library not loaded",
		});
		await install(toolsDir, "echo 'hello'");
		expect(await detectAgentDesktop("darwin", toolsDir, process.env)).toMatchObject({
			kind: "broken",
			detail: "agent-desktop printed no version",
		});
	});

	it("counts the app's bundled copy, so a first launch downloads nothing, until an update installs a newer one", async () => {
		const toolsDir = await tools();
		const bundle = path.join(toolsDir, "bundle");
		await fs.mkdir(bundle);
		await fs.writeFile(path.join(bundle, "agent-desktop"), "");
		await fs.writeFile(path.join(bundle, "agent-desktop.build.json"), JSON.stringify({ version: "1.2.0" }));
		const bundled = { kind: "present", version: "1.2.0", path: path.join(bundle, "agent-desktop") };
		expect(await detectAgentDesktop("darwin", toolsDir, process.env, bundle)).toEqual(bundled);
		// A managed copy that is broken or older than the bundle is no reason to download: the bundle runs.
		await install(toolsDir, "exit 1");
		expect(await detectAgentDesktop("darwin", toolsDir, process.env, bundle)).toEqual(bundled);
		await install(toolsDir, "echo 'agent-desktop 1.1.0'");
		expect(await detectAgentDesktop("darwin", toolsDir, process.env, bundle)).toEqual(bundled);
		const exe = await install(toolsDir, "echo 'agent-desktop 1.3.0'");
		expect(await detectAgentDesktop("darwin", toolsDir, process.env, bundle)).toEqual({
			kind: "present",
			version: "1.3.0",
			path: exe,
		});
	});
});
