/**
 * The viewer's two reads. Text kinds go through `fs.read` (UTF-8, NUL sniff,
 * 2 MB main cap); media, PDF and the hex view through `fs.readBinary`. Both
 * forward the tab id so a paired host's tab reads on that host. A newer
 * request (path change, Load more) supersedes an in-flight one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ipcErrorCode } from "../../../../shared/ipc-error-codes";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";

/** First text read; the drawer stays quick for the common small file. */
export const TEXT_PREVIEW_BYTES = 200_000;
/** Main's hard cap for `fs.read`; "Load more" asks for all of it. */
export const TEXT_FULL_BYTES = 2_000_000;
/** The hex view reads a prefix only. */
export const HEX_PREFIX_BYTES = 64 * 1024;

export type TextFileState =
	| { status: "loading" }
	| { status: "error"; failure: InlineFailure }
	| { status: "binary"; size: number }
	| {
			status: "ready";
			content: string;
			truncated: boolean;
			size: number;
			/** Bytes this content was read with; below TEXT_FULL_BYTES, Load more can extend it. */
			maxBytes: number;
			/** A Load more read is in flight; the current content stays on screen. */
			loadingMore: boolean;
	  };

export function useTextFile(path: string, tabId: string | undefined): { state: TextFileState; loadMore: () => void } {
	const t = useT();
	const version = useRef(0);
	const [state, setState] = useState<TextFileState>({ status: "loading" });

	const read = useCallback(
		async (maxBytes: number) => {
			const current = ++version.current;
			try {
				const result = tabId
					? await window.omp.fs.read(path, maxBytes, tabId)
					: await window.omp.fs.read(path, maxBytes);
				if (current !== version.current) return;
				if (!result.ok) {
					setState({ status: "error", failure: inlineFailure(result, t("filesPanel.readFailed")) });
				} else if (result.binary) {
					setState({ status: "binary", size: result.size });
				} else {
					setState({
						status: "ready",
						content: result.content,
						truncated: result.truncated,
						size: result.size,
						maxBytes,
						loadingMore: false,
					});
				}
			} catch (error) {
				if (current !== version.current) return;
				setState({ status: "error", failure: inlineFailure(error, t("filesPanel.readFailed")) });
			}
		},
		[path, tabId, t],
	);

	useEffect(() => {
		setState({ status: "loading" });
		void read(TEXT_PREVIEW_BYTES);
		return () => {
			version.current++;
		};
	}, [read]);

	const loadMore = useCallback(() => {
		setState(prev => (prev.status === "ready" ? { ...prev, loadingMore: true } : prev));
		void read(TEXT_FULL_BYTES);
	}, [read]);

	return { state, loadMore };
}

export type BinaryFileState =
	| { status: "loading" }
	| { status: "error"; failure: InlineFailure }
	| { status: "tooLarge"; size: number; mime: string }
	| { status: "ready"; data: Uint8Array; mime: string; size: number; truncated: boolean };

/**
 * `prefixBytes` asks for a prefix (hex view): a bigger file comes back
 * truncated. Without it the whole file is required, and a file over main's
 * cap is the too-large state.
 */
export function useBinaryFile(path: string, tabId: string | undefined, prefixBytes?: number): BinaryFileState {
	const t = useT();
	const [state, setState] = useState<BinaryFileState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		void (async () => {
			try {
				const result = tabId
					? await window.omp.fs.readBinary(path, prefixBytes, tabId)
					: await window.omp.fs.readBinary(path, prefixBytes);
				if (cancelled) return;
				if (!result.ok) {
					setState(
						ipcErrorCode(result) === "file_too_large"
							? { status: "tooLarge", size: result.size, mime: result.mime }
							: { status: "error", failure: inlineFailure(result, t("filesPanel.readFailed")) },
					);
				} else if (result.truncated && prefixBytes === undefined) {
					setState({ status: "tooLarge", size: result.size, mime: result.mime });
				} else {
					setState({
						status: "ready",
						data: result.data,
						mime: result.mime,
						size: result.size,
						truncated: result.truncated,
					});
				}
			} catch (error) {
				if (!cancelled) setState({ status: "error", failure: inlineFailure(error, t("filesPanel.readFailed")) });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path, tabId, prefixBytes, t]);

	return state;
}
