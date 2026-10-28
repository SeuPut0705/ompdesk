import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { overrideConstants } from "./cfg";
import { type DefinitionTags, indexDefinitions } from "./code-tags";
import { run } from "./proc";
import type { TlaEnv } from "./tla-env";
import { parseTlcOutput, type TlcResult } from "./tlc-parse";

export interface TlcRunOptions {
	tla: TlaEnv;
	spec: string;
	/** Config file; default `<Spec>.cfg` beside the spec. */
	config?: string;
	/** Replaces these CONSTANT assignments of the config (TLC value syntax). */
	constants?: Record<string, string>;
	workers?: string;
	/** `false` adds TLC's `-deadlock` (deadlock checking off). */
	deadlock?: boolean;
	coverage?: boolean;
	extraArgs?: string[];
	timeoutMs?: number;
	/** Keep `tlc.log` here. */
	outDir?: string;
	/** Called with each `Progress(...)` line TLC prints while it runs (about one a minute). */
	onProgress?: (line: string) => void;
}

export interface TlcRun {
	code: number | null;
	result: TlcResult;
	text: string;
	configUsed: string;
	logPath?: string;
	durationMs: number;
	/** Set when java could not be started. */
	spawnError?: string;
}

/** Runs SANY only (parse and level-check): the fast inner loop while writing a spec. */
export async function runSany(tla: TlaEnv, spec: string): Promise<{ code: number | null; text: string }> {
	const specPath = path.resolve(spec);
	const result = await run(tla.java, ["-cp", tla.classpath, "tla2sany.SANY", path.basename(specPath)], {
		cwd: path.dirname(specPath),
		timeoutMs: 120_000,
	});
	return { code: result.code, text: `${result.stdout}${result.stderr}` };
}

export async function runTlc(options: TlcRunOptions): Promise<TlcRun> {
	const started = Date.now();
	const specPath = path.resolve(options.spec);
	const specDir = path.dirname(specPath);
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-tlc-"));
	try {
		const baseConfig = path.resolve(options.config ?? path.join(specDir, `${path.basename(specPath, ".tla")}.cfg`));
		let configUsed = baseConfig;
		if (options.constants && Object.keys(options.constants).length > 0) {
			configUsed = path.join(scratch, "override.cfg");
			fs.writeFileSync(configUsed, overrideConstants(fs.readFileSync(baseConfig, "utf8"), options.constants));
		}
		const javaTmp = path.join(scratch, "jtmp");
		fs.mkdirSync(javaTmp);
		const args = [
			"-XX:+UseParallelGC",
			`-Djava.io.tmpdir=${javaTmp}`,
			"-cp",
			options.tla.classpath,
			"tlc2.TLC",
			"-noTE",
			"-nowarning",
			"-workers",
			options.workers ?? "auto",
			"-metadir",
			path.join(scratch, "states"),
			"-config",
			configUsed,
			...(options.deadlock === false ? ["-deadlock"] : []),
			...(options.coverage ? ["-coverage", "1"] : []),
			...(options.extraArgs ?? []),
			path.basename(specPath),
		];
		let pending = "";
		const onData = options.onProgress
			? (chunk: string): void => {
					pending += chunk;
					const lines = pending.split(/\r?\n/);
					pending = lines.pop() ?? "";
					for (const line of lines) if (/^Progress\(/.test(line)) options.onProgress?.(line);
				}
			: undefined;
		const result = await run(options.tla.java, args, { cwd: specDir, timeoutMs: options.timeoutMs, onData });
		const text = `${result.stdout}${result.stderr}`;
		let logPath: string | undefined;
		if (options.outDir) {
			fs.mkdirSync(options.outDir, { recursive: true });
			logPath = path.join(
				options.outDir,
				`${path.basename(specPath, ".tla")}-${path.basename(baseConfig, ".cfg")}.log`,
			);
			fs.writeFileSync(logPath, text);
		}
		const parsed = parseTlcOutput(text, result.code);
		if (result.timedOut) parsed.outcome = "timeout";
		return {
			code: result.code,
			result: parsed,
			text,
			configUsed: baseConfig,
			...(logPath ? { logPath } : {}),
			durationMs: Date.now() - started,
			...(result.spawnError ? { spawnError: result.spawnError.message } : {}),
		};
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/** `@code` indexes of the spec and of the modules it extends, read lazily from the spec's folder. */
export function definitionLoader(spec: string): (module: string | undefined) => DefinitionTags[] {
	const specPath = path.resolve(spec);
	const dir = path.dirname(specPath);
	const main = path.basename(specPath, ".tla");
	const cache = new Map<string, DefinitionTags[]>();
	return module => {
		const name = module ?? main;
		const cached = cache.get(name);
		if (cached) return cached;
		let defs: DefinitionTags[] = [];
		try {
			defs = indexDefinitions(fs.readFileSync(path.join(dir, `${name}.tla`), "utf8"));
		} catch {
			// a standard module, or the file is gone
		}
		cache.set(name, defs);
		return defs;
	};
}

/** Actions that never fired, from `-coverage` output (`<Name line ...>: generated:distinct`). */
export function deadActions(text: string): string[] {
	const dead: string[] = [];
	for (const match of text.matchAll(
		/^<(\w+)(?:\([^)]*\))? line \d+, col \d+ to line \d+, col \d+ of module \w+>: (\d+):(\d+)/gm,
	)) {
		if (Number(match[3]) === 0 && !dead.includes(match[1] as string)) dead.push(match[1] as string);
	}
	return dead;
}
