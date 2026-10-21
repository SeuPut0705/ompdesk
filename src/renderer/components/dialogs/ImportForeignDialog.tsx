/**
 * Foreign-session import wizard (Claude/Codex → OMP copy): list sessions from
 * a source, narrow them by project, time and text, select some or all, and
 * import each as a fresh OMP session (the source data is never modified) with
 * a progress bar. Closing the dialog mid-import lets the rest finish in the
 * background and report with a toast. A single import opens the new session
 * via the normal switch flow; multiple imports land in the sidebar list with a
 * count toast. Backs the `list_foreign_sessions` / `import_foreign_session` RPCs.
 */

import { Download, Inbox, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcForeignSessionInfo, RpcResponse } from "../../../shared/rpc-types";
import { useShellInput } from "../../hooks/use-shell-mode";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { cx, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import {
	Button,
	EmptyState,
	IconButton,
	InlineNotice,
	Modal,
	ProgressBar,
	SearchField,
	Select,
	SkeletonRows,
	Tabs,
} from "../common";

type Source = "claude" | "codex";

const SOURCES: Source[] = ["claude", "codex"];

/** Time range filter: days back from now, or every session. */
type Range = "all" | "7" | "30" | "90";
const RANGES: readonly Range[] = ["all", "7", "30", "90"];
const DAY_MS = 86_400_000;

/** The selection / completion key of one source's session. */
const sessionKey = (source: Source, id: string) => `${source}:${id}`;

interface SourceState {
	loading: boolean;
	error: InlineFailure | null;
	sessions: RpcForeignSessionInfo[];
}

export function ImportForeignDialog() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const touch = useShellInput() === "touch";
	const close = useUiStore(s => s.closeImportDialog);
	const [source, setSource] = useState<Source>("claude");
	const [states, setStates] = useState<Partial<Record<Source, SourceState>>>({});
	const [query, setQuery] = useState("");
	/** Project folder filter; "" = every project. */
	const [project, setProject] = useState("");
	const [range, setRange] = useState<Range>("all");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [importing, setImporting] = useState(false);
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	const [importError, setImportError] = useState<InlineFailure | null>(null);
	const [completed, setCompleted] = useState<Set<string>>(new Set());
	/** False once the dialog closed: a running import finishes in the background and reports by toast. */
	const open = useRef(true);
	useEffect(
		() => () => {
			open.current = false;
		},
		[],
	);
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
	const projects = useMemo(() => {
		const counts = new Map<string, number>();
		for (const session of state?.sessions ?? []) counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	}, [state]);
	const filtered = useMemo(() => {
		const sessions = state?.sessions ?? [];
		const q = query.trim().toLowerCase();
		const since = range === "all" ? null : Date.now() - Number(range) * DAY_MS;
		return sessions.filter(
			session =>
				(!project || session.cwd === project) &&
				(since === null || Date.parse(session.modified) >= since) &&
				(!q ||
					(session.title ?? "").toLowerCase().includes(q) ||
					(session.firstMessage ?? "").toLowerCase().includes(q) ||
					session.cwd.toLowerCase().includes(q)),
		);
	}, [state, query, project, range]);
	/** The shown sessions a select-all would pick: not imported yet. */
	const selectable = filtered.filter(session => !completed.has(sessionKey(source, session.id)));
	const allSelected =
		selectable.length > 0 && selectable.every(session => selected.has(sessionKey(source, session.id)));

	const toggle = (id: string) => {
		const key = sessionKey(source, id);
		setSelected(current => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const toggleAll = () => {
		setSelected(current => {
			const next = new Set(current);
			for (const session of selectable) {
				if (allSelected) next.delete(sessionKey(source, session.id));
				else next.add(sessionKey(source, session.id));
			}
			return next;
		});
	};

	const doImport = async () => {
		if (!sidecarReady) return;
		const sessions = (state?.sessions ?? []).filter(session => selected.has(sessionKey(source, session.id)));
		if (sessions.length === 0 || importing) return;
		setImporting(true);
		setImportError(null);
		setProgress({ done: 0, total: sessions.length });
		const failed = new Set<string>();
		let lastFailure: InlineFailure | null = null;
		try {
			let firstImported: { sessionPath: string; sessionId: string; cwd: string } | null = null;
			let importedCount = 0;
			for (const [index, session] of sessions.entries()) {
				let response: RpcResponse | null = null;
				let thrown: unknown;
				try {
					response = await tabRpc.importForeignSession(source, session.id);
				} catch (cause) {
					thrown = cause;
				}
				setProgress({ done: index + 1, total: sessions.length });
				const data = response?.success
					? (response.data as { sessionPath?: string; sessionId?: string; cwd?: string } | undefined)
					: undefined;
				if (!data?.sessionPath || !data.sessionId) {
					failed.add(sessionKey(source, session.id));
					lastFailure = inlineFailure(thrown ?? response, t("import.failed"));
					setImportError(lastFailure);
					continue;
				}
				importedCount += 1;
				setCompleted(current => new Set([...current, sessionKey(source, session.id)]));
				firstImported ??= {
					sessionPath: data.sessionPath,
					sessionId: data.sessionId,
					cwd: data.cwd ?? session.cwd,
				};
			}
			if (!open.current) {
				// Closed mid-import: the toast is the only report left.
				if (importedCount > 0)
					toast({ variant: "success", message: t("import.imported", { count: importedCount }) });
				if (failed.size > 0) {
					toast({
						variant: "error",
						title: t("import.failedN", { count: failed.size }),
						message: lastFailure?.message ?? t("import.failed"),
					});
				}
				return;
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
			setImporting(false);
			setProgress(null);
		}
	};

	return (
		<Modal
			open
			onClose={() => {
				// Mid-import, closing hides the dialog; the rest imports in the background.
				if (importing) toast({ variant: "info", message: t("import.background") });
				close();
			}}
			title={t("import.title")}
			size="lg"
			footer={
				<>
					{progress ? (
						<span className="mr-auto flex min-w-0 items-center gap-2" data-import-progress>
							<ProgressBar
								ariaLabel={t("import.progress", { done: progress.done, total: progress.total })}
								className="w-32"
								tone="progress"
								value={progress.done / progress.total}
							/>
							<span className="text-sc-sm text-(--sc-text-muted)" role="status">
								{t("import.progress", { done: progress.done, total: progress.total })}
							</span>
						</span>
					) : (
						<span className="mr-auto text-sc-sm text-(--sc-text-muted)">{t("import.copyNote")}</span>
					)}
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
						setProject("");
					}}
					tabs={SOURCES.map(candidate => ({
						id: candidate,
						label: candidate === "claude" ? "Claude" : "Codex",
						disabled: importing,
					}))}
					variant="segmented"
				/>
				<div
					className={cx(
						"ml-auto flex min-w-48 flex-1 items-center sm:max-w-72",
						touch ? "gap-2.5 [--hit-gap-x:10px]" : "gap-1",
					)}
				>
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
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<label className="mr-auto inline-flex items-center gap-2 text-sc-sm text-(--sc-text-secondary)">
					<input
						checked={allSelected}
						className="accent-(--sc-accent)"
						data-import-select-all
						disabled={!sidecarReady || importing || selectable.length === 0}
						onChange={toggleAll}
						type="checkbox"
					/>
					{t("import.selectAll", { count: selectable.length })}
				</label>
				<div className="w-56">
					<Select
						aria-label={t("import.project")}
						controlSize="sm"
						data-import-project
						disabled={importing}
						onChange={event => setProject(event.target.value)}
						options={[
							{ value: "", label: t("import.allProjects") },
							...projects.map(([cwd, count]) => ({ value: cwd, label: `${cwd} (${count})` })),
						]}
						value={project}
					/>
				</div>
				<div className="w-36">
					<Select
						aria-label={t("import.range")}
						controlSize="sm"
						data-import-range
						disabled={importing}
						onChange={event => setRange(RANGES.find(value => value === event.target.value) ?? "all")}
						options={RANGES.map(value => ({
							value,
							label: value === "all" ? t("import.range.all") : t("import.range.days", { count: value }),
						}))}
						value={range}
					/>
				</div>
			</div>

			{importError && (
				<InlineNotice className="mb-2" detail={importError.cause} live title={importError.message} tone="danger" />
			)}
			<div className="max-h-[46vh] min-h-48 overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle)">
				{state?.loading && <SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />}
				{state?.error && (
					<InlineNotice
						className="px-4 py-6"
						detail={state.error.cause}
						live
						title={state.error.message}
						tone="danger"
					/>
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
