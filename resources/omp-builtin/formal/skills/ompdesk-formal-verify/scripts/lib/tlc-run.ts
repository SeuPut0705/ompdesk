import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { overrideConstants, parseCfg } from "./cfg";
import { type DefinitionTags, indexDefinitions } from "./code-tags";
import { onInterrupt, run } from "./proc";
import { removeTree } from "./scratch";
import type { TlaEnv } from "./tla-env";
import { parseTlcOutput, type TlcResult } from "./tlc-parse";

/**
 * Java options for every java this skill starts: file and stream encodings are UTF-8, so a non-ASCII name in a spec,
 * a string constant or a trace is not turned into `?` under a non-UTF-8 code page (Windows) or a `C` locale.
 */
export const JAVA_ENCODING = [
	"-Dfile.encoding=UTF-8",
	"-Dstdout.encoding=UTF-8",
	"-Dsun.stdout.encoding=UTF-8",
	"-Dsun.stderr.encoding=UTF-8",
];

export interface TlcRunOptions {
	tla: TlaEnv;
	spec: string;
	/** Config file; default `<Spec>.cfg` beside the spec. */
	config?: string;
	/** Replaces these CONSTANT assignments of the config (TLC value syntax). */
	constants?: Record<string, string>;
	/** TLC `-workers`: `1` by default, which keeps a counterexample the shortest and the same on every run; `auto` uses every core. */
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

/**
 * Runs SANY only (parse and level-check): the fast inner loop while writing a spec. `-error-codes` makes SANY exit
 * non-zero on a semantic error (an unresolved `-1` or a missing EXTENDS); without it SANY exits 0 and only prints it.
 */
export async function runSany(
	tla: TlaEnv,
	spec: string,
): Promise<{ code: number | null; text: string; spawnError?: string }> {
	const specPath = path.resolve(spec);
	const result = await run(
		tla.java,
		[...JAVA_ENCODING, "-cp", tla.classpath, "tla2sany.SANY", "-error-codes", path.basename(specPath)],
		{ cwd: path.dirname(specPath), timeoutMs: 120_000 },
	);
	return {
		code: result.code,
		text: `${result.stdout}${result.stderr}`,
		...(result.spawnError ? { spawnError: result.spawnError.message } : {}),
	};
}

/**
 * The property an unnamed `action` or `temporal` verdict is about. TLC names a violated refinement or a conjunction
 * only by the source location of the failing part (`Action property line 45, col 17 to ...`) or not at all
 * (`Temporal properties were violated`). The location is resolved to the definition of the spec that holds that line
 * when that definition is a PROPERTY of the config; else a config with a single PROPERTY leaves no doubt.
 */
function namedProperty(result: TlcResult, config: string, specPath: string): string | undefined {
	let listed: string[];
	try {
		listed = parseCfg(fs.readFileSync(config, "utf8")).properties;
	} catch {
		return undefined;
	}
	const at = result.propertyLocation;
	const module = path.basename(specPath, ".tla");
	if (at && at.module === module) {
		let enclosing: string | undefined;
		for (const def of definitionLoader(specPath)(module)) if (def.line <= at.line) enclosing = def.name;
		if (enclosing && listed.includes(enclosing)) return enclosing;
	}
	return listed.length === 1 ? listed[0] : undefined;
}

export async function runTlc(options: TlcRunOptions): Promise<TlcRun> {
	const started = Date.now();
	const specPath = path.resolve(options.spec);
	const specDir = path.dirname(specPath);
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-tlc-"));
	// TLC's metadir (tens of MB) lives in the scratch folder: a Ctrl-C ends the script without running `finally`.
	const unregister = onInterrupt(() => {
		removeTree(scratch);
	});
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
			...JAVA_ENCODING,
			`-Djava.io.tmpdir=${javaTmp}`,
			"-cp",
			options.tla.classpath,
			"tlc2.TLC",
			"-noTE",
			"-workers",
			options.workers ?? "1",
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
		if ((parsed.outcome === "action" || parsed.outcome === "temporal") && !parsed.property) {
			const named = namedProperty(parsed, configUsed, specPath);
			if (named) parsed.property = named;
		}
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
		unregister();
		const failed = removeTree(scratch);
		if (failed) console.error(`WARN  ${failed}`);
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

/**
 * Actions that never fired, from `-coverage` output. TLC prints `<Name line ...>: distinct:generated` per action; an
 * action that generated 0 states was never enabled. (0 distinct is no sign of it: an action that only leads back to
 * states already seen has no new state but runs.)
 */
export function deadActions(text: string): string[] {
	const dead: string[] = [];
	for (const match of text.matchAll(
		/^<(\w+)(?:\([^)]*\))? line \d+, col \d+ to line \d+, col \d+ of module \w+>: (\d+):(\d+)/gm,
	)) {
		if (Number(match[3]) === 0 && !dead.includes(match[1] as string)) dead.push(match[1] as string);
	}
	return dead;
}
