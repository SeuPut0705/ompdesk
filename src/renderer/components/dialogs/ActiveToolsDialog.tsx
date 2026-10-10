import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcActiveTool, RpcActiveToolsResult, RpcToolSource } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { AsyncSection, Badge, Input, Modal } from "../common";

const SOURCE_ORDER: RpcToolSource[] = ["builtin", "mcp", "extension", "plugin"];

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

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matches = (tool: RpcActiveTool): boolean =>
			!q || tool.name.toLowerCase().includes(q) || (tool.description ?? "").toLowerCase().includes(q);
		return SOURCE_ORDER.map(source => ({
			source,
			tools: tools.filter(tool => tool.source === source && matches(tool)),
		})).filter(group => group.tools.length > 0);
	}, [tools, query]);

	return (
		<Modal onClose={close} open={open} size="lg" title={t("activeTools.title")}>
			<div className="space-y-3">
				<Input
					aria-label={t("activeTools.search")}
					leadingIcon={<Search />}
					onChange={event => setQuery(event.target.value)}
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
						<div className="py-4 text-sc-sm text-(--sc-text-muted)">{t("activeTools.noMatch")}</div>
					) : (
						<div className="space-y-4">
							{groups.map(group => (
								<section key={group.source}>
									<div className="mb-1.5 flex items-center gap-2">
										<span className="text-sc-xs font-medium text-(--sc-text-muted)">
											{t(`activeTools.source.${group.source}`)}
										</span>
										<Badge variant="muted">{group.tools.length}</Badge>
									</div>
									<div className="divide-y divide-(--sc-divider)">
										{group.tools.map(tool => (
											<div className="px-3 py-2" key={`${group.source}:${tool.name}`}>
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
