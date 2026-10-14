/**
 * Where an audio/video element gets its file, for the Files viewer and the
 * chat's players alike. A tab on this device streams through main's
 * `omp-media://` URL (`fs.mediaStream`: fs.readBinary's roots, audio/video
 * only, range requests, so any size plays and seeks without its bytes in the
 * renderer). A paired host's tab has no stream: its bytes come through
 * `fs.readBinary` into a blob (CSP `media-src blob:`) under the host's cap.
 * One source per tab and file is shared by every element showing it and
 * released when the last one unmounts.
 */
import { useEffect, useState } from "react";
import { ipcErrorCode } from "../../../../shared/ipc-error-codes";

export type MediaKind = "audio" | "video";

export type MediaSource =
	| { status: "ready"; url: string; mime: string; size: number }
	| { status: "tooLarge"; size: number; mime: string }
	| { status: "unavailable"; error: unknown };

export type MediaSourceState = MediaSource | { status: "idle" } | { status: "loading" };

interface Shared {
	refs: number;
	load: Promise<MediaSource>;
}

const sources = new Map<string, Shared>();

async function loadMedia(path: string, tabId: string | undefined, kind: MediaKind): Promise<MediaSource> {
	try {
		const stream = tabId ? await window.omp.fs.mediaStream(path, tabId) : await window.omp.fs.mediaStream(path);
		if (stream.ok) return { status: "ready", url: stream.url, mime: stream.mime, size: stream.size };
		if (ipcErrorCode(stream) !== "remote_path_native") return { status: "unavailable", error: stream };
		const read = tabId
			? await window.omp.fs.readBinary(path, undefined, tabId)
			: await window.omp.fs.readBinary(path);
		if (!read.ok) {
			return ipcErrorCode(read) === "file_too_large"
				? { status: "tooLarge", size: read.size, mime: read.mime }
				: { status: "unavailable", error: read };
		}
		// IPC structured clone always backs the bytes with a plain ArrayBuffer, never a shared one.
		const bytes = read.data as Uint8Array<ArrayBuffer>;
		const mime = /^(?:audio|video)\//.test(read.mime) ? read.mime : `${kind}/*`;
		return { status: "ready", url: URL.createObjectURL(new Blob([bytes], { type: mime })), mime, size: read.size };
	} catch (error) {
		return { status: "unavailable", error };
	}
}

function release(key: string): void {
	const shared = sources.get(key);
	if (!shared) return;
	shared.refs -= 1;
	if (shared.refs > 0) return;
	sources.delete(key);
	void shared.load.then(source => {
		if (source.status !== "ready") return;
		if (source.url.startsWith("blob:")) URL.revokeObjectURL(source.url);
		else window.omp.fs.releaseMediaStream(source.url);
	});
}

/** The element's source once `enabled` (lazy players pass false until they near the viewport). */
export function useMediaSource(
	path: string,
	tabId: string | undefined,
	kind: MediaKind,
	enabled = true,
): MediaSourceState {
	const [state, setState] = useState<MediaSourceState>({ status: enabled ? "loading" : "idle" });
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const key = `${tabId ?? ""}\0${path}`;
		let shared = sources.get(key);
		if (shared) shared.refs += 1;
		else {
			shared = { refs: 1, load: loadMedia(path, tabId, kind) };
			sources.set(key, shared);
		}
		setState({ status: "loading" });
		void shared.load.then(source => {
			if (live) setState(source);
		});
		return () => {
			live = false;
			release(key);
		};
	}, [enabled, path, tabId, kind]);
	return state;
}
