import { SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcActiveTool, RpcActiveToolsResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { AsyncSection, EmptyState, Modal, SearchField } from "../common";
import { SectionLabel } from "../common/SectionLabel";
import { groupToolsBySource } from "./tool-groups";

/**
 * Native /tools: every tool currently visible to the agent, grouped by
 * provenance (built-in factories, `mcp__` servers, the extension/custom-tool
 * path, plugins) with a search filter over names and descriptions.
 */
export function ActiveToolsDialog() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const open = useUiStore(state => state.activeToolsOpen);
	const close = useUiStore(state => state.closeActiveTools);
	const [tools, setTools] = useState<RpcActiveTool[]>([]);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async (): Promise<void> => {
		if (!sidecarReady) {
			setError(t("common.notConnected"));
			setTools([]);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const response = await tabRpc.getActiveTools();
			if (response.success) setTools((response.data as RpcActiveToolsResult).tools);
			else setError(response.error);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, [sidecarReady, t, tabRpc.getActiveTools]);

	useEffect(() => {
		if (!open) return;
		setTools([]);
		setQuery("");
		void reload();
	}, [open, reload]);

	const groups = useMemo(() => groupToolsBySource(tools, query), [tools, query]);

	return (
		<Modal onClose={close} open={open} size="lg" title={t("activeTools.title")}>
			<div className="space-y-3">
				<SearchField
					autoFocus
					label={t("activeTools.search")}
					onValueChange={setQuery}
					placeholder={t("activeTools.search")}
					value={query}
				/>
				<AsyncSection
					className="py-8"
					empty={tools.length === 0}
					emptyLabel={t("activeTools.empty")}
					error={error}
					errorTitle={t("activeTools.error")}
					hasData={tools.length > 0}
					loading={loading}
					loadingLabel={t("activeTools.loading")}
					onRetry={() => void reload()}
				>
					{groups.length === 0 ? (
						<EmptyState icon={<SearchX />} size="sm" title={t("activeTools.noMatch")} />
					) : (
						<div className="space-y-4">
							{groups.map(group => (
								<section key={group.source}>
									<SectionLabel className="mb-1.5" count={group.tools.length}>
										{t(`activeTools.source.${group.source}`)}
									</SectionLabel>
									<div className="divide-y divide-(--sc-divider)">
										{group.tools.map(tool => (
											<div className="px-3 py-1.5" key={`${group.source}:${tool.name}`}>
												<div className="font-mono text-sc-sm font-medium text-(--sc-text)">{tool.name}</div>
												{tool.description ? (
													<div className="mt-0.5 text-sc-sm break-words text-(--sc-text-muted)">
														{tool.description}
													</div>
												) : null}
											</div>
										))}
									</div>
								</section>
							))}
						</div>
					)}
				</AsyncSection>
			</div>
		</Modal>
	);
}
