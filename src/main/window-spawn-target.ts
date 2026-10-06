import type { SessionKind } from "../shared/ipc-types";

export interface WindowSpawnTarget {
	cwd: string;
	kind: SessionKind;
	fresh: boolean;
	placeholder: boolean;
}

/**
 * Resolve the sidecar target for a newly created window.
 *
 * A window created without an explicit workspace/session starts a full agent
 * in the GUI-owned Work workspace. It does not inherit the last Code project,
 * and `fresh` prevents CLI auto-resume from attaching an unrelated transcript.
 */
export function resolveWindowSpawnTarget(
	cwd: string | undefined,
	pendingSessionPath: string | undefined,
	kind: SessionKind | undefined,
	fallbackCwd: string,
	defaultWorkspaceCwd: string,
): WindowSpawnTarget {
	const idle = cwd === undefined && pendingSessionPath === undefined && kind === undefined;
	if (idle) return { cwd: defaultWorkspaceCwd, kind: "agent", fresh: true, placeholder: true };
	return {
		cwd: cwd && cwd.length > 0 ? cwd : fallbackCwd,
		kind: kind ?? "agent",
		fresh: false,
		placeholder: false,
	};
}
