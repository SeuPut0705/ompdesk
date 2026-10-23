/**
 * "Save a copy" of a file the transcript names (ipc.ts `FS_SAVE_COPY`): the person picks where it goes, then the bytes
 * land there from the computer the tab runs on. A file on this computer is copied. A file on a paired host streams in
 * parts (`host.fs.readRange`) into a temp file of its own beside it (`<dest>.<random>.ompdesk-download`, created
 * exclusively, so no file already there is touched) and is renamed onto the destination once whole, so a
 * dropped link never leaves half a file under the chosen name. A host from before `host.fs.readRange` still sends a file
 * that fits one `host.fs.readBinary`; a larger one asks for that computer's OMPdesk to be updated.
 * The dialog and the host link are injected; the destination is the person's own folder, so it is written with
 * `original-fs` like other modules that touch user folders.
 */
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { promises as fsp } from "original-fs";
import { codedError, ipcErrorCode } from "../shared/ipc-error-codes";
import {
	HOST_DOWNLOAD_MAX_BYTES,
	HOST_DOWNLOAD_PART_BYTES,
	type IpcFsReadBinaryResult,
	type IpcFsSaveCopyResult,
} from "../shared/ipc-types";

/** What the first read takes before the dialog: enough to learn the file, small enough to answer at once. */
const PROBE_BYTES = 64 * 1024;

/** The in-progress file next to the destination. */
export const SAVE_COPY_TEMP_SUFFIX = ".ompdesk-download";

/** The temp file a download of `dest` writes: beside it (one rename), named so it never collides with a file there. */
function tempFor(dest: string): string {
	return `${dest}.${randomUUID().slice(0, 8)}${SAVE_COPY_TEMP_SUFFIX}`;
}

const UPDATE_HOST_ERROR =
	"That computer's OMPdesk is too old to send a file this large. Update OMPdesk on that computer.";

/** A file on the paired host a tab runs on. Both calls answer `host.fs.*` replies, decoded; a link failure throws. */
export interface SaveCopyRemote {
	/** `host.fs.readRange`: throws `unsupported` on a host that does not serve it. */
	readRange(offset: number, length: number): Promise<IpcFsReadBinaryResult>;
	/** `host.fs.readBinary`: the whole file under the host's one-frame cap. */
	readWhole(): Promise<IpcFsReadBinaryResult>;
}

export type SaveCopySource =
	/** `abs`: a regular file, already resolved and confined by the caller. */
	{ kind: "local"; abs: string } | { kind: "remote"; remote: SaveCopyRemote };

export interface SaveCopyRequest {
	/** The file's name: what the dialog offers. */
	name: string;
	/** The save dialog; null when the person cancelled. */
	pickDestination(defaultName: string): Promise<string | null>;
	source: SaveCopySource;
}

/** The last segment of a path from either kind of computer (a Windows host's paths use backslashes). */
export function fileNameOf(filePath: string): string {
	return (
		filePath
			.split(/[\\/]/)
			.filter(segment => segment.length > 0)
			.pop() ?? ""
	);
}

function failure(error: unknown): IpcFsSaveCopyResult {
	const code = ipcErrorCode(error);
	return { ok: false, error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) };
}

/** A host's in-band refusal (`ok: false`) as the error it carries. */
function refused(result: IpcFsReadBinaryResult): Error {
	const message = result.error ?? "The file could not be read";
	return result.code ? codedError(result.code, message) : new Error(message);
}

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
	let done = 0;
	while (done < data.length) {
		const { bytesWritten } = await handle.write(data, done, data.length - done);
		done += bytesWritten;
	}
}

/** `produce` writes the file's bytes through `write`; they become `dest` only once it returns, and a failure leaves nothing. */
async function writeThroughTemp(
	dest: string,
	produce: (write: (data: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<void> {
	const temp = tempFor(dest);
	let handle: FileHandle | undefined;
	let created = false;
	try {
		// `wx`: created here or not at all, so a file (or a link) already at that name is never truncated or removed.
		const open = await fsp.open(temp, "wx");
		created = true;
		handle = open;
		await produce(data => writeAll(open, data));
		handle = undefined;
		await open.close();
		await fsp.rename(temp, dest);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (created) await fsp.rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function saveLocal(abs: string, request: SaveCopyRequest): Promise<IpcFsSaveCopyResult> {
	const dest = await request.pickDestination(request.name);
	if (dest === null) return { ok: false, cancelled: true };
	try {
		await fsp.copyFile(abs, dest);
	} catch (error) {
		const gone = await fsp.access(abs).then(
			() => false,
			() => true,
		);
		return gone ? { ...failure(error), code: "file_not_found" } : failure(error);
	}
	return { ok: true, savedTo: dest };
}

/** A host with no `host.fs.readRange`: one `host.fs.readBinary`, which fits a link frame or is refused. */
async function saveWhole(remote: SaveCopyRemote, request: SaveCopyRequest): Promise<IpcFsSaveCopyResult> {
	let whole: IpcFsReadBinaryResult;
	try {
		whole = await remote.readWhole();
	} catch (error) {
		return failure(error);
	}
	if (!whole.ok) {
		if (whole.code === "file_too_large") return { ok: false, error: UPDATE_HOST_ERROR, code: "unsupported" };
		return failure(refused(whole));
	}
	const dest = await request.pickDestination(request.name);
	if (dest === null) return { ok: false, cancelled: true };
	try {
		await writeThroughTemp(dest, write => write(whole.data));
	} catch (error) {
		return failure(error);
	}
	return { ok: true, savedTo: dest };
}

async function saveRemote(remote: SaveCopyRemote, request: SaveCopyRequest): Promise<IpcFsSaveCopyResult> {
	// A small first part says whether the file exists, how big it is and whether this host streams, so the dialog shows
	// at once; the rest comes in full parts after the person picked where.
	let first: IpcFsReadBinaryResult;
	try {
		first = await remote.readRange(0, PROBE_BYTES);
	} catch (error) {
		return ipcErrorCode(error) === "unsupported" ? saveWhole(remote, request) : failure(error);
	}
	if (!first.ok) return failure(refused(first));
	const { size } = first;
	if (size > HOST_DOWNLOAD_MAX_BYTES) {
		return {
			ok: false,
			error: `File is ${size} bytes, over the ${HOST_DOWNLOAD_MAX_BYTES}-byte limit for saving from another computer`,
			code: "file_too_large",
		};
	}
	const dest = await request.pickDestination(request.name);
	if (dest === null) return { ok: false, cancelled: true };
	try {
		await writeThroughTemp(dest, async write => {
			let written = 0;
			let part = first;
			for (;;) {
				await write(part.data);
				written += part.data.length;
				if (written >= size) return;
				if (part.data.length === 0) throw new Error("The other computer stopped sending the file early");
				part = await remote.readRange(written, Math.min(HOST_DOWNLOAD_PART_BYTES, size - written));
				if (!part.ok) throw refused(part);
				if (part.size !== size) throw new Error("The file changed on the other computer while it was being saved");
			}
		});
	} catch (error) {
		return failure(error);
	}
	return { ok: true, savedTo: dest };
}

export function saveCopy(request: SaveCopyRequest): Promise<IpcFsSaveCopyResult> {
	const { source } = request;
	return source.kind === "local" ? saveLocal(source.abs, request) : saveRemote(source.remote, request);
}
