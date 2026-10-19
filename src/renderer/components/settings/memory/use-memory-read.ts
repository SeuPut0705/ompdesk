/**
 * One read of Memory's data through `window.omp.aiMemory`, painted from the last known value at the first frame
 * (`lib/last-read.ts`, the no-loading rule) and read again in place: on mount, when `key` changes, on `refresh()` and
 * whenever a write bumps `useMemoryPageStore.version`. A failed read keeps the data on screen and sets `error`.
 * `key` null reads nothing. Nothing here ever shows a spinner; with no value known `data` is undefined and the
 * caller draws its skeleton or its empty line.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { lastRead, rememberRead } from "../../../lib/last-read";
import { useMemoryPageStore } from "../../../stores/memory-page";

export interface MemoryRead<T> {
	data: T | undefined;
	error: string | null;
	/** Read again now. */
	refresh: () => void;
}

const slot = (key: string) => `memory:${key}`;

export function useMemoryRead<T>(key: string | null, read: () => Promise<T>): MemoryRead<T> {
	const version = useMemoryPageStore(state => state.version);
	const [data, setData] = useState<T | undefined>(() => (key ? lastRead<T>(undefined, slot(key)) : undefined));
	const [error, setError] = useState<string | null>(null);
	const [tick, setTick] = useState(0);
	const latest = useRef(read);
	latest.current = read;
	const shown = useRef(key);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `read` captured; `version` and `tick` re-read.
	useEffect(() => {
		if (key === null) {
			shown.current = null;
			setData(undefined);
			setError(null);
			return;
		}
		if (shown.current !== key) {
			shown.current = key;
			setData(lastRead<T>(undefined, slot(key)));
		}
		let live = true;
		latest.current().then(
			value => {
				if (!live) return;
				rememberRead(undefined, slot(key), value);
				setData(value);
				setError(null);
			},
			cause => {
				if (live) setError(cause instanceof Error ? cause.message : String(cause));
			},
		);
		return () => {
			live = false;
		};
	}, [key, version, tick]);

	const refresh = useCallback(() => setTick(value => value + 1), []);
	return { data, error, refresh };
}

/** `ws\u0000project` key part for a project. */
export function projectKey(project: { workspace: string; project: string }): string {
	return `${project.workspace}/${project.project}`;
}
