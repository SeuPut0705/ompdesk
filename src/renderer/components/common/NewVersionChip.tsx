import { RefreshCw } from "lucide-react";
import { useChunkFailureStore } from "../../lib/chunk-load";
import { useT } from "../../lib/i18n";
import { reloadPage } from "../../lib/page-reload";

/**
 * "A new version is available · Reload": a part of this build failed to load for good (lib/chunk-load.ts), so the
 * page offers the reload instead of crashing or reloading under the user. One tap reloads (the typed draft is kept,
 * composer/draft-persistence.ts); nothing else on the page changes meanwhile.
 */
export function NewVersionChip() {
	const t = useT();
	const failed = useChunkFailureStore(state => state.failed);
	if (!failed) return null;
	return (
		<div
			className="pointer-events-none fixed inset-x-0 z-[2147483000] flex justify-center px-3"
			style={{ top: "calc(env(safe-area-inset-top, 0px) + 3rem)" }}
		>
			<button
				type="button"
				data-new-version-chip=""
				onClick={() => reloadPage("chunk-load-failed")}
				className="omp-pressable pointer-events-auto flex items-center gap-2 rounded-full border border-(--sc-border) bg-(--sc-elevated) px-3.5 py-1.5 text-sc-sm text-(--sc-text) shadow-lg"
			>
				<span>{t("newVersion.available")}</span>
				<span aria-hidden="true" className="text-(--sc-text-muted)">
					·
				</span>
				<span className="flex items-center gap-1 font-semibold text-(--sc-accent)">
					<RefreshCw aria-hidden="true" className="size-3.5" />
					{t("newVersion.reload")}
				</span>
			</button>
		</div>
	);
}
