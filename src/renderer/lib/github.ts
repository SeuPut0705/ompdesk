import { useCallback, useEffect, useRef, useState } from "react";
import type { GithubRequest, GithubResults } from "../../shared/github";
import { useFocusedScope } from "./focused-scope";
import { lastRead, rememberRead } from "./last-read";

/** A failed `github` command: gh's message plus main's code (gh_missing, gh_unauthenticated, github_failed, …). */
export class GithubError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "GithubError";
	}
}

/** Run one Agents › GitHub operation on the focused tab's machine (src/main/local/git/github.ts). */
export async function github<R extends GithubRequest>(request: R): Promise<GithubResults[R["op"]]> {
	const response = await window.omp.rpc.command({ type: "github", request });
	if (!response.success) throw new GithubError(response.error, response.code ?? "github_failed");
	return response.data as GithubResults[R["op"]];
}

export interface GithubLoad<T> {
	data: T | null;
	error: string | null;
	/** Main's code for `error` (gh_missing, gh_unauthenticated, not_a_repo, no_github_remote, github_failed). */
	errorCode: string | null;
	loading: boolean;
	reload: () => void;
}

/**
 * Load `request` whenever `key` changes (and on `reload`); `null` loads nothing. A slower earlier answer never
 * replaces a newer one, and rows from the last success stay while a reload of the same key runs or fails.
 */
export function useGithubLoad<R extends GithubRequest>(
	request: R | null,
	key: string,
): GithubLoad<GithubResults[R["op"]]> {
	type Data = GithubResults[R["op"]];
	const scope = useFocusedScope();
	// What this key showed last time (a run's log is not kept): painted at the first frame, read again in place.
	// The folder is part of it: a repo-less request resolves the checkout repo from the tab's cwd.
	const snapKey = request && request.op !== "run_log" ? `github:${scope.cwd}:${request.op}:${key}` : null;
	const [loaded, setLoaded] = useState<{ key: string; data: Data } | null>(null);
	const [error, setError] = useState<{ message: string; code: string } | null>(null);
	const [loading, setLoading] = useState(false);
	const [round, setRound] = useState(0);
	const latest = useRef(0);
	const current = useRef({ request, snapKey, device: scope.device });
	current.current = { request, snapKey, device: scope.device };
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` names the request; the ref holds its latest value
	useEffect(() => {
		const { request: next, snapKey: remember, device } = current.current;
		const sequence = ++latest.current;
		setError(null);
		if (!next) {
			setLoading(false);
			return;
		}
		setLoading(true);
		github(next).then(
			result => {
				if (sequence !== latest.current) return;
				setLoaded({ key, data: result });
				if (remember) rememberRead(device, remember, result);
				setLoading(false);
			},
			(cause: unknown) => {
				if (sequence !== latest.current) return;
				setError({
					message: cause instanceof Error ? cause.message : String(cause),
					code: cause instanceof GithubError ? cause.code : "github_failed",
				});
				setLoading(false);
			},
		);
	}, [key, round]);
	const reload = useCallback(() => setRound(value => value + 1), []);
	// Rows of this key (live, else its last snapshot), never another key's.
	const data = loaded?.key === key ? loaded.data : snapKey ? (lastRead<Data>(scope.device, snapKey) ?? null) : null;
	return { data, error: error?.message ?? null, errorCode: error?.code ?? null, loading, reload };
}
