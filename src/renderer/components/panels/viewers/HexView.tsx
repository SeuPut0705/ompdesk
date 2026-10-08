/**
 * Fallback for files with no viewer: file info, "Open with default app", and
 * a hex dump of the first 64 KB. Office formats without an in-app reader
 * (legacy binary .doc/.xls/.ppt, OpenDocument, iWork) land here too, with a
 * note saying which ones can be previewed.
 */
import { useMemo } from "react";
import { formatBytes } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { hexDump } from "./parse";
import { HEX_PREFIX_BYTES, useBinaryFile } from "./use-file-read";
import { useReportFileInfo, ViewerFailure, ViewerFallbackCard, ViewerLoading } from "./viewer-chrome";

export function HexView({
	path,
	tabId,
	office = false,
}: {
	path: string;
	tabId: string | undefined;
	office?: boolean;
}) {
	const t = useT();
	const state = useBinaryFile(path, tabId, HEX_PREFIX_BYTES);
	useReportFileInfo(
		state.status === "ready" || state.status === "tooLarge" ? state.size : null,
		state.status === "ready" || state.status === "tooLarge" ? state.mime : undefined,
	);
	const dump = useMemo(() => (state.status === "ready" ? hexDump(state.data) : ""), [state]);
	if (state.status === "loading") return <ViewerLoading />;
	if (state.status === "error") return <ViewerFailure failure={state.failure} />;
	return (
		<div className="flex h-full min-h-0 flex-col" data-viewer="hex">
			<ViewerFallbackCard
				detail={`${state.mime} · ${formatBytes(state.size)}`}
				path={path}
				title={t(office ? "fileViewer.officeUnsupported" : "fileViewer.binary")}
			/>
			{state.status === "ready" && (
				<>
					<p className="px-3 pb-1 text-omp-xs text-(--omp-dim)">
						{state.truncated
							? t("fileViewer.hexPrefix", { shown: formatBytes(state.data.length) })
							: t("fileViewer.hexAll")}
					</p>
					<div className="min-h-0 flex-1 overflow-auto">
						<pre
							className="m-0 w-max px-3 pb-3 font-mono text-omp-sm leading-[1.5] text-(--omp-text)"
							data-hex-dump
						>
							{dump}
						</pre>
					</div>
				</>
			)}
		</div>
	);
}
