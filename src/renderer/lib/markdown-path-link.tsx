/**
 * A path mention found in a reply (lib/markdown-paths.ts). It reads as plain
 * text until the tab's machine confirms the path exists, so a mention of a
 * file that is not there never becomes a dead link. Files open in the Files
 * viewer at the mentioned line; folders are revealed in the Files tree.
 */
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";

export type PathKind = "file" | "dir" | "missing";

/** Answers per tab and path; a reply re-rendered or scrolled back never asks twice. */
const settled = new Map<string, PathKind>();
const pending = new Map<string, Promise<PathKind>>();
const SETTLED_LIMIT = 500;

/**
 * What `path` is on the tab's machine. `fs:read` with a one-byte cap is the
 * cheapest existing probe: relative paths resolve inside the tab's folder, a
 * paired host answers for its own tabs, and a folder fails as `not_a_file`.
 */
export function verifyPath(path: string, tabId: string | null): Promise<PathKind> {
	const key = `${tabId ?? ""}\0${path}`;
	const known = settled.get(key);
	if (known) return Promise.resolve(known);
	const inflight = pending.get(key);
	if (inflight) return inflight;
	const task = window.omp.fs
		.read(path, 1, tabId ?? undefined)
		.then((result): PathKind => (result.ok ? "file" : result.code === "not_a_file" ? "dir" : "missing"))
		.catch((): PathKind => "missing")
		.then(kind => {
			pending.delete(key);
			settled.set(key, kind);
			if (settled.size > SETTLED_LIMIT) settled.delete(settled.keys().next().value ?? "");
			return kind;
		});
	pending.set(key, task);
	return task;
}

/** Forget every answer (tests). */
export function clearVerifiedPaths(): void {
	settled.clear();
	pending.clear();
}

/** An explicit link's path and line: `src/a.ts:42`, `src/a.ts:42:7`, `src/a.ts#L42`. */
export function pathLocation(path: string, href: string): { path: string; line?: number } {
	const hash = /#L(\d+)/.exec(href);
	if (hash) return { path, line: Number(hash[1]) };
	const suffix = /^(.+?):(\d+)(?::\d+)?(?:-\d+)?$/.exec(path);
	// `C:` alone is a drive, not a path with a line.
	if (suffix && !/^[A-Za-z]$/.test(suffix[1])) return { path: suffix[1], line: Number(suffix[2]) };
	return { path };
}

/** Open a local path from a reply: a folder is revealed in the Files tree, anything else opens in the viewer. */
export async function openLocalPath(path: string, tabId: string | null, line?: number): Promise<void> {
	const kind = await verifyPath(path, tabId);
	if (kind === "dir") useUiStore.getState().revealInFiles(path);
	else useUiStore.getState().openFilePreview(path, line ? { line } : undefined);
}

export function PathMentionLink({
	path,
	line,
	children,
	className,
}: {
	path: string;
	line?: number;
	children: ReactNode;
	className?: string;
}) {
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const [kind, setKind] = useState<PathKind | undefined>(() => settled.get(`${tabId ?? ""}\0${path}`));
	useEffect(() => {
		let live = true;
		void verifyPath(path, tabId).then(next => {
			if (live) setKind(next);
		});
		return () => {
			live = false;
		};
	}, [path, tabId]);
	if (kind !== "file" && kind !== "dir") return <>{children}</>;
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		if (kind === "dir") useUiStore.getState().revealInFiles(path);
		else useUiStore.getState().openFilePreview(path, line ? { line } : undefined);
	};
	return (
		<a
			className={className}
			data-path-link={kind}
			href={path}
			onClick={onClick}
			title={line ? `${path}:${line}` : path}
		>
			{children}
		</a>
	);
}
