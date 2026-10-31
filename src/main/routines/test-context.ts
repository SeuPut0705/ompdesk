/** Fakes for the routine sources' tests: their context, and a file watcher the test drives. */
import type { WatchPath } from "./files";
import type { SourceContext } from "./source";

/** A routine source's context: what it fired and warned, and the routine's own run state set by the test. */
export function fakeContext() {
	const fired: string[] = [];
	const warned: string[] = [];
	const state = { running: false, quiet: false };
	const context: SourceContext = {
		fire: detail => {
			fired.push(detail);
			return true;
		},
		running: () => state.running,
		quiet: () => state.running || state.quiet,
		warn: message => warned.push(message),
	};
	return { context, fired, warned, state };
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
	const control = { missing: false, attempts: 0 };
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
		control,
		watchers,
		live,
		emit: (name: string | null) => live().at(-1)?.onChange(name),
		fail: () => live().at(-1)?.onError(new Error("EPERM")),
	};
}
