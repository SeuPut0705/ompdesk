/**
 * "Save diagnostic bundle": stock's `/dump all|anon` zip of one open session, every member redacted, plus OMPdesk's
 * own redacted diagnostics text, saved where the person chose. Dependency-free: main, the renderer and a paired web
 * page's shim share these shapes and the default file name.
 */
import type { IpcErrorCode } from "./ipc-error-codes";

/** The member added to stock's archive: the text Settings › Updates & about › Copy diagnostics copies. */
export const DIAGNOSTICS_MEMBER = "ompdesk-diagnostics.txt";

/** Where the finished zip goes: the save dialog (the person), the Downloads folder (an agent), or an exact file. */
export type DiagnosticBundleDestination =
	| { kind: "dialog" }
	| { kind: "downloads" }
	| {
			kind: "path";
			/** Absolute; `.zip` is appended when missing. */
			path: string;
	  };

export interface DiagnosticBundleRequest {
	/** The open tab to dump (this window's); the focused one in Settings. */
	tabId?: string;
	/** Otherwise the tab running this session file (`device` = the paired host it runs on). */
	sessionPath?: string;
	device?: string;
	/** Stock's `/dump anon` (contents redacted, metadata kept) instead of `/dump all`. */
	anonymized: boolean;
	/** The session title, for the default file name. */
	title?: string;
	/** Absent = the save dialog. */
	destination?: DiagnosticBundleDestination;
	/** Set only by the `ompdesk_app` action: a session the person hid from agents is refused. */
	forAgent?: true;
}

export type DiagnosticBundleResult =
	| {
			ok: true;
			path: string;
			/** The archive's members, stock's first, then `DIAGNOSTICS_MEMBER`. */
			files: string[];
			subagentCount: number;
			anonymized: boolean;
			/** Why stock could not collect subagent transcripts; the main transcript is archived regardless. */
			subagentError?: string;
			/** Stock members left out because they are not text (only text can be redacted). */
			dropped?: string[];
	  }
	| { ok: false; cancelled: true }
	| { ok: false; cancelled?: undefined; error: string; code?: IpcErrorCode };

/**
 * What the tab's omp answers to `dump_session_archive`: stock's `SessionDumpArchive` repacked with every text member
 * redacted (`redacted`, so a client never takes an older host's raw archive) and non-text members `dropped`.
 */
export interface SessionArchive {
	path: string;
	files: string[];
	subagentCount: number;
	anonymized: boolean;
	redacted: true;
	dropped?: string[];
	subagentError?: string;
}

/** `discard_session_archive` answer: whether the host still had the archive it produced. */
export interface SessionArchiveDiscard {
	removed: boolean;
}

/** The longest session-title part of a default file name. */
const TITLE_CHARS = 40;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** `omp-dump-<session title>-<YYYY-MM-DD>.zip`; the anonymized variant ends `-anon.zip` like stock's own file. */
export function bundleFileName(title: string | undefined, date: Date, anonymized: boolean): string {
	const slug = (title ?? "")
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}._]+/gu, "-")
		.replace(/^[-._]+|[-._]+$/g, "")
		.slice(0, TITLE_CHARS)
		.replace(/[-._]+$/g, "");
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return ["omp-dump", slug, day, anonymized ? "anon" : ""].filter(Boolean).join("-").concat(".zip");
}
