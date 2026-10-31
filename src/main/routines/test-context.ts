/** Fakes for the routine sources' tests: their context, and a file watcher the test drives. */
import type { FilesListing, ScanPath, WatchPath } from "./files";
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

/** A watcher the test drives: `emit` is a file event, `fail` the watcher's error, `missing` makes the path not exist. */
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
	return {
		watch,
		scan,
		control,
		watchers,
		live,
		emit: (name: string | null) => live().at(-1)?.onChange(name),
		fail: () => live().at(-1)?.onError(new Error("EPERM")),
	};
}
