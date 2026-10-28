import fs from "node:fs";
import path from "node:path";
import { cacheRoot } from "./cache";
import { type RunResult, run, Unavailable } from "./proc";
import { download, extractInto, fileMatches, forPlatform, loadToolchain, withLock } from "./toolchain";

export interface JavaProbe {
	ok: boolean;
	path: string;
	/** Major version (8 for 1.8.0_x), when it ran. */
	major?: number;
	text: string;
	source?: "system" | "cache";
}

export interface TlaEnv {
	java: string;
	javaSource: "system" | "cache";
	javaMajor: number;
	tla2tools: string;
	community: string;
	/** `-cp` value: tla2tools.jar and the community modules. */
	classpath: string;
	tlaVersion: string;
	communityVersion: string;
}

/** The `-version` banner's major version: `"17.0.19"` is 17, `"1.8.0_402"` is 8. */
export function parseJavaMajor(text: string): number | undefined {
	const match = /version "(\d+)(?:\.(\d+))?/.exec(text);
	if (!match) return undefined;
	const first = Number(match[1]);
	return first === 1 ? Number(match[2]) : first;
}

/** Runs `java -version`. On macOS `/usr/bin/java` can be a stub without a runtime: that is `ok: false`. */
export async function probeJava(javaPath: string): Promise<JavaProbe> {
	const result: RunResult = await run(javaPath, ["-version"], { timeoutMs: 20_000 });
	const text = `${result.stderr}\n${result.stdout}`.trim();
	if (result.spawnError || result.code !== 0) {
		return { ok: false, path: javaPath, text: result.spawnError?.message ?? text };
	}
	const major = parseJavaMajor(text);
	return major === undefined ? { ok: false, path: javaPath, text } : { ok: true, path: javaPath, major, text };
}

const JAVA_BIN = process.platform === "win32" ? "java.exe" : "java";

/** The java inside an unpacked Temurin JRE (`bin/java`, or `Contents/Home/bin/java` on macOS). */
export function javaInside(jreDir: string): string | null {
	for (const rel of [path.join("bin", JAVA_BIN), path.join("Contents", "Home", "bin", JAVA_BIN)]) {
		const candidate = path.join(jreDir, rel);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function systemJavaCandidates(env: NodeJS.ProcessEnv): string[] {
	if (env.OMPDESK_FORMAL_NO_SYSTEM_JAVA === "1") return [];
	const list: string[] = [];
	if (env.OMPDESK_FORMAL_JAVA) list.push(env.OMPDESK_FORMAL_JAVA);
	if (env.JAVA_HOME) list.push(path.join(env.JAVA_HOME, "bin", JAVA_BIN));
	list.push("java");
	return list;
}

export interface TlaPaths {
	dir: string;
	tla2tools: string;
	community: string;
	jreDir: string;
}

export function tlaPaths(env: NodeJS.ProcessEnv = process.env): TlaPaths {
	const tc = loadToolchain(env);
	const jre = tc.tla.jre.platforms[`${process.platform}-${process.arch}`];
	const root = cacheRoot(env);
	const dir = path.join(root, "tla");
	return {
		dir,
		tla2tools: path.join(dir, `tla2tools-${tc.tla.tla2tools.version}`, tc.tla.tla2tools.file),
		community: path.join(dir, `community-${tc.tla.communityModules.version}`, tc.tla.communityModules.file),
		jreDir: path.join(
			root,
			"jre",
			`temurin-${(jre?.version ?? "none").replace(/[^0-9a-z.+-]+/gi, "_")}-${process.platform}-${process.arch}`,
		),
	};
}

async function findJava(env: NodeJS.ProcessEnv, minJava: number, jreDir: string): Promise<JavaProbe | null> {
	for (const candidate of systemJavaCandidates(env)) {
		const probe = await probeJava(candidate);
		if (probe.ok && (probe.major ?? 0) >= minJava) return { ...probe, source: "system" };
	}
	const cached = javaInside(jreDir);
	if (cached) {
		const probe = await probeJava(cached);
		if (probe.ok && (probe.major ?? 0) >= minJava) return { ...probe, source: "cache" };
	}
	return null;
}

export interface TlaStatus {
	ready: boolean;
	missing: string[];
	java?: JavaProbe;
}

/** What is installed, without downloading anything. */
export async function tlaStatus(env: NodeJS.ProcessEnv = process.env): Promise<TlaStatus> {
	const tc = loadToolchain(env);
	const paths = tlaPaths(env);
	const missing: string[] = [];
	if (!(await fileMatches(paths.tla2tools, tc.tla.tla2tools.sha256)))
		missing.push(`tla2tools ${tc.tla.tla2tools.version}`);
	if (!(await fileMatches(paths.community, tc.tla.communityModules.sha256))) {
		missing.push(`CommunityModules ${tc.tla.communityModules.version}`);
	}
	const java = await findJava(env, tc.tla.minJava, paths.jreDir);
	if (!java) missing.push(`Java ${tc.tla.minJava}+`);
	return { ready: missing.length === 0, missing, ...(java ? { java } : {}) };
}

/**
 * Makes TLC runnable: the pinned jars (SHA-256 checked) and a working Java (a system one if it runs, else the
 * pinned portable JRE). Idempotent and lazy: a present, matching file is never fetched again. Throws Unavailable
 * when something is missing and cannot be fetched.
 */
export async function prepareTla(
	options: { env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {},
): Promise<TlaEnv> {
	const env = options.env ?? process.env;
	const tc = loadToolchain(env);
	const root = cacheRoot(env);
	const paths = tlaPaths(env);
	const jars = [
		{ art: tc.tla.tla2tools, dest: paths.tla2tools, label: `tla2tools.jar ${tc.tla.tla2tools.version}` },
		{
			art: tc.tla.communityModules,
			dest: paths.community,
			label: `CommunityModules ${tc.tla.communityModules.version}`,
		},
	];
	for (const jar of jars) {
		if (await fileMatches(jar.dest, jar.art.sha256)) continue;
		await withLock(root, "tla", async () => {
			if (await fileMatches(jar.dest, jar.art.sha256)) return;
			await download(jar.art.url, jar.dest, jar.art.sha256, { label: jar.label, env, log: options.log });
		});
	}
	let java = await findJava(env, tc.tla.minJava, paths.jreDir);
	if (!java) {
		const entry = forPlatform(tc.tla.jre.platforms, "portable Java runtime");
		await withLock(root, "jre", async () => {
			if (javaInside(paths.jreDir)) return;
			const archive = path.join(root, "downloads", path.basename(new URL(entry.url).pathname));
			await download(entry.url, archive, entry.sha256, {
				label: `Temurin JRE ${entry.version}`,
				env,
				log: options.log,
			});
			await extractInto(archive, entry.format, paths.jreDir);
			fs.rmSync(archive, { force: true });
		});
		java = await findJava(env, tc.tla.minJava, paths.jreDir);
		if (!java) {
			throw new Unavailable(
				`the portable JRE in ${paths.jreDir} does not run (java -version failed); delete that folder and retry`,
			);
		}
	}
	return {
		java: java.path,
		javaSource: java.source ?? "system",
		javaMajor: java.major ?? 0,
		tla2tools: paths.tla2tools,
		community: paths.community,
		classpath: [paths.tla2tools, paths.community].join(path.delimiter),
		tlaVersion: tc.tla.tla2tools.version,
		communityVersion: tc.tla.communityModules.version,
	};
}
