import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "./proc";

interface DiagnosticOptions {
	outDir: string;
	scratch: string;
	metadir: string;
	javaTmp: string;
	java: string;
	javaSource: string;
	javaMajor: number;
	jars: string[];
	args: string[];
	extraArgs: string[];
}

const MAX_ENTRIES = 2000;
const MAX_TOP = 30;
const MAX_PROGRESS = 100;
const MAX_LINE = 4096;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const hidden = (value: string): object => ({ present: true, sha256: hash(value) });
const JVM_ENV = ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "JAVA_OPTS"];

function safeJvmToken(token: string, options: DiagnosticOptions): boolean {
	return (
		/^-Xm[sx]\d+[kKmMgG]?$/.test(token) ||
		/^-XX:(?:MaxRAMPercentage|InitialRAMPercentage)=\d+(?:\.\d+)?$/.test(token) ||
		token === `-Djava.io.tmpdir=${options.javaTmp}` ||
		token === `-Dtlc2.tool.TLC.metadir=${options.metadir}`
	);
}

function environment(options: DiagnosticOptions): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of JVM_ENV) {
		const value = process.env[key];
		if (value === undefined) continue;
		const tokens = value
			.split(/\s+/)
			.filter(Boolean)
			.map(token => (safeJvmToken(token, options) ? token : hidden(token)));
		result[key] = { ...hidden(value), tokens: tokens.slice(0, 100), truncated: tokens.length > 100 };
	}
	return result;
}

function identity(file: string): object {
	const stat = fs.lstatSync(file);
	return {
		path: file,
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mode: stat.mode,
		symlink: stat.isSymbolicLink(),
	};
}

function resolveJava(command: string): string {
	if (path.isAbsolute(command) || command.includes(path.sep)) return fs.realpathSync(command);
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		try {
			const candidate = path.resolve(dir || ".", command);
			fs.accessSync(candidate, fs.constants.X_OK);
			return fs.realpathSync(candidate);
		} catch {
			/* Try the next PATH entry. */
		}
	}
	throw new Error("Java executable not found on PATH");
}

function walkError(errors: string[], message: string): void {
	if (errors.length < 50) errors.push(message);
	else if (errors.length === 50) errors.push("walk: further errors omitted");
}

function walk(root: string, errors: string[]): object {
	const files: { path: string; bytes: number; allocatedBytes: number; ino: number; dev: number; nlink: number }[] = [];
	const dirs = [root];
	let visited = 0;
	let truncated = false;
	while (dirs.length && !truncated) {
		const dir = dirs.pop()!;
		try {
			const real = fs.realpathSync(dir);
			if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
				errors.push("walk: directory outside scratch skipped");
				continue;
			}
			const handle = fs.opendirSync(dir);
			try {
				for (;;) {
					const entry = handle.readSync();
					if (entry === null) break;
					if (visited >= MAX_ENTRIES) {
						truncated = true;
						break;
					}
					visited++;
					const file = path.join(dir, entry.name);
					try {
						const stat = fs.lstatSync(file);
						if (stat.isSymbolicLink()) continue;
						if (stat.isDirectory()) dirs.push(file);
						else if (stat.isFile()) {
							files.push({
								path: path.relative(root, file).slice(0, 512),
								bytes: stat.size,
								allocatedBytes: stat.blocks * 512,
								ino: stat.ino,
								dev: stat.dev,
								nlink: stat.nlink,
							});
							files.sort((a, b) => b.allocatedBytes - a.allocatedBytes);
							if (files.length > MAX_TOP) files.pop();
						}
					} catch (error) {
						walkError(errors, `walk entry: ${errorCode(error)}`);
					}
				}
			} finally {
				handle.closeSync();
			}
		} catch (error) {
			walkError(errors, `walk directory: ${errorCode(error)}`);
		}
	}
	return { visited, truncated, topFiles: files };
}

function errorCode(error: unknown): string {
	return error && typeof error === "object" && "code" in error ? String(error.code) : "unknown error";
}

export function createTlcDiagnostics(options: DiagnosticOptions): {
	start(): void;
	data(chunk: string): void;
	close(result: RunResult): void;
} {
	let pending = "";
	let firstError = false;
	let progress = 0;
	let progressDropped = 0;
	let excerpt: string[] = [];
	let excerptBytes = 0;
	const extraStart = options.args.length - options.extraArgs.length - 1;
	const safeExtra = new Set<number>();
	for (let i = 0; i < options.extraArgs.length; i++) {
		if (options.extraArgs[i] === "-lncheck" && options.extraArgs[i + 1] === "final") {
			safeExtra.add(extraStart + i);
			safeExtra.add(extraStart + ++i);
		}
	}
	const argv = options.args.map((arg, index) =>
		index >= extraStart && index < extraStart + options.extraArgs.length && !safeExtra.has(index) ? hidden(arg) : arg,
	);
	const privateValues = new Set(options.extraArgs.filter((_, index) => !safeExtra.has(extraStart + index)));
	for (const key of JVM_ENV) {
		for (const token of (process.env[key] ?? "").split(/\s+/)) {
			if (!token || safeJvmToken(token, options)) continue;
			privateValues.add(token);
			const equals = token.indexOf("=");
			if (equals >= 0 && equals < token.length - 1) privateValues.add(token.slice(equals + 1));
		}
	}
	const redact = (text: string): string => {
		for (const value of privateValues) text = text.replaceAll(value, `[sha256:${hash(value)}]`).slice(0, MAX_LINE);
		return text.slice(0, MAX_LINE);
	};
	const emit = (event: string, detail: object = {}): void => {
		try {
			const errors: string[] = [];
			const capture = (name: string, action: () => unknown): unknown => {
				try {
					return action();
				} catch (error) {
					errors.push(`${name}: ${errorCode(error)}`);
					return null;
				}
			};
			const directories = Object.fromEntries(
				Object.entries({ scratch: options.scratch, metadir: options.metadir, jtmp: options.javaTmp }).map(
					([name, dir]) => [name, capture(name, () => identity(dir))],
				),
			);
			const filesystem = capture("statfs", () => fs.statfsSync(options.scratch));
			const df = Object.fromEntries(
				[
					["bytes", "-B1"],
					["inodes", "-i"],
				].map(([name, flag]) => [
					name,
					capture(`df ${flag}`, () => {
						const result = spawnSync("df", [flag, options.scratch], {
							encoding: "utf8",
							maxBuffer: 16384,
							timeout: 1000,
							killSignal: "SIGKILL",
						});
						if (result.error) throw result.error;
						return {
							status: result.status,
							stdout: result.stdout.slice(0, 16384),
							stderr: result.stderr.slice(0, 1024),
						};
					}),
				]),
			);
			const files = capture("walk", () => walk(fs.realpathSync(options.scratch), errors));
			const record = { event, ...detail, directories, filesystem, df, files, errors };
			fs.mkdirSync(options.outDir, { recursive: true });
			fs.appendFileSync(path.join(options.outDir, "tlc-diagnostics.jsonl"), `${JSON.stringify(record)}\n`);
		} catch {
			/* Diagnostics must never change the TLC result or cleanup. */
		}
	};
	const line = (text: string): void => {
		if (
			!firstError &&
			/^\s*(?:Error\b|(?:Exception in thread "[^"]+"\s+)?[\w.$]+(?:Exception|Error)(?::|$)|Caused by:|No space left on device)/i.test(
				text,
			)
		) {
			firstError = true;
			excerpt = [redact(text).slice(0, 1024)];
			excerptBytes = excerpt[0].length;
			emit("first-error", { excerpt });
		} else if (
			firstError &&
			/^\s*(?:at\s+\S+\([^)]*\)|Caused by:|[\w.$]+(?:Exception|Error)(?::|$))/.test(text) &&
			excerptBytes < 4096 &&
			excerpt.length < 20
		) {
			const part = redact(text).slice(0, Math.min(512, 4096 - excerptBytes));
			excerpt.push(part);
			excerptBytes += part.length;
		}
		if (/^(?:Progress\(|Starting checkpoint|Checkpointing\b|Checkpoint\b)/i.test(text)) {
			if (progress++ < MAX_PROGRESS) emit("progress", { line: text.slice(0, MAX_LINE) });
			else progressDropped++;
		}
	};
	return {
		start() {
			try {
				const errors: string[] = [];
				const capture = (name: string, action: () => unknown): unknown => {
					try {
						return action();
					} catch (error) {
						errors.push(`${name}: ${errorCode(error)}`);
						return null;
					}
				};
				const java = capture("java", () => identity(resolveJava(options.java)));
				const jars = [...new Set(options.jars)].map(file => ({
					path: file,
					sha256: capture("jar sha256", () => {
						const stat = fs.statSync(file);
						if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
							throw new Error("jar is not a bounded regular file");
						const digest = createHash("sha256");
						const fd = fs.openSync(file, "r");
						try {
							const buffer = Buffer.allocUnsafe(64 * 1024);
							for (;;) {
								const count = fs.readSync(fd, buffer, 0, buffer.length, null);
								if (count === 0) break;
								digest.update(buffer.subarray(0, count));
							}
						} finally {
							fs.closeSync(fd);
						}
						return digest.digest("hex");
					}),
				}));
				emit("start", {
					argv,
					java,
					javaSource: options.javaSource,
					javaMajor: options.javaMajor,
					jars,
					environment: environment(options),
					identityErrors: errors,
				});
			} catch {
				/* Best effort, including malformed environment or paths. */
			}
		},
		data(chunk) {
			try {
				pending += chunk;
				const lines = pending.split(/\r?\n/);
				pending = (lines.pop() ?? "").slice(0, MAX_LINE);
				for (const text of lines) line(text.slice(0, MAX_LINE));
			} catch {
				/* Never throw from a child stream callback. */
			}
		},
		close(result) {
			try {
				if (pending) line(pending);
				emit("close", {
					code: result.code,
					signal: result.signal,
					timedOut: result.timedOut,
					spawnError: result.spawnError ? errorCode(result.spawnError) : undefined,
					excerpt,
					progressDropped,
				});
			} catch {
				/* The original result and scratch cleanup take precedence. */
			}
		},
	};
}
