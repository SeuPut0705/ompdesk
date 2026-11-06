/**
 * Which agent-desktop a session runs (src/main/agent-desktop.ts): the app's bundled copy, or the managed copy the CLI
 * updater keeps once it is at least as new; nothing only when neither exists.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentDesktopToRun } from "./agent-desktop";
import { managedAgentDesktop } from "./setup/paths";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function world(bundled: string | null) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-desktop-"));
	made.push(root);
	const toolsDir = path.join(root, "tools");
	const bundleDir = path.join(root, "bundle");
	if (bundled) {
		fs.mkdirSync(bundleDir);
		fs.writeFileSync(path.join(bundleDir, "agent-desktop"), "");
		fs.writeFileSync(path.join(bundleDir, "agent-desktop.build.json"), JSON.stringify({ version: bundled }));
	}
	const managed = managedAgentDesktop(toolsDir, "darwin");
	const run = (managedVersion: string | null) =>
		agentDesktopToRun({
			toolsDir,
			bundleDir,
			platform: "darwin",
			version: async exe => (exe === managed ? managedVersion : null),
		});
	return { bundleDir, managed, bundledExe: path.join(bundleDir, "agent-desktop"), run };
}

describe("the agent-desktop a session runs", () => {
	it("is the bundled copy on a first launch, before machine setup or an update installed anything", async () => {
		const w = world("1.2.0");
		expect(await w.run(null)).toEqual({ source: "bundled", path: w.bundledExe, version: "1.2.0" });
	});

	it("is the managed copy once an update made it at least as new as the bundled one", async () => {
		const w = world("1.2.0");
		expect(await w.run("1.3.0")).toEqual({ source: "managed", path: w.managed, version: "1.3.0" });
		expect(await w.run("1.2.0")).toMatchObject({ source: "managed" });
	});

	it("stays the bundled copy over an older managed one, so an app update is never shadowed by a stale download", async () => {
		const w = world("1.3.0");
		expect(await w.run("1.2.0")).toMatchObject({ source: "bundled", version: "1.3.0" });
	});

	it("is the managed copy without a bundle (a dev run), only from the first release with `agent-desktop mcp`", async () => {
		const w = world(null);
		expect(await w.run("1.2.0")).toMatchObject({ source: "managed" });
		expect(await w.run("1.1.9")).toBeNull();
		expect(await w.run(null)).toBeNull();
	});

	it("ignores a bundle whose build record is unreadable or names no version", async () => {
		const w = world("1.2.0");
		fs.writeFileSync(path.join(w.bundleDir, "agent-desktop.build.json"), "{");
		expect(await w.run(null)).toBeNull();
		fs.writeFileSync(path.join(w.bundleDir, "agent-desktop.build.json"), JSON.stringify({ version: "latest" }));
		expect(await w.run(null)).toBeNull();
	});
});
