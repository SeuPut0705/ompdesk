/**
 * Side panel › Memory: what the active stock memory backend holds and injects,
 * and the operations it implements. Every behavior is stock `MemoryBackend`
 * through the bridge (`get_memory_report`, `memory_*`); search, save and the
 * pending queue appear only when the backend implements that hook. Stock has
 * no list-all or delete-one operation, so neither appears here.
 */

import { Layers, RefreshCw, Trash2 } from "lucide-react";
import { type ComponentProps, type FormEvent, useState } from "react";
import type {
	RpcMemoryQueueResult,
	RpcMemoryReport,
	RpcMemorySaveResult,
	RpcMemorySearchResult,
	RpcResponse,
} from "../../../shared/rpc-types";
import { formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { useTabRpc } from "../../lib/tab-rpc";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, ConfirmDialog, IconButton, SearchField, TextArea } from "../common";
import { MemoryStatus, ResourceGate, useAutoLoad, useRpcResource } from "../settings/PluginsSection";
import { PanelActions } from "./PanelChrome";

const SEARCH_LIMIT = 20;

/** Settings › Agent, where the memory backend is chosen. */
const MEMORY_SETTINGS_ROUTE = "agent:memory-report";

function Section({ title, children, ...rest }: ComponentProps<"section"> & { title: string }) {
	return (
		<section className="flex flex-col gap-2" {...rest}>
			<h3 className="text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase">{title}</h3>
			{children}
		</section>
	);
}

/** The response's data, or a thrown error carrying its failure for `toastError`. */
function unwrap<T>(res: RpcResponse): T {
	if (!res.success) throw new Error(res.error);
	return res.data as T;
}

function MemorySearch() {
	const t = useT();
	const tabRpc = useTabRpc();
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [result, setResult] = useState<RpcMemorySearchResult | null>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const text = query.trim();
		if (!text || searching) return;
		setSearching(true);
		try {
			setResult(unwrap<RpcMemorySearchResult>(await tabRpc.memorySearch(text, SEARCH_LIMIT)));
		} catch (error) {
			toastError({ title: t("memoryPanel.searchFailed"), error });
		} finally {
			setSearching(false);
		}
	};

	return (
		<Section data-memory-search title={t("memoryPanel.searchTitle")}>
			<form className="flex items-start gap-2" onSubmit={event => void submit(event)}>
				<SearchField
					className="min-w-0 flex-1"
					controlSize="sm"
					label={t("memoryPanel.searchTitle")}
					onValueChange={value => {
						setQuery(value);
						if (!value) setResult(null);
					}}
					placeholder={t("memoryPanel.searchPlaceholder")}
					value={query}
				/>
				<Button disabled={!query.trim()} loading={searching} size="sm" type="submit">
					{t("memoryPanel.search")}
				</Button>
			</form>
			{result &&
				(result.items.length === 0 ? (
					<p className="text-sc-sm text-(--sc-text-muted)">
						{t("memoryPanel.searchEmpty")}
						{result.message && <span className="block text-sc-xs">{result.message}</span>}
					</p>
				) : (
					<ul className="flex flex-col divide-y divide-(--sc-divider) border-y border-(--sc-divider)">
						{result.items.map((item, index) => (
							<li className="flex flex-col gap-1 py-2" key={item.id ?? index}>
								<div className="text-sc-sm break-words text-(--sc-text)">
									<MarkdownRenderer content={item.content} />
								</div>
								{(item.source || item.timestamp || item.score !== undefined) && (
									<div className="flex flex-wrap gap-x-3 text-sc-xs text-(--sc-text-muted)">
										{item.source && <span className="truncate">{item.source}</span>}
										{item.timestamp && (
											<time dateTime={item.timestamp} title={item.timestamp}>
												{formatTimeAgo(item.timestamp) || item.timestamp}
											</time>
										)}
										{item.score !== undefined && (
											<span className="tabular-nums">
												{t("memoryPanel.score", { score: item.score.toFixed(2) })}
											</span>
										)}
									</div>
								)}
							</li>
						))}
					</ul>
				))}
		</Section>
	);
}

function MemorySave({ onSaved }: { onSaved: () => void }) {
	const t = useT();
	const tabRpc = useTabRpc();
	const [content, setContent] = useState("");
	const [saving, setSaving] = useState(false);

	const save = async () => {
		const text = content.trim();
		if (!text || saving) return;
		setSaving(true);
		try {
			const result = unwrap<RpcMemorySaveResult>(await tabRpc.memorySave(text));
			// Stock reports "nothing stored" (empty lesson, uninitialised backend) as a result, not an error.
			if (result.stored === 0 && !result.queued) {
				toast({ variant: "warning", message: t("memoryPanel.notStored"), detail: result.message });
				return;
			}
			setContent("");
			toast({
				variant: "success",
				message: t(result.queued ? "memoryPanel.saveQueued" : "memoryPanel.saved"),
				detail: result.message,
			});
			onSaved();
		} catch (error) {
			toastError({ title: t("memoryPanel.saveFailed"), error });
		} finally {
			setSaving(false);
		}
	};

	return (
		<Section data-memory-save title={t("memoryPanel.addTitle")}>
			<TextArea
				aria-label={t("memoryPanel.addTitle")}
				autoGrow
				onChange={event => setContent(event.target.value)}
				placeholder={t("memoryPanel.addPlaceholder")}
				rows={2}
				value={content}
			/>
			<div className="flex justify-end">
				<Button disabled={!content.trim()} loading={saving} onClick={() => void save()} size="sm">
					{t("memoryPanel.save")}
				</Button>
			</div>
		</Section>
	);
}

export function MemoryPanel() {
	const t = useT();
	const tabRpc = useTabRpc();
	const report = useRpcResource<RpcMemoryReport>(() => tabRpc.getMemoryReport());
	const queue = useRpcResource<RpcMemoryQueueResult>(() => tabRpc.memoryQueue());
	const [confirmClear, setConfirmClear] = useState(false);
	const [busy, setBusy] = useState<"clear" | "enqueue" | null>(null);
	const data = report.data;
	const off = data?.backend === "off";
	const capabilities = off ? undefined : data?.capabilities;
	useAutoLoad(report, true);
	useAutoLoad(queue, capabilities?.queue === true);

	const refresh = () => {
		void report.reload();
		if (capabilities?.queue) void queue.reload();
	};

	const run = async (kind: "clear" | "enqueue") => {
		setBusy(kind);
		try {
			unwrap(await (kind === "clear" ? tabRpc.memoryClear() : tabRpc.memoryEnqueue()));
			toast({
				variant: "success",
				message: t(kind === "clear" ? "memoryPanel.cleared" : "memoryPanel.consolidated"),
			});
			refresh();
		} catch (error) {
			toastError({
				title: t(kind === "clear" ? "memoryPanel.clearFailed" : "memoryPanel.consolidateFailed"),
				error,
			});
		} finally {
			setBusy(null);
			setConfirmClear(false);
		}
	};

	const backendName = data ? (off ? t("invPanel.memory.off") : data.backend) : "";
	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col" data-memory-panel>
			<PanelActions>
				<IconButton
					disabled={!report.ready}
					icon={<RefreshCw />}
					label={report.ready ? t("common.refresh") : t("invPanel.notConnected")}
					loading={report.loading}
					onClick={refresh}
					size="sm"
				/>
				{data && !off && (
					<>
						<IconButton
							disabled={!report.ready || busy !== null}
							icon={<Layers />}
							label={t("memoryPanel.consolidate")}
							loading={busy === "enqueue"}
							onClick={() => void run("enqueue")}
							size="sm"
						/>
						<IconButton
							disabled={!report.ready || busy !== null}
							icon={<Trash2 />}
							label={t("memoryPanel.clear")}
							onClick={() => setConfirmClear(true)}
							size="sm"
						/>
					</>
				)}
			</PanelActions>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
				<ResourceGate resource={report}>
					{memory =>
						off ? (
							<div className="flex flex-col items-start gap-2" data-memory-off>
								<p className="text-sc-sm text-(--sc-text-muted)">{t("memoryPanel.off")}</p>
								<Button
									onClick={() => useUiStore.getState().openSettings(MEMORY_SETTINGS_ROUTE)}
									size="sm"
									variant="secondary"
								>
									{t("memoryPanel.chooseBackend")}
								</Button>
							</div>
						) : (
							<div className="flex flex-col gap-5">
								<div className="flex flex-col gap-3">
									<p className="text-sc-sm font-medium text-(--sc-text)">
										{t("invPanel.memory.backend", { backend: backendName })}
										{memory.entryCount !== undefined && (
											<span className="ml-2 font-normal tabular-nums text-(--sc-text-muted)">
												{t("invPanel.memory.entries", { count: memory.entryCount })}
											</span>
										)}
									</p>
									<MemoryStatus report={memory} />
								</div>
								<Section data-memory-payload title={t("memoryPanel.payloadTitle")}>
									{memory.payload ? (
										<div className="text-sc-md text-(--sc-text-secondary)">
											<MarkdownRenderer content={memory.payload} />
										</div>
									) : (
										<p className="text-sc-sm text-(--sc-text-muted)">{t("memoryPanel.payloadEmpty")}</p>
									)}
								</Section>
								{capabilities?.search && <MemorySearch />}
								{capabilities?.save && <MemorySave onSaved={refresh} />}
								{capabilities?.queue && (
									<Section data-memory-queue title={t("memoryPanel.queueTitle")}>
										<ResourceGate resource={queue}>
											{pending =>
												pending.payload ? (
													<div className="text-sc-md text-(--sc-text-secondary)">
														<MarkdownRenderer content={pending.payload} />
													</div>
												) : (
													<p className="text-sc-sm text-(--sc-text-muted)">
														{t("memoryPanel.queueEmpty")}
													</p>
												)
											}
										</ResourceGate>
									</Section>
								)}
							</div>
						)
					}
				</ResourceGate>
			</div>
			<ConfirmDialog
				busy={busy === "clear"}
				confirmLabel={t("memoryPanel.clear")}
				message={t("memoryPanel.clearMessage", { backend: backendName })}
				onCancel={() => setConfirmClear(false)}
				onConfirm={() => void run("clear")}
				open={confirmClear}
				title={t("memoryPanel.clearTitle")}
				warning={t("memoryPanel.clearWarning")}
			/>
		</div>
	);
}
