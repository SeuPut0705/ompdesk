/**
 * Settings › Extensions: one section with underline tabs over the session's
 * skills, MCP servers, hooks, instruction (context) files and custom slash
 * commands. The page owns the
 * active tab and the single search field (`query`, empty = no filter).
 *
 * Each list tab lazy-loads on first view, caches for the lifetime of the
 * mounted section, and offers a manual refresh.
 *
 * Rows are interactive where a mutation RPC exists: hooks toggle via
 * set_hook_enabled and MCP servers carry an action menu (enable / disable /
 * reconnect / remove via mcp_action, plus test connection via mcp_test and
 * re-authorize via mcp_reauth / mcp_reauth_cancel). New MCP servers are added
 * through the wizard dialog (mcp_add). The commands tab is read-only — the
 * sidecar exposes no slash-command management RPC. Toggles are optimistic —
 * the row reverts and an error toast fires on failure, and a successful
 * mutation re-fetches the tab. Hook toggles persist but only bind at startup,
 * so the footer flags them as next-session. Instruction files toggle stock's
 * `context-file:<level>:<name>` disable id and apply from the next turn.
 * Skills live in ./SkillsTab.
 */

import { Braces, FileText, Network, Plus, RefreshCw, Search, Webhook } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AvailableCommand,
	RpcContextFileInfo,
	RpcContextFilesResult,
	RpcHookInfo,
	RpcHooksResult,
	RpcMcpServerInfo,
	RpcMcpServersResult,
	RpcResponse,
} from "../../../shared/rpc-types";
import { useActiveTabRouteReady } from "../../hooks/use-active-tab-route";
import { shortenPath } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { type TabRpc as SessionRpc, useTabRpc as useSessionRpc } from "../../lib/tab-rpc";
import { useFocusedTabDevice } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import {
	Badge,
	type BadgeVariant,
	Banner,
	Button,
	ConfirmDialog,
	EmptyState,
	ErrorDetail,
	IconButton,
	Spinner,
	type TabItem,
	Tabs,
} from "../common";
import { type McpTestView, summarizeMcpTestData } from "../panels/mcp/McpFeedback";
import { type McpCardAction, type McpReauthPhase, McpServerCard } from "../panels/mcp/McpServerCard";
import { McpServerWizard } from "../panels/mcp/McpServerWizard";
import { BuiltinReaRow } from "./BuiltinReaRow";
import { SettingsRow, SettingsSwitchRow } from "./SettingsLayout";
import { SkillsTab } from "./SkillsTab";

export type ExtensionsTab = "skills" | "mcp" | "hooks" | "contextFiles" | "commands";
type ListTab = Exclude<ExtensionsTab, "skills">;

export interface ExtensionsSectionProps {
	tab: ExtensionsTab;
	onTabChange: (tab: ExtensionsTab) => void;
	/** Page search; empty string = no filter. */
	query: string;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface LazyRpc<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
	ready: boolean;
	/** Re-fetch; awaited by row mutations so fresh state replaces optimistic overlays. */
	refresh: () => Promise<void>;
}

const fetchHooks = (rpc: SessionRpc): Promise<RpcResponse> => rpc.getHooks();
const pickHooks = (data: unknown): RpcHookInfo[] => (data as RpcHooksResult | undefined)?.hooks ?? [];
const fetchContextFiles = (rpc: SessionRpc): Promise<RpcResponse> => rpc.getContextFiles();
const pickContextFiles = (data: unknown): RpcContextFileInfo[] =>
	(data as RpcContextFilesResult | undefined)?.files ?? [];
const fetchMcpServers = (rpc: SessionRpc): Promise<RpcResponse> => rpc.getMcpServers();
const pickMcpServers = (data: unknown): RpcMcpServerInfo[] => (data as RpcMcpServersResult | undefined)?.servers ?? [];
const fetchCommands = (rpc: SessionRpc): Promise<RpcResponse> => rpc.getAvailableCommands();
const pickCommands = (data: unknown): AvailableCommand[] =>
	((data as { commands?: AvailableCommand[] } | undefined)?.commands ?? []).filter(isCustomCommand);

/**
 * Lazy per-tab RPC loader: fires on the tab's first activation, then caches
 * until the route (active tab / cwd) changes. `refresh` re-fetches on demand.
 */
function useLazyRpc<T>(
	active: boolean,
	fetcher: (rpc: SessionRpc) => Promise<RpcResponse>,
	pick: (data: unknown) => T,
): LazyRpc<T> {
	const client = useSessionRpc();
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const cwd = useSessionStore(s => s.cwd);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const routeReady = useActiveTabRouteReady();
	const routeKey = `${activeTabId ?? "none"}:${cwd}`;
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const attemptedRef = useRef(false);
	const requestRef = useRef(0);
	const routeRef = useRef(routeKey);

	const load = useCallback(async () => {
		if (!sidecarReady || !routeReady) {
			setError(t("extPanel.notConnected"));
			return;
		}
		const request = ++requestRef.current;
		const requestRoute = routeKey;
		setLoading(true);
		setError(null);
		try {
			const res = await fetcher(client);
			if (request !== requestRef.current || requestRoute !== routeRef.current) return;
			if (res.success) setData(pick(res.data));
			else setError(res.error);
		} catch (cause) {
			if (request === requestRef.current && requestRoute === routeRef.current) setError(String(cause));
		} finally {
			if (request === requestRef.current && requestRoute === routeRef.current) setLoading(false);
		}
	}, [sidecarReady, routeReady, routeKey, fetcher, client, pick, t]);

	useEffect(() => {
		routeRef.current = routeKey;
		requestRef.current += 1;
		attemptedRef.current = false;
		setData(null);
		setError(null);
		setLoading(false);
	}, [routeKey]);

	useEffect(() => {
		if (!active || !routeReady || attemptedRef.current) return;
		attemptedRef.current = true;
		void load();
	}, [active, load, routeReady]);

	const refresh = useCallback(async (): Promise<void> => {
		await load();
	}, [load]);

	return { data, error, loading, ready: sidecarReady && routeReady, refresh };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Case-insensitive substring filter over a row's searchable fields. */
export function filterList<T>(items: T[] | null, query: string, fields: (item: T) => string[]): T[] {
	if (!items) return [];
	const q = query.trim().toLowerCase();
	if (!q) return items;
	return items.filter(item => fields(item).some(field => field.toLowerCase().includes(q)));
}

export function hookPhase(event: string): string {
	const sep = event.indexOf(":");
	return sep === -1 ? event : event.slice(0, sep);
}

export function hookTool(event: string): string {
	const sep = event.indexOf(":");
	return sep === -1 ? "" : event.slice(sep + 1);
}

/** Bucket hooks by event tool, groups sorted A–Z, row order preserved within a group. */
export function groupHooksByTool(hooks: RpcHookInfo[]): Array<[string, RpcHookInfo[]]> {
	const byTool = new Map<string, RpcHookInfo[]>();
	for (const hook of hooks) {
		const tool = hookTool(hook.event) || "*";
		const bucket = byTool.get(tool);
		if (bucket) bucket.push(hook);
		else byTool.set(tool, [hook]);
	}
	return [...byTool.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Sidecar-advertised commands that did not ship with the binary (any source but "builtin"). */
export function isCustomCommand(command: AvailableCommand): boolean {
	return command.source !== "builtin";
}

/** Sources with a localized label; anything else falls back to the raw source string. */
const KNOWN_COMMAND_SOURCES: Record<string, true> = {
	custom: true,
	extension: true,
	file: true,
	mcp_prompt: true,
	other: true,
	skill: true,
};

/** Bucket commands by their origin source, groups sorted A–Z, row order preserved within a group. */
export function groupCommandsBySource(commands: AvailableCommand[]): Array<[string, AvailableCommand[]]> {
	const bySource = new Map<string, AvailableCommand[]>();
	for (const command of commands) {
		const source = command.source ?? "other";
		const bucket = bySource.get(source);
		if (bucket) bucket.push(command);
		else bySource.set(source, [command]);
	}
	return [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------
// Row mutations: optimistic enable overlay + one-at-a-time busy key
// ---------------------------------------------------------------------------

interface RowMutation {
	/** Key of the row whose mutation is in flight (null = idle). */
	busyKey: string | null;
	/** Row enable state with the optimistic overlay applied. */
	effective: (key: string, base: boolean) => boolean;
	/**
	 * Run one row mutation: apply the optimistic enable state (`next`, null =
	 * no overlay), call the RPC, re-fetch on success, revert + toast on error.
	 * Controls stay disabled while `busyKey` is set — one mutation at a time.
	 */
	run: (key: string, next: boolean | null, action: () => Promise<RpcResponse>, errorTitle: string) => Promise<void>;
}

function useRowMutation(refresh: () => Promise<void>, ready = true): RowMutation {
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});

	const effective = useCallback((key: string, base: boolean): boolean => overrides[key] ?? base, [overrides]);

	const run = useCallback(
		async (key: string, next: boolean | null, action: () => Promise<RpcResponse>, errorTitle: string) => {
			if (!ready) return;
			setBusyKey(key);
			if (next !== null) setOverrides(prev => ({ ...prev, [key]: next }));
			const clearOverride = (): void =>
				setOverrides(prev => {
					if (!(key in prev)) return prev;
					const rest = { ...prev };
					delete rest[key];
					return rest;
				});
			try {
				const res = await action();
				if (!res.success) {
					clearOverride();
					toastError({ title: errorTitle, error: res });
					return;
				}
				// Fresh server state replaces the optimistic overlay.
				await refresh();
				clearOverride();
			} catch (cause) {
				clearOverride();
				toastError({ title: errorTitle, error: cause });
			} finally {
				setBusyKey(null);
			}
		},
		[ready, refresh],
	);

	return { busyKey, effective, run };
}

// ---------------------------------------------------------------------------
// Shared list frame: description + count + refresh, then state handling
// ---------------------------------------------------------------------------

const TAB_ICON: Record<ListTab, ReactNode> = {
	mcp: <Network />,
	hooks: <Webhook />,
	contextFiles: <FileText />,
	commands: <Braces />,
};

interface ListFrameProps {
	tabId: ListTab;
	rpc: LazyRpc<unknown[]>;
	query: string;
	visible: number;
	/** Extra toolbar buttons before Refresh (e.g. MCP add-server). */
	actions?: ReactNode;
	/** Fixing action for the empty list. */
	emptyAction?: ReactNode;
	children: ReactNode;
}

function ListFrame({ tabId, rpc, query, visible, actions, emptyAction, children }: ListFrameProps) {
	const t = useT();
	const trimmed = query.trim();
	const loaded = rpc.data !== null;
	const total = rpc.data?.length ?? 0;
	// An empty list's own state says "none" and carries the fixing action: the toolbar repeats neither.
	const empty = loaded && total === 0;
	const countText =
		loaded && !empty
			? trimmed
				? t(`extPanel.countFiltered.${tabId}`, { shown: visible, total })
				: t(`extPanel.count.${tabId}`, { count: total })
			: null;
	const retry = (
		<Button
			disabled={!rpc.ready}
			onClick={() => void rpc.refresh()}
			size="sm"
			title={!rpc.ready ? t("extPanel.notConnected") : undefined}
		>
			{t("common.retry")}
		</Button>
	);

	let body: ReactNode = null;
	if (!loaded) {
		if (rpc.loading) {
			body = (
				<div className="flex justify-center py-10">
					<Spinner label={t("common.loading")} />
				</div>
			);
		} else if (rpc.error) {
			body = (
				<Banner actions={retry} title={t("extPanel.loadFailed")} variant="danger">
					<ErrorDetail error={rpc.error} />
				</Banner>
			);
		}
	} else if (total === 0) {
		body = <EmptyState actions={emptyAction} icon={TAB_ICON[tabId]} size="sm" title={t(`extPanel.empty.${tabId}`)} />;
	} else if (visible === 0) {
		body = <EmptyState icon={<Search />} size="sm" title={t("extPanel.noMatch", { query: trimmed })} />;
	} else {
		body = children;
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-start gap-x-3 gap-y-2">
				<p className="min-w-0 max-w-2xl flex-1 text-sc-sm text-(--sc-text-muted)">
					{t(`settings.extensions.${tabId}.description`)}
				</p>
				<div className="flex shrink-0 items-center gap-2">
					{countText && <span className="text-sc-xs tabular-nums text-(--sc-text-muted)">{countText}</span>}
					{empty && emptyAction ? null : actions}
					<IconButton
						disabled={!rpc.ready}
						icon={<RefreshCw />}
						label={!rpc.ready ? t("extPanel.notConnected") : t("common.refresh")}
						loading={rpc.loading}
						onClick={() => void rpc.refresh()}
						size="sm"
					/>
				</div>
			</div>
			{loaded && rpc.error && (
				<Banner actions={retry} title={t("extPanel.loadFailed")} variant="danger">
					<ErrorDetail error={rpc.error} />
				</Banner>
			)}
			{body}
			<p className="text-sc-xs text-(--sc-text-muted)">{t(`extPanel.footer.${tabId}`)}</p>
		</div>
	);
}

/** Small uppercase group label over a hairline-divided list of rows. */
function RowGroup({ label, count, children }: { label: ReactNode; count: number; children: ReactNode }) {
	return (
		<section className="flex flex-col">
			<h3 className="flex items-center gap-2 pb-1 font-mono text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase">
				{label}
				<span className="font-sans font-normal tabular-nums">{count}</span>
			</h3>
			<div className="divide-y divide-(--sc-divider) border-y border-(--sc-divider)">{children}</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Hooks tab
// ---------------------------------------------------------------------------

function HooksTab({ rpc, query }: { rpc: LazyRpc<RpcHookInfo[]>; query: string }) {
	const tabRpc = useSessionRpc();
	const t = useT();
	const mutation = useRowMutation(rpc.refresh, rpc.ready);
	const { groups, visibleCount } = useMemo(() => {
		const visible = filterList(rpc.data, query, hook => [hook.name, hook.event, hook.source]);
		return { groups: groupHooksByTool(visible), visibleCount: visible.length };
	}, [rpc.data, query]);
	return (
		<ListFrame query={query} rpc={rpc} tabId="hooks" visible={visibleCount}>
			<div className="flex flex-col gap-5">
				{groups.map(([tool, hooks]) => (
					<RowGroup count={hooks.length} key={tool} label={tool}>
						{hooks.map(hook => {
							const enabled = mutation.effective(hook.id, hook.enabled);
							const busy = mutation.busyKey === hook.id;
							const phase = hookPhase(hook.event);
							const eventVariant: BadgeVariant =
								phase === "pre" ? "info" : phase === "post" ? "warning" : "default";
							return (
								<SettingsSwitchRow
									badge={
										<>
											<Badge variant={eventVariant}>{hook.event}</Badge>
											<Badge variant="muted">{hook.source}</Badge>
										</>
									}
									checked={enabled}
									description={
										<span className="block truncate font-mono text-sc-xs" title={hook.path}>
											{shortenPath(hook.path)}
										</span>
									}
									disabled={mutation.busyKey !== null || !rpc.ready}
									extra={busy ? <Spinner size="sm" /> : undefined}
									key={hook.id}
									label={<span className="font-mono">{hook.name}</span>}
									onCheckedChange={next =>
										void mutation.run(
											hook.id,
											next,
											() => tabRpc.setHookEnabled(hook.id, next),
											t("extPanel.hookToggleFailed"),
										)
									}
								/>
							);
						})}
					</RowGroup>
				))}
			</div>
		</ListFrame>
	);
}

// ---------------------------------------------------------------------------
// Instruction (context) files tab
// ---------------------------------------------------------------------------

/**
 * mixdog's "Load instruction files", per file name: stock has no master switch,
 * but its extension dashboard disables a name at a level (`context-file:<level>:<name>`),
 * which covers every such file (every folder's AGENTS.md at project level).
 */
function ContextFilesTab({ rpc, query }: { rpc: LazyRpc<RpcContextFileInfo[]>; query: string }) {
	const tabRpc = useSessionRpc();
	const t = useT();
	const mutation = useRowMutation(rpc.refresh, rpc.ready);
	const { groups, visibleCount } = useMemo(() => {
		const visible = filterList(rpc.data, query, file => [file.name, ...file.files.map(entry => entry.path)]);
		const byLevel = (level: RpcContextFileInfo["level"]) => visible.filter(file => file.level === level);
		return {
			groups: [
				["project", byLevel("project")],
				["user", byLevel("user")],
			] as const,
			visibleCount: visible.length,
		};
	}, [rpc.data, query]);
	return (
		<ListFrame query={query} rpc={rpc} tabId="contextFiles" visible={visibleCount}>
			<div className="flex flex-col gap-5">
				{groups.map(([level, files]) =>
					files.length === 0 ? null : (
						<RowGroup count={files.length} key={level} label={t(`extPanel.contextFiles.level.${level}`)}>
							{files.map(file => (
								<SettingsSwitchRow
									badge={[...new Set(file.files.map(entry => entry.provider))].map(provider => (
										<Badge key={provider} variant="muted">
											{provider}
										</Badge>
									))}
									checked={mutation.effective(file.id, file.enabled)}
									data-context-file={file.id}
									description={
										<span className="flex flex-col">
											{file.files.map(entry => (
												<span
													className="block truncate font-mono text-sc-xs"
													key={entry.path}
													title={entry.path}
												>
													{shortenPath(entry.path)}
												</span>
											))}
										</span>
									}
									disabled={mutation.busyKey !== null || !rpc.ready}
									extra={mutation.busyKey === file.id ? <Spinner size="sm" /> : undefined}
									key={file.id}
									label={<span className="font-mono">{file.name}</span>}
									onCheckedChange={next =>
										void mutation.run(
											file.id,
											next,
											() => tabRpc.setContextFileEnabled(file.id, next),
											t("extPanel.contextFileToggleFailed"),
										)
									}
								/>
							))}
						</RowGroup>
					),
				)}
			</div>
		</ListFrame>
	);
}

// ---------------------------------------------------------------------------
// MCP tab
// ---------------------------------------------------------------------------

/**
 * MCP tab: server rows (panels/mcp/McpServerCard) + the add-server wizard and
 * the remove confirmation. Test and re-auth state is tracked per server name
 * in local maps — never derived from the server list, and a successful
 * mutation re-fetches the tab (no optimistic auth/tool-count derivation).
 */
function McpTab({ rpc, query }: { rpc: LazyRpc<RpcMcpServerInfo[]>; query: string }) {
	const tabRpc = useSessionRpc();
	const t = useT();
	const device = useFocusedTabDevice();
	const mutation = useRowMutation(rpc.refresh, rpc.ready);
	const [confirmRemoveFor, setConfirmRemoveFor] = useState<RpcMcpServerInfo | null>(null);
	const [wizardOpen, setWizardOpen] = useState(false);
	const [tests, setTests] = useState<Readonly<Record<string, { testing: boolean; view: McpTestView | null }>>>({});
	const [reauths, setReauths] = useState<Readonly<Record<string, McpReauthPhase>>>({});
	// Mirrors `reauths` so the async reauth body can tell an intentional cancel
	// (suppress its failure toast) from a genuine one after the await.
	const reauthPhaseRef = useRef<Record<string, McpReauthPhase>>({});
	// Prune stale per-server test/reauth entries whenever the server set
	// changes: a removed server's result must not leak onto a same-name
	// re-add after the next refetch (state is keyed by name, not identity).
	useEffect(() => {
		const names = new Set((rpc.data ?? []).map(s => s.name));
		let phaseDirty = false;
		for (const n of Object.keys(reauthPhaseRef.current)) {
			if (!names.has(n)) {
				delete reauthPhaseRef.current[n];
				phaseDirty = true;
			}
		}
		if (phaseDirty) setReauths({ ...reauthPhaseRef.current });
		setTests(prev => {
			const stale = Object.keys(prev).filter(n => !names.has(n));
			if (stale.length === 0) return prev;
			const rest = { ...prev };
			for (const n of stale) delete rest[n];
			return rest;
		});
	}, [rpc.data]);
	const visible = useMemo(
		() =>
			filterList(rpc.data?.filter(server => server.builtin !== "rea") ?? null, query, server => [
				server.name,
				server.transport,
				server.status,
				server.scope ?? "",
				server.command ?? "",
				server.url ?? "",
			]),
		[rpc.data, query],
	);

	const setReauthPhase = (name: string, phase: McpReauthPhase | null): void => {
		if (phase === null) {
			const rest = { ...reauthPhaseRef.current };
			delete rest[name];
			reauthPhaseRef.current = rest;
			setReauths(rest);
		} else {
			reauthPhaseRef.current = { ...reauthPhaseRef.current, [name]: phase };
			setReauths(reauthPhaseRef.current);
		}
	};

	const runTest = async (server: RpcMcpServerInfo): Promise<void> => {
		if (!rpc.ready) return;
		setTests(prev => ({ ...prev, [server.name]: { testing: true, view: null } }));
		let view: McpTestView;
		try {
			const res = await tabRpc.mcpTest({ name: server.name });
			view = res.success ? summarizeMcpTestData(res.data) : { kind: "error", error: res.error };
		} catch (cause) {
			view = { kind: "error", error: cause instanceof Error ? cause.message : String(cause) };
		}
		setTests(prev => ({ ...prev, [server.name]: { testing: false, view } }));
	};

	const runReauth = async (server: RpcMcpServerInfo): Promise<void> => {
		if (!rpc.ready) return;
		setReauthPhase(server.name, "running");
		try {
			// Long-timeout call; the extension_ui open_url/input dialogs render the
			// OAuth flow while this is in flight.
			const res = await tabRpc.mcpReauth(server.name);
			const cancelling = reauthPhaseRef.current[server.name] === "cancelling";
			if (!res.success) {
				if (cancelling) return;
				if (res.code === "oauth_busy") {
					toast({ variant: "info", message: t("mcp.reauth.busy") });
				} else {
					toastError({ title: t("mcp.reauth.failed"), error: res });
				}
				return;
			}
			const data = res.data as { ok?: boolean; error?: string } | undefined;
			if (data?.ok === false) {
				if (!cancelling) {
					toastError({ title: t("mcp.reauth.failed"), error: data });
				}
				return;
			}
			if (!cancelling) toast({ variant: "success", message: t("mcp.reauth.ok", { name: server.name }) });
			// Reload can change authState/toolCount — refetch rather than derive.
			await rpc.refresh();
		} catch (cause) {
			if (reauthPhaseRef.current[server.name] !== "cancelling") {
				toastError({ title: t("mcp.reauth.failed"), error: cause });
			}
		} finally {
			setReauthPhase(server.name, null);
		}
	};

	const runReauthCancel = async (server: RpcMcpServerInfo): Promise<void> => {
		if (!rpc.ready) return;
		setReauthPhase(server.name, "cancelling");
		const restore = (): void => {
			// Cancel failed: the flow is presumably still alive — re-arm the button.
			if (reauthPhaseRef.current[server.name] === "cancelling") setReauthPhase(server.name, "running");
		};
		try {
			const res = await tabRpc.mcpReauthCancel(server.name);
			// On success the pending mcpReauth settles and runReauth clears the phase.
			if (!res.success) {
				toastError({ title: t("mcp.reauth.cancelFailed"), error: res });
				restore();
			}
		} catch (cause) {
			toastError({ title: t("mcp.reauth.cancelFailed"), error: cause });
			restore();
		}
	};

	const dismissTest = (name: string): void => {
		setTests(prev => {
			if (!(name in prev)) return prev;
			const rest = { ...prev };
			delete rest[name];
			return rest;
		});
	};

	const handleMenuAction = (server: RpcMcpServerInfo, action: McpCardAction): void => {
		if (!rpc.ready) return;
		if (action === "remove") {
			// Destructive: confirm before dispatching.
			setConfirmRemoveFor(server);
			return;
		}
		if (action === "test") {
			void runTest(server);
			return;
		}
		if (action === "reauth") {
			void runReauth(server);
			return;
		}
		const next = action === "reconnect" ? null : action === "enable";
		void mutation.run(server.name, next, () => tabRpc.mcpAction(server.name, action), t("extPanel.mcpActionFailed"));
	};

	const handleConfirmRemove = (): void => {
		const server = confirmRemoveFor;
		setConfirmRemoveFor(null);
		if (!server || !rpc.ready) return;
		// Drop any inline test/reauth state so nothing survives onto a re-add.
		dismissTest(server.name);
		delete reauthPhaseRef.current[server.name];
		void mutation.run(
			server.name,
			null,
			() => tabRpc.mcpAction(server.name, "remove", server.scope),
			t("extPanel.mcpActionFailed"),
		);
	};

	const addButton = (
		<Button
			disabled={!rpc.ready}
			icon={<Plus />}
			onClick={() => setWizardOpen(true)}
			size="sm"
			title={!rpc.ready ? t("extPanel.notConnected") : undefined}
		>
			{t("mcp.add")}
		</Button>
	);

	return (
		<>
			<BuiltinReaRow device={device} query={query} server={rpc.data?.find(server => server.builtin === "rea")} />
			<ListFrame
				actions={addButton}
				emptyAction={addButton}
				query={query}
				rpc={rpc}
				tabId="mcp"
				visible={visible.length}
			>
				<div className="divide-y divide-(--sc-divider) border-y border-(--sc-divider)">
					{visible.map(server => (
						<McpServerCard
							busy={mutation.busyKey === server.name}
							disabled={mutation.busyKey !== null || !rpc.ready}
							enabled={mutation.effective(server.name, server.enabled)}
							key={server.name}
							onDismissTest={() => dismissTest(server.name)}
							onMenuAction={action => handleMenuAction(server, action)}
							onReauthCancel={() => void runReauthCancel(server)}
							reauth={reauths[server.name] ?? null}
							server={server}
							testing={tests[server.name]?.testing ?? false}
							testView={tests[server.name]?.view ?? null}
						/>
					))}
				</div>
			</ListFrame>
			<McpServerWizard
				onAdded={() => {
					setWizardOpen(false);
					// Add triggers a reload — tool counts/auth come back with the refetch.
					void rpc.refresh();
				}}
				onClose={() => setWizardOpen(false)}
				open={wizardOpen}
			/>
			<ConfirmDialog
				confirmLabel={t("extPanel.action.remove")}
				message={confirmRemoveFor ? t("extPanel.mcp.removeConfirm", { name: confirmRemoveFor.name }) : ""}
				onCancel={() => setConfirmRemoveFor(null)}
				onConfirm={handleConfirmRemove}
				open={confirmRemoveFor !== null}
				title={t("extPanel.mcp.removeTitle")}
			/>
		</>
	);
}

// ---------------------------------------------------------------------------
// Commands tab (read-only: no slash-command management RPC exists)
// ---------------------------------------------------------------------------

function CommandRow({ command }: { command: AvailableCommand }) {
	return (
		<SettingsRow
			badge={
				<>
					{command.aliases && command.aliases.length > 0 && (
						<span className="font-mono text-sc-xs text-(--sc-text-muted)">
							{command.aliases.map(alias => `/${alias}`).join(", ")}
						</span>
					)}
					{command.input?.hint && (
						<code className="rounded-(--sc-radius-xs) bg-(--sc-surface-3) px-1.5 py-px font-mono text-sc-xs text-(--sc-text-secondary)">
							{command.input.hint}
						</code>
					)}
				</>
			}
			description={command.description ? <span className="line-clamp-2">{command.description}</span> : undefined}
			label={<span className="font-mono">/{command.name}</span>}
		/>
	);
}

function CommandsTab({ rpc, query }: { rpc: LazyRpc<AvailableCommand[]>; query: string }) {
	const t = useT();
	const { groups, visibleCount } = useMemo(() => {
		const visible = filterList(rpc.data, query, command => [
			command.name,
			command.description,
			command.source ?? "",
			...(command.aliases ?? []),
		]);
		return { groups: groupCommandsBySource(visible), visibleCount: visible.length };
	}, [rpc.data, query]);
	return (
		<ListFrame query={query} rpc={rpc} tabId="commands" visible={visibleCount}>
			<div className="flex flex-col gap-5">
				{groups.map(([source, commands]) => (
					<RowGroup
						count={commands.length}
						key={source}
						label={KNOWN_COMMAND_SOURCES[source] ? t(`extPanel.commands.source.${source}`) : source}
					>
						{commands.map(command => (
							<CommandRow command={command} key={`${source}:${command.name}`} />
						))}
					</RowGroup>
				))}
			</div>
		</ListFrame>
	);
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function ExtensionsSection({ tab, onTabChange, query }: ExtensionsSectionProps) {
	const t = useT();
	const hooks = useLazyRpc(tab === "hooks", fetchHooks, pickHooks);
	const contextFiles = useLazyRpc(tab === "contextFiles", fetchContextFiles, pickContextFiles);
	const mcp = useLazyRpc(tab === "mcp", fetchMcpServers, pickMcpServers);
	const commands = useLazyRpc(tab === "commands", fetchCommands, pickCommands);

	const tabs: TabItem[] = useMemo(
		() => [
			{ id: "skills", label: t("settings.skills.title") },
			{ id: "mcp", label: t("settings.extensions.mcp.title"), badge: mcp.data?.length },
			{ id: "hooks", label: t("extPanel.tabs.hooks"), badge: hooks.data?.length },
			{ id: "contextFiles", label: t("extPanel.tabs.contextFiles"), badge: contextFiles.data?.length },
			{ id: "commands", label: t("extPanel.tabs.commands"), badge: commands.data?.length },
		],
		[t, hooks.data, contextFiles.data, mcp.data, commands.data],
	);
	const activeLabel = tabs.find(item => item.id === tab)?.label;

	return (
		<div className="flex flex-col gap-4">
			{/* A narrow column wraps the tab row instead of widening the page. */}
			<Tabs
				activeId={tab}
				ariaLabel={t("extPanel.title")}
				className="flex-wrap"
				onChange={id => onTabChange(id as ExtensionsTab)}
				tabs={tabs}
			/>
			<div aria-label={activeLabel} role="tabpanel">
				{tab === "skills" && <SkillsTab query={query} />}
				{tab === "mcp" && <McpTab query={query} rpc={mcp} />}
				{tab === "hooks" && <HooksTab query={query} rpc={hooks} />}
				{tab === "contextFiles" && <ContextFilesTab query={query} rpc={contextFiles} />}
				{tab === "commands" && <CommandsTab query={query} rpc={commands} />}
			</div>
		</div>
	);
}
