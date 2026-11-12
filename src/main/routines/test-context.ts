/** Fakes for the routine sources' tests: their context, and a file watcher the test drives. */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedSince, FilesListing, ScanPath, WatchPath } from "./files";
import { filesChanged } from "./ports";
import type { SourceContext } from "./source";

/**
 * A routine source's context: what it fired and warned, the marks it saved (`saved`, newest last; `mark` is what the
 * last launch left, as a relaunch hands it), and the routine's own run state set by the test.
 */
export function fakeContext(mark?: unknown) {
	const fired: string[] = [];
	const warned: string[] = [];
	const saved: unknown[] = [];
	const state = { running: false, quiet: false };
	const context: SourceContext = {
		mark,
		saveMark: value => saved.push(structuredClone(value)),
		fire: detail => {
			fired.push(detail);
			return true;
		},
		running: () => state.running,
		quiet: () => state.running || state.quiet,
		warn: message => warned.push(message),
	};
	return { context, fired, warned, saved, state };
}

interface FakeWatcher {
	path: string;
	closed: boolean;
	onChange: (name: string | null) => void;
	onError: (error: Error) => void;
}

/**
 * A watcher the test drives: `emit` is a file event, `fail` the watcher's error, `missing` makes the path not exist.
 * What changed since a mark is the real core's answer (`changed`); `settle` waits until every one asked has come.
 */
export function fakeWatch() {
	const watchers: FakeWatcher[] = [];
	const control: { missing: boolean; attempts: number; listing: FilesListing | null } = {
		missing: false,
		attempts: 0,
		listing: { entries: {}, complete: true },
	};
	/** What the path holds now, as `control.listing` says. */
	const scan: ScanPath = async () => structuredClone(control.listing);
	const watch: WatchPath = (path, onChange, onError) => {
		control.attempts++;
		if (control.missing) throw new Error(`ENOENT: no such file or directory, watch '${path}'`);
		const watcher: FakeWatcher = { path, closed: false, onChange, onError };
		watchers.push(watcher);
		return {
			close: () => {
				watcher.closed = true;
			},
		};
	};
	const live = () => watchers.filter(item => !item.closed);
	const asked = new Set<Promise<unknown>>();
	const changed: ChangedSince = (mark, listing) => {
		const answer = filesChanged(mark, listing).finally(() => asked.delete(answer));
		asked.add(answer);
		return answer;
	};
	const settle = async () => {
		while (asked.size > 0) await Promise.allSettled([...asked]);
	};
	return {
		watch,
		scan,
		changed,
		settle,
		control,
		watchers,
		live,
		emit: (name: string | null) => live().at(-1)?.onChange(name),
		fail: () => live().at(-1)?.onError(new Error("EPERM")),
	};
}

/** The stand-in gh: `gh api <endpoint>` answers from the answers file and logs each endpoint it was asked. */
const FAKE_GH = `
const fs = require("node:fs");
const [answersFile, callsFile, , endpoint] = process.argv.slice(2);
fs.appendFileSync(callsFile, JSON.stringify(endpoint) + "\\n");
const answers = JSON.parse(fs.readFileSync(answersFile, "utf8"));
const key = Object.keys(answers).find(prefix => endpoint.startsWith(prefix));
if (key === undefined) {
	process.stderr.write("gh: HTTP 404: Not Found (" + endpoint + ")");
	process.exit(1);
}
const answer = answers[key];
if (answer && typeof answer === "object" && "__error" in answer) {
	process.stderr.write(answer.__error);
	process.exit(1);
}
process.stdout.write(JSON.stringify(answer));
`;

const ghFolders: string[] = [];

/**
 * A gh the core runs (node behind a `.cmd` on Windows, a shell script elsewhere) that answers each endpoint from
 * `answers` (the first key the endpoint starts with; an `Error` is gh failing with its message, any other endpoint
 * a 404). Setting a key of `answers` changes what the next run answers; `calls` lists every endpoint asked.
 */
export function fakeGh(initial: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "routine-gh-"));
	ghFolders.push(dir);
	const answersFile = join(dir, "answers.json");
	const callsFile = join(dir, "calls.log");
	const script = join(dir, "gh.cjs");
	writeFileSync(script, FAKE_GH);
	const table: Record<string, unknown> = { ...initial };
	const save = () =>
		writeFileSync(
			answersFile,
			JSON.stringify(table, (_key, value) => (value instanceof Error ? { __error: value.message } : value)),
		);
	save();
	appendFileSync(callsFile, "");
	const node = process.execPath;
	const bin = join(dir, process.platform === "win32" ? "gh.cmd" : "gh");
	if (process.platform === "win32")
		writeFileSync(bin, `@"${node}" "${script}" "${answersFile}" "${callsFile}" %*\r\n`);
	else
		writeFileSync(bin, `#!/bin/sh\nexec "${node}" "${script}" "${answersFile}" "${callsFile}" "$@"\n`, {
			mode: 0o755,
		});
	const answers = new Proxy(table, {
		set(target, key, value) {
			target[key as string] = value;
			save();
			return true;
		},
	});
	return {
		find: async () => bin,
		answers,
		get calls(): string[] {
			return readFileSync(callsFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as string);
		},
	};
}

/** Removes every stand-in gh's folder. */
export function removeFakeGhs(): void {
	for (const dir of ghFolders.splice(0)) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
