import { useTabRpc } from "../../lib/tab-rpc";
/**
 * Foreign-session import wizard (Claude/Codex → OMP copy): list sessions from
 * a source, multi-select, import each as a fresh OMP session (the source data
 * is never modified). A single import opens the new session via the normal
 * switch flow; multiple imports land in the sidebar list with a count toast.
 * Backs the `list_foreign_sessions` / `import_foreign_session` RPCs.
 */

import { Download, Inbox, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcForeignSessionInfo, RpcResponse } from "../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, EmptyState, ErrorDetail, IconButton, Modal, SearchField, Spinner, Tabs } from "../common";

type Source = "claude" | "codex";

const SOURCES: Source[] = ["claude", "codex"];

interface SourceState {
	loading: boolean;
	error: InlineFailure | null;
	sessions: RpcForeignSessionInfo[];
}

export function ImportForeignDialog() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const close = useUiStore(s => s.closeImportDialog);
	const [source, setSource] = useState<Source>("claude");
	const [states, setStates] = useState<Partial<Record<Source, SourceState>>>({});
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<InlineFailure | null>(null);
	const [completed, setCompleted] = useState<Set<string>>(new Set());
	const generation = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a different session client invalidates pending imports.
	useEffect(() => {
		generation.current++;
		return () => {
			generation.current++;
		};
	}, [tabRpc]);

	const load = useCallback(
		async (target: Source, force = false) => {
			if (!sidecarReady) return;
			const existing = states[target];
			if (!force && existing && (existing.sessions.length > 0 || existing.error !== null || existing.loading)) {
				return;
			}
			setStates(current => ({ ...current, [target]: { loading: true, error: null, sessions: [] } }));
			const version = generation.current;
			try {
				const response = await tabRpc.listForeignSessions(target);
				if (version !== generation.current) return;
				if (!response.success) {
					setStates(current => ({
						...current,
						[target]: {
							loading: false,
							error: inlineFailure(response, t("import.sourceUnavailable", { source: target })),
							sessions: [],
						},
					}));
					return;
				}
				const data = response.data as { sessions?: RpcForeignSessionInfo[] } | undefined;
				setStates(current => ({
					...current,
					[target]: { loading: false, error: null, sessions: data?.sessions ?? [] },
				}));
			} catch (cause) {
				if (generation.current === version) {
					const error = inlineFailure(cause, t("import.sourceUnavailable", { source: target }));
					setStates(current => ({ ...current, [target]: { loading: false, error, sessions: [] } }));
				}
			}
		},
		[sidecarReady, states, t, tabRpc.listForeignSessions],
	);

	// Reload only when the source tab changes (load() closes over cached states).
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed reload by design
	useEffect(() => {
		if (!sidecarReady) {
			setStates(current => ({
				...current,
				[source]: {
					loading: false,
					error: { message: t("import.sourceUnavailable", { source }), cause: t("import.notConnected") },
					sessions: [],
				},
			}));
			return;
		}
		void load(source, true);
	}, [source, sidecarReady, tabRpc]);

	const state = states[source];
	const filtered = useMemo(() => {
		const sessions = state?.sessions ?? [];
		const q = query.trim().toLowerCase();
		if (!q) return sessions;
		return sessions.filter(
			session =>
				(session.title ?? "").toLowerCase().includes(q) ||
				(session.firstMessage ?? "").toLowerCase().includes(q) ||
				session.cwd.toLowerCase().includes(q),
		);
	}, [state, query]);

	const toggle = (id: string) => {
		id = `${source}:${id}`;
		setSelected(current => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const doImport = async () => {
		if (!sidecarReady) return;
		const sessions = (state?.sessions ?? []).filter(session => selected.has(`${source}:${session.id}`));
		if (sessions.length === 0 || importing) return;
		setImporting(true);
		setImportError(null);
		const failed = new Set<string>();
		const version = generation.current;
		try {
			let firstImported: { sessionPath: string; sessionId: string; cwd: string } | null = null;
			let importedCount = 0;
			for (const session of sessions) {
				let response: RpcResponse;
				try {
					response = await tabRpc.importForeignSession(source, session.id);
				} catch (cause) {
					failed.add(`${source}:${session.id}`);
					setImportError(inlineFailure(cause, t("import.failed")));
					continue;
				}
				if (generation.current !== version) return;
				if (!response.success) {
					failed.add(`${source}:${session.id}`);
					setImportError(inlineFailure(response, t("import.failed")));
					continue;
				}
				const data = response.data as { sessionPath?: string; sessionId?: string; cwd?: string } | undefined;
				if (data?.sessionPath && data.sessionId) {
					importedCount += 1;
					setCompleted(current => new Set([...current, `${source}:${session.id}`]));
					firstImported ??= {
						sessionPath: data.sessionPath,
						sessionId: data.sessionId,
						cwd: data.cwd ?? session.cwd,
					};
				}
			}
			if (importedCount === 0) return;
			if (sessions.length === 1 && firstImported) {
				const tabId = await useTabsStore.getState().openTab({ sessionPath: firstImported.sessionPath });
				if (tabId) close();
				else setImportError({ message: t("import.openFailed", { path: firstImported.sessionPath }) });
				return;
			}
			toast({ variant: "success", message: t("import.imported", { count: importedCount }) });
			setSelected(failed);
			// Refresh the list after a batch so newly available source sessions and
			// completion markers are reconciled instead of leaving a stale snapshot.
			await load(source, true);
		} catch (cause) {
			setImportError(inlineFailure(cause, t("import.failed")));
		} finally {
			if (generation.current === version) setImporting(false);
		}
	};

	return (
		<Modal
			open
			onClose={() => {
				if (!importing) close();
			}}
			title={t("import.title")}
			size="lg"
			footer={
				<>
					<span className="mr-auto text-sc-sm text-(--sc-text-muted)">{t("import.copyNote")}</span>
					<Button
						disabled={!sidecarReady || selected.size === 0 || importing}
						icon={<Download />}
						loading={importing}
						onClick={() => void doImport()}
						size="sm"
						variant="primary"
						title={!sidecarReady ? t("import.notConnected") : undefined}
					>
						{selected.size > 0 ? t("import.importN", { count: selected.size }) : t("import.import")}
					</Button>
				</>
			}
		>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<Tabs
					activeId={source}
					ariaLabel={t("import.source")}
					onChange={id => {
						setSource(id as Source);
						setSelected(new Set());
					}}
					tabs={SOURCES.map(candidate => ({
						id: candidate,
						label: candidate === "claude" ? "Claude" : "Codex",
						disabled: importing,
					}))}
					variant="segmented"
				/>
				<div className="ml-auto flex min-w-48 flex-1 items-center gap-1 sm:max-w-72">
					<div className="min-w-0 flex-1">
						<SearchField
							label={t("import.search")}
							onValueChange={setQuery}
							placeholder={t("import.search")}
							value={query}
						/>
					</div>
					<IconButton
						disabled={!sidecarReady || importing || state?.loading}
						icon={<RotateCw />}
						label={sidecarReady ? t("common.refresh") : t("import.notConnected")}
						onClick={() => void load(source, true)}
					/>
				</div>
			</div>

			{importError && (
				<p role="alert" className="mb-2 text-sc-sm text-(--sc-danger)">
					{importError.message}
					<ErrorDetail className="mt-0.5" error={importError.cause} />
				</p>
			)}
			<div className="max-h-[46vh] min-h-48 overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle)">
				{state?.loading && (
					<div className="flex h-32 items-center justify-center text-(--sc-text-muted)">
						<Spinner label={t("common.loading")} />
					</div>
				)}
				{state?.error && (
					<div className="px-4 py-6 text-center text-sc-md text-(--sc-text-secondary)" role="alert">
						{state.error.message}
						<ErrorDetail className="mt-1" error={state.error.cause} />
					</div>
				)}
				{!state?.loading && !state?.error && filtered.length === 0 && (
					<EmptyState
						icon={<Inbox />}
						size="sm"
						title={query ? t("import.noMatch", { query }) : t("import.empty")}
					/>
				)}
				{!state?.loading &&
					!state?.error &&
					filtered.map(session => (
						<label
							key={session.id}
							className="flex cursor-pointer flex-wrap items-start gap-3 border-b border-(--sc-divider) px-3 py-2.5 last:border-0 hover:bg-(--sc-hover)"
						>
							<input
								type="checkbox"
								disabled={!sidecarReady || importing || completed.has(`${source}:${session.id}`)}
								title={!sidecarReady ? t("import.notConnected") : undefined}
								checked={selected.has(`${source}:${session.id}`)}
								onChange={() => toggle(session.id)}
								className="mt-1 accent-(--sc-accent)"
							/>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sc-md font-medium text-(--sc-text)">
									{session.title ?? session.firstMessage ?? t("import.untitled")}
									{completed.has(`${source}:${session.id}`) && (
										<span className="ml-2 text-(--sc-success)">{t("import.done")}</span>
									)}
								</span>
								<span className="mt-0.5 block whitespace-pre-wrap text-sc-sm break-words text-(--sc-text-secondary)">
									{session.firstMessage}
								</span>
								<span className="mt-0.5 block truncate font-mono text-sc-xs text-(--sc-text-muted)">
									{session.cwd}
								</span>
							</span>
							<span className="ml-auto shrink-0 text-right text-sc-xs text-(--sc-text-muted)">
								{formatTimeAgo(session.modified)}
								{session.messageCount !== undefined && (
									<span className="block">{t("import.messages", { count: session.messageCount })}</span>
								)}
							</span>
						</label>
					))}
			</div>
		</Modal>
	);
}
