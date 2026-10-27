/**
 * Install the fake ai-memory binary (`fake-ai-memory.ts`) for one test: the call log and a launcher shaped like a
 * real install (an executable script on POSIX, an `ai-memory.cmd` shim on Windows, in a folder with a space).
 * `env` is what to launch the app with (`OMP_GUI_AI_MEMORY_BIN` lets a non-packaged app wire it).
 *
 *     const memory = await fixtureAiMemory(profile);
 *     const app = await launchApp({ ..., env: { ...memory.env, HOME: home } });
 *     expect(memory.invocations()).toContain("setup --yes --agent omp");
 *
 * The fake's "service" is a pid file under the test's HOME; point the app's `OMP_GUI_AI_MEMORY_UNIT_PIDFILE` at
 * `<HOME>/.fake-ai-memory/server.pid` (the specs do) so turning memory off can stop it the way the OS service would be.
 * The server is detached and outlives the app, so a spec that removes the HOME afterwards calls `stopFakeServer(home)`
 * first: Windows refuses (EBUSY) to remove a directory a running process holds.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export interface FakeRequest {
	path: string;
	authorized: boolean;
	method?: string;
	tool?: string;
	body?: Record<string, unknown>;
}

export interface FixtureAiMemory {
	/** The fake binary (`OMP_GUI_AI_MEMORY_BIN`). */
	bin: string;
	logPath: string;
	/** Environment for `launchApp({ env })`. */
	env: Record<string, string>;
	/** Every call's arguments as one string, in order (`setup --yes --agent omp`). */
	invocations(): Promise<string[]>;
	/** The server's requests in order (a POST also has its `body`, an `/mcp` call its `tool`). */
	requests(): Promise<FakeRequest[]>;
}

async function readLines(file: string): Promise<Record<string, unknown>[]> {
	const text = await readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Stop the detached server a fake `setup` started under `home` and resolve once it is gone (a missing pid file or a
 * gone process is fine): `process.kill` returns before Windows ends the process, and its handles on the HOME go only then.
 */
export async function stopFakeServer(home: string): Promise<void> {
	const pid = Number(await readFile(join(home, ".fake-ai-memory", "server.pid"), "utf8").catch(() => ""));
	if (!pid) return;
	try {
		process.kill(pid);
		// Signal 0 throws once the process is gone.
		for (;;) {
			process.kill(pid, 0);
			await sleep(25);
		}
	} catch {
		// gone
	}
}

export async function fixtureAiMemory(dir: string): Promise<FixtureAiMemory> {
	const root = join(dir, "fake ai-memory");
	await mkdir(root, { recursive: true });
	const logPath = join(root, "calls.jsonl");
	await writeFile(logPath, "");
	await writeFile(`${logPath}.requests`, "");
	const fixture = pathToFileURL(resolve("e2e/fixture/fake-ai-memory.ts")).href;
	const source = [
		`process.env.FAKE_AI_MEMORY_LOG ??= ${JSON.stringify(logPath)};`,
		// The worker installing the fake: its detached server ends once this process is gone (fake-ai-memory.ts).
		`process.env.FAKE_AI_MEMORY_OWNER_PID ??= ${JSON.stringify(String(process.pid))};`,
		`await import(${JSON.stringify(fixture)});`,
		"",
	].join("\n");
	const script = join(root, "ai-memory.ts");
	await writeFile(script, source);
	// The launcher is named like the real binary (`ai-memory`, `ai-memory.cmd`): OMPdesk recognises its MCP entries by
	// that name.
	let bin = join(root, "ai-memory");
	if (process.platform !== "win32") {
		await writeFile(bin, `#!/bin/sh\nexec bun "${script}" "$@"\n`);
		await chmod(bin, 0o755);
	} else {
		bin = join(root, "ai-memory.cmd");
		await writeFile(bin, `@bun "${script}" %*\r\n`);
	}
	return {
		bin,
		logPath,
		env: { OMP_GUI_AI_MEMORY_BIN: bin, FAKE_AI_MEMORY_BIN: bin, FAKE_AI_MEMORY_LOG: logPath },
		invocations: async () => (await readLines(logPath)).map(call => (call.argv as string[]).join(" ")),
		requests: async () => (await readLines(`${logPath}.requests`)) as unknown as FakeRequest[],
	};
}
