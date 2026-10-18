/**
 * Install the fake ai-memory binary (`fake-ai-memory.ts`) for one test: the call log and a launcher shaped like a
 * real install (an executable script on POSIX, an `ai-memory.cmd` shim on Windows, in a folder with a space).
 * `env` is what to launch the app with (`OMP_GUI_AI_MEMORY_BIN` lets a non-packaged app wire it).
 *
 *     const memory = await fixtureAiMemory(profile);
 *     const app = await launchApp({ ..., env: { ...memory.env, HOME: home } });
 *     expect(memory.invocations()).toContain("setup --yes --agent omp");
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FixtureAiMemory {
	/** The fake binary (`OMP_GUI_AI_MEMORY_BIN`). */
	bin: string;
	logPath: string;
	/** Environment for `launchApp({ env })`. */
	env: Record<string, string>;
	/** Every call's arguments as one string, in order (`setup --yes --agent omp`). */
	invocations(): Promise<string[]>;
	/** The server's requests (`{path, authorized}`), in order. */
	requests(): Promise<{ path: string; authorized: boolean }[]>;
}

async function readLines(file: string): Promise<Record<string, unknown>[]> {
	const text = await readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
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
		`await import(${JSON.stringify(fixture)});`,
		"",
	].join("\n");
	const script = join(root, "ai-memory.ts");
	let bin = script;
	if (process.platform !== "win32") {
		await writeFile(script, `#!/usr/bin/env bun\n${source}`);
		await chmod(script, 0o755);
	} else {
		await writeFile(script, source);
		bin = join(root, "ai-memory.cmd");
		await writeFile(bin, `@bun "${script}" %*\r\n`);
	}
	return {
		bin,
		logPath,
		env: { OMP_GUI_AI_MEMORY_BIN: bin, FAKE_AI_MEMORY_LOG: logPath },
		invocations: async () => (await readLines(logPath)).map(call => (call.argv as string[]).join(" ")),
		requests: async () => (await readLines(`${logPath}.requests`)) as { path: string; authorized: boolean }[],
	};
}
