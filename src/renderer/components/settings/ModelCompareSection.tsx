/**
 * Settings › Models › Compare: sortable/filterable matrix of every available
 * model across providers — auth status, context window, cost per 1M tokens,
 * provider quota, role assignments, and the current session model.
 *
 * Row click sets the session model (set_model); the per-row role picker assigns
 * the model to a role (set_model_role). Current model + role assignments are
 * highlighted; provider quota from get_usage renders inline per provider. The
 * live benchmark stays a dialog, opened through `onOpenBenchmark`.
 *
 * Catalog note: the model and provider columns come from the per-tab model
 * store, not a private copy. A `model_catalog_update` push and an opening read
 * race, and only the store's generation guard can tell which won; roles stay
 * local, usage is the tab's shared poll (hooks/use-usage-reports.ts).
 *
 * Wire note: `get_available_models` serializes full catalog `Model` objects —
 * `cost {input,output,cacheRead,cacheWrite}` ($/1M tokens),
 * `contextWindow` (number|null), `maxTokens` (number|null), `reasoning` — even
 * though these extended fields may be absent on older sidecars. Values are
 * read defensively below and degrade to "—" when unavailable.
 */

import { ArrowDown, ArrowUp, ArrowUpDown, Check, Gauge, RefreshCw, SearchX } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import type {
	ModelInfo,
	ModelRoleEntry,
	ModelRoleMetadata,
	ModelRolesResult,
	ProviderInfo,
	UsageLimit,
	UsageReport,
} from "../../../shared/rpc-types";
import { useUsage, useUsageRead } from "../../hooks/use-usage-reports";
import { cx, formatPricePerMillion, formatTokens } from "../../lib/format";
import { useLang, useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { usageLimitLabel } from "../../lib/usage-labels";
import { inUseReport, tightestLimit } from "../../lib/usage-reports";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { toast, toastError } from "../../stores/toast";
import {
	Badge,
	type BadgeVariant,
	Button,
	EmptyState,
	IconButton,
	InlineNotice,
	ProgressBar,
	SearchField,
	Select,
	SkeletonRows,
	Switch,
} from "../common";
import { modelRoleName } from "./schema-i18n";

// ============================================================================
// Derived row + helpers
// ============================================================================

const ROLE_BADGE: Record<string, BadgeVariant> = {
	success: "success",
	warning: "warning",
	accent: "accent",
	error: "error",
	info: "info",
	muted: "muted",
	dim: "muted",
	default: "default",
};

export interface Row {
	key: string;
	provider: string;
	providerName: string;
	id: string;
	name: string | null;
	/** False when get_providers failed or the provider isn't listed — auth shown as "?". */
	authKnown: boolean;
	authenticated: boolean;
	authKind: ProviderInfo["authKind"];
	disabled: boolean;
	contextWindow: number | null;
	costIn: number | null;
	costOut: number | null;
	roles: ModelRoleEntry[];
	quota: { limit: UsageLimit; fraction: number } | null;
}

function cmpNumber(a: number | null, b: number | null, dir: 1 | -1): number {
	if (a === null && b === null) return 0;
	if (a === null) return 1; // nulls always last, regardless of direction
	if (b === null) return -1;
	return (a - b) * dir;
}

/**
 * Joins the catalog snapshot with the role and usage feeds into table rows.
 * `roles`/`usage` may be null when their call failed — rows still render with
 * degraded role/quota cells rather than dropping models. A provider that is
 * absent from `providers` (or an empty list from a catalog generation that
 * carried none) renders auth as "?", never as "no auth".
 */
export function buildModelRows(input: {
	models: ModelInfo[];
	providers: ProviderInfo[];
	roles: ModelRoleEntry[] | null;
	usage: UsageReport[] | null;
}): Row[] {
	const providerById = new Map(input.providers.map(provider => [provider.id, provider]));
	return input.models.map(model => {
		const key = `${model.provider}/${model.id}`;
		const provider = providerById.get(model.provider);
		// The account this tab's session uses: with two sign-ins, the last report was not it.
		const report = inUseReport(input.usage ?? [], model.provider);
		return {
			key,
			provider: model.provider,
			providerName: provider?.name ?? model.provider,
			id: model.id,
			name: typeof model.name === "string" && model.name.length > 0 && model.name !== model.id ? model.name : null,
			authKnown: provider !== undefined,
			authenticated: provider?.authenticated ?? false,
			authKind: provider?.authKind,
			disabled: provider?.disabled ?? false,
			contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : null,
			costIn: typeof model.cost?.input === "number" ? model.cost.input : null,
			costOut: typeof model.cost?.output === "number" ? model.cost.output : null,
			roles: input.roles?.filter(role => role.model === key) ?? [],
			quota: report ? tightestLimit(report) : null,
		};
	});
}

type SortKey = "provider" | "model" | "context" | "cost" | "roles";

export type UnusableReason = "disabled" | "no-auth";

/**
 * Why a row cannot be made the session model. Auth that the catalog simply did
 * not describe is *not* a reason: a degraded `get_providers` read is not
 * evidence of no access, and treating it as one would lock the whole matrix.
 */
export function unusableReason(row: Row): UnusableReason | null {
	if (row.disabled) return "disabled";
	if (row.authKnown && !row.authenticated) return "no-auth";
	return null;
}

const COMPARATORS: Record<SortKey, (a: Row, b: Row, dir: 1 | -1) => number> = {
	provider: (a, b, dir) =>
		a.providerName.localeCompare(b.providerName) * dir || (a.name ?? a.id).localeCompare(b.name ?? b.id),
	model: (a, b, dir) => (a.name ?? a.id).localeCompare(b.name ?? b.id) * dir || a.provider.localeCompare(b.provider),
	context: (a, b, dir) => cmpNumber(a.contextWindow, b.contextWindow, dir),
	cost: (a, b, dir) => cmpNumber(a.costIn, b.costIn, dir) || cmpNumber(a.costOut, b.costOut, dir),
	roles: (a, b, dir) => cmpNumber(a.roles.length, b.roles.length, dir),
};

type TFn = (key: string, params?: Record<string, string | number>) => string;

/** Separate borders: a collapsed border would scroll away under the sticky header. */
const CELL = "border-b border-(--sc-divider) px-3 py-2";

// ============================================================================
// Presentational pieces
// ============================================================================

function SortHeader({
	label,
	sortKey,
	sort,
	onSort,
	align = "left",
}: {
	label: string;
	sortKey: SortKey;
	sort: { key: SortKey; dir: 1 | -1 };
	onSort: (key: SortKey) => void;
	align?: "left" | "right";
}) {
	const active = sort.key === sortKey;
	const Icon = active ? (sort.dir === 1 ? ArrowUp : ArrowDown) : ArrowUpDown;
	return (
		<th
			aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
			className={cx(CELL, "font-medium whitespace-nowrap", align === "right" && "text-right")}
			scope="col"
		>
			<button
				className={cx(
					"inline-flex items-center gap-1 rounded-(--sc-radius-xs) text-sc-xs transition-colors duration-(--sc-duration-instant)",
					active ? "text-(--sc-text)" : "text-(--sc-text-muted) hover:text-(--sc-text)",
				)}
				onClick={() => onSort(sortKey)}
				type="button"
			>
				{label}
				<Icon aria-hidden className={cx("size-3 shrink-0", !active && "opacity-50")} />
			</button>
		</th>
	);
}

function AuthBadge({ row, t }: { row: Row; t: TFn }) {
	if (!row.authKnown) return <Badge variant="muted">?</Badge>;
	if (!row.authenticated) return <Badge variant="muted">{t("providers.badge.noAuth")}</Badge>;
	if (row.authKind === "oauth")
		return (
			<Badge dot variant="success">
				{t("providers.badge.oauth")}
			</Badge>
		);
	if (row.authKind === "env") return <Badge variant="info">{t("providers.badge.env")}</Badge>;
	return (
		<Badge dot variant="success">
			{t("providers.badge.apikey")}
		</Badge>
	);
}

// ============================================================================
// Section
// ============================================================================

export function ModelCompareSection({ onOpenBenchmark }: { onOpenBenchmark: () => void }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const { lang } = useLang();
	const authOnlyId = useId();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const current = useModelStore(s => s.model);
	const models = useModelStore(s => s.availableModels);
	const providers = useModelStore(s => s.providers);
	const refreshProviders = useModelStore(s => s.refreshProviders);

	const [roles, setRoles] = useState<ModelRoleEntry[] | null>(null);
	const [roleMeta, setRoleMeta] = useState<ModelRoleMetadata[] | null>(null);
	// The quota column reads through the tab's one usage poll (hooks/use-usage-reports.ts).
	const { reports: usage, error: usageError } = useUsage(feed => feed);
	const readUsage = useUsageRead();
	const [loading, setLoading] = useState(false);
	const [fatalError, setFatalError] = useState<string | null>(null);
	const [failedSections, setFailedSections] = useState<string[]>([]);
	const [query, setQuery] = useState("");
	const [providerFilter, setProviderFilter] = useState("all");
	const [authOnly, setAuthOnly] = useState(false);
	const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "provider", dir: 1 });
	const [busyKey, setBusyKey] = useState<string | null>(null);

	const load = useCallback(async () => {
		setFatalError(null);
		setFailedSections([]);
		// Disconnected is shown as its own banner; the catalog the store already
		// holds stays on screen with every commit locked.
		if (!sidecarReady) return;
		setLoading(true);
		// One forced read for both catalog columns: models and providers must come
		// from the same generation, and a non-forced one is satisfied by a
		// still-fresh cache row after a credential or models.yml change.
		const [catalogR, rolesR, metaR] = await Promise.allSettled([
			refreshProviders(true),
			tabRpc.getModelRoles(),
			tabRpc.getModelRoleMetadata(),
		]);
		const failed: string[] = [];

		if (catalogR.status === "rejected") {
			setFatalError(
				catalogR.reason instanceof Error
					? catalogR.reason.message
					: String(catalogR.reason ?? t("modelCompare.unknownError")),
			);
		}

		if (rolesR.status === "fulfilled" && rolesR.value.success) {
			setRoles((rolesR.value.data as ModelRolesResult | undefined)?.roles ?? []);
		} else {
			setRoles(null);
			failed.push(t("modelCompare.col.roles"));
		}

		if (metaR.status === "fulfilled" && metaR.value.success) {
			setRoleMeta((metaR.value.data as { roles?: ModelRoleMetadata[] } | undefined)?.roles ?? []);
		} else {
			setRoleMeta(null);
		}

		setFailedSections(failed);
		setLoading(false);
	}, [sidecarReady, t, refreshProviders, tabRpc.getModelRoles, tabRpc.getModelRoleMetadata]);

	// Mount and every sidecar (re)connect re-read.
	useEffect(() => {
		void load();
	}, [load]);

	const reloadRoles = useCallback(async () => {
		if (!sidecarReady) return;
		try {
			const res = await tabRpc.getModelRoles();
			if (res.success) setRoles((res.data as ModelRolesResult | undefined)?.roles ?? []);
		} catch {
			/* keep stale role list; the next full load retries */
		}
	}, [sidecarReady, tabRpc.getModelRoles]);

	/** The buttons' full re-read: the catalog, the roles and, outside its poll, the tab's usage. */
	const reload = () => {
		void load();
		if (sidecarReady) void readUsage();
	};
	const failed = usageError === null ? failedSections : [...failedSections, t("modelCompare.col.quota")];

	const metaById = useMemo(() => new Map((roleMeta ?? []).map(m => [m.id, m])), [roleMeta]);

	const rows = useMemo<Row[]>(
		() => buildModelRows({ models, providers, roles, usage }),
		[models, providers, roles, usage],
	);

	const providerOptions = useMemo(() => {
		const nameById = new Map<string, string>();
		for (const row of rows) if (!nameById.has(row.provider)) nameById.set(row.provider, row.providerName);
		return [
			{ value: "all", label: t("modelCompare.allProviders") },
			...[...nameById.entries()]
				.sort(([, a], [, b]) => a.localeCompare(b))
				.map(([value, label]) => ({ value, label })),
		];
	}, [rows, t]);

	const visibleRows = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = rows.filter(row => {
			if (authOnly && row.authKnown && !row.authenticated) return false;
			if (providerFilter !== "all" && row.provider !== providerFilter) return false;
			if (
				q.length > 0 &&
				!(
					row.id.toLowerCase().includes(q) ||
					row.provider.toLowerCase().includes(q) ||
					row.providerName.toLowerCase().includes(q) ||
					row.name?.toLowerCase().includes(q)
				)
			) {
				return false;
			}
			return true;
		});
		const dir = sort.dir;
		return [...filtered].sort((a, b) => COMPARATORS[sort.key](a, b, dir));
	}, [rows, query, authOnly, providerFilter, sort]);

	const isCurrent = useCallback(
		(row: Row) => current !== null && current.provider === row.provider && current.id === row.id,
		[current],
	);

	const handleSort = useCallback((key: SortKey) => {
		setSort(prev => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
	}, []);

	const assignSession = useCallback(
		async (row: Row) => {
			// The unusable check belongs here rather than only on the controls: the
			// whole row is a click target, so a disabled "Use" button alone would not
			// keep an off or signed-out provider from becoming the session model.
			if (!sidecarReady || busyKey !== null || isCurrent(row) || unusableReason(row) !== null) return;
			setBusyKey(row.key);
			const model = row.name ?? row.key;
			try {
				const res = await tabRpc.setModel(row.provider, row.id);
				if (res.success) {
					toast({ variant: "success", message: t("modelCompare.setSuccess", { model }) });
				} else {
					toastError({ title: t("modelCompare.setFailed"), error: res });
				}
			} catch (cause) {
				toastError({ title: t("modelCompare.setFailed"), error: cause });
			} finally {
				setBusyKey(null);
			}
		},
		[busyKey, isCurrent, sidecarReady, t, tabRpc.setModel],
	);

	const roleName = useCallback(
		(roleId: string): string => metaById.get(roleId)?.name ?? roles?.find(r => r.id === roleId)?.name ?? roleId,
		[metaById, roles],
	);

	const assignRole = useCallback(
		async (row: Row, roleId: string) => {
			const currentRoleId = row.roles[0]?.id ?? "";
			if (!sidecarReady || roleId === currentRoleId || busyKey !== null) return;
			setBusyKey(row.key);
			const model = row.name ?? row.key;
			try {
				const res = roleId
					? await tabRpc.setModelRole(roleId, row.key)
					: await tabRpc.setModelRole(currentRoleId, null);
				if (res.success) {
					toast({
						variant: "success",
						message: roleId
							? t("modelCompare.roleSet", { role: roleName(roleId), model })
							: t("modelCompare.roleCleared", { role: roleName(currentRoleId) }),
					});
					await reloadRoles();
				} else {
					toastError({ title: t("modelCompare.roleFailed"), error: res });
				}
			} catch (cause) {
				toastError({ title: t("modelCompare.roleFailed"), error: cause });
			} finally {
				setBusyKey(null);
			}
		},
		[busyKey, reloadRoles, roleName, sidecarReady, t, tabRpc.setModelRole],
	);

	/** Roles offered in the per-row picker: non-hidden, plus any hidden role already on this row (so it can be cleared). */
	const roleOptions = useCallback(
		(row: Row) => [
			{ value: "", label: t("modelCompare.noRole") },
			...(roles ?? [])
				.filter(role => !metaById.get(role.id)?.hidden || row.roles.some(r => r.id === role.id))
				.map(role => ({ value: role.id, label: roleName(role.id) })),
		],
		[roles, metaById, roleName, t],
	);

	const clearFilters = () => {
		setQuery("");
		setProviderFilter("all");
		setAuthOnly(false);
	};

	let body: ReactNode;
	if (fatalError !== null && rows.length === 0) {
		body = null; // the danger banner above says what failed and offers the retry
	} else if (loading && rows.length === 0) {
		body = <SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />;
	} else if (rows.length === 0) {
		body = sidecarReady ? <EmptyState size="sm" title={t("modelCompare.emptyCatalog")} /> : null;
	} else if (visibleRows.length === 0) {
		body = (
			<EmptyState
				actions={
					<Button onClick={clearFilters} size="sm">
						{t("modelCompare.clearFilters")}
					</Button>
				}
				icon={<SearchX />}
				size="sm"
				title={t("modelCompare.empty")}
			/>
		);
	} else {
		body = (
			// Wide matrix: scrolls both ways inside the section instead of pushing
			// the page wider than a 900px window.
			<div className="max-h-[70vh] overflow-auto rounded-(--sc-radius-lg) border border-(--sc-border-subtle)">
				<table className="w-full min-w-[42rem] border-separate border-spacing-0 text-left text-sc-md">
					<thead className="sticky top-0 z-(--sc-z-raised) bg-(--sc-surface-1)">
						<tr>
							<SortHeader
								label={t("modelCompare.col.provider")}
								onSort={handleSort}
								sort={sort}
								sortKey="provider"
							/>
							<SortHeader label={t("modelCompare.col.model")} onSort={handleSort} sort={sort} sortKey="model" />
							<SortHeader
								align="right"
								label={t("modelCompare.col.context")}
								onSort={handleSort}
								sort={sort}
								sortKey="context"
							/>
							<SortHeader
								align="right"
								label={t("modelCompare.col.cost")}
								onSort={handleSort}
								sort={sort}
								sortKey="cost"
							/>
							<SortHeader label={t("modelCompare.col.roles")} onSort={handleSort} sort={sort} sortKey="roles" />
							<th
								className={cx(
									CELL,
									"text-right text-sc-xs font-medium whitespace-nowrap text-(--sc-text-muted)",
								)}
								scope="col"
							>
								{t("modelCompare.col.actions")}
							</th>
						</tr>
					</thead>
					<tbody className="[&>tr:last-child>td]:border-b-0">
						{visibleRows.map(row => {
							const active = isCurrent(row);
							const busy = busyKey === row.key;
							const blocked = active ? null : unusableReason(row);
							return (
								<tr
									aria-current={active ? "true" : undefined}
									className={cx(
										"transition-colors duration-(--sc-duration-instant)",
										blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-(--sc-hover)",
										active && "bg-(--sc-selected)",
									)}
									key={row.key}
									onClick={() => void assignSession(row)}
									title={
										blocked
											? t(
													blocked === "disabled"
														? "modelCompare.blockedDisabled"
														: "modelCompare.blockedNoAuth",
												)
											: t("modelCompare.useHint")
									}
								>
									<td
										className={cx(
											CELL,
											"border-l-2",
											active ? "border-l-(--sc-accent)" : "border-l-transparent",
										)}
									>
										<div className="flex min-w-0 flex-col gap-1">
											<span className="font-medium whitespace-nowrap text-(--sc-text)">
												{row.providerName}
											</span>
											<div className="flex items-center gap-1.5">
												<AuthBadge row={row} t={t} />
												{row.disabled && <Badge variant="warning">{t("providers.badge.disabled")}</Badge>}
											</div>
											{row.quota && (
												<span
													className="block w-20"
													title={`${t("modelCompare.col.quota")}: ${usageLimitLabel(row.quota.limit, t)}`}
												>
													<ProgressBar
														ariaLabel={`${t("modelCompare.col.quota")}: ${usageLimitLabel(row.quota.limit, t)}`}
														height={3}
														value={row.quota.fraction}
														valueText=""
													/>
												</span>
											)}
										</div>
									</td>
									<td className={cx(CELL, "max-w-[16rem]")}>
										<div className="flex min-w-0 flex-col">
											<div className="flex min-w-0 items-center gap-1.5">
												<span className="truncate font-medium text-(--sc-text)">{row.name ?? row.id}</span>
												{active && (
													<Badge dot variant="accent">
														{t("modelCompare.current")}
													</Badge>
												)}
											</div>
											{row.name && (
												<span className="truncate font-mono text-sc-xs text-(--sc-text-muted)">
													{row.id}
												</span>
											)}
										</div>
									</td>
									<td className={cx(CELL, "text-right whitespace-nowrap tabular-nums")}>
										{row.contextWindow !== null ? (
											<span className="text-(--sc-text)">{formatTokens(row.contextWindow)}</span>
										) : (
											<span className="text-(--sc-text-subtle)">—</span>
										)}
									</td>
									<td className={cx(CELL, "text-right whitespace-nowrap tabular-nums")}>
										{row.costIn !== null && row.costOut !== null ? (
											row.costIn === 0 && row.costOut === 0 ? (
												<span className="text-(--sc-success)">{t("modelCompare.free")}</span>
											) : (
												<span className="text-(--sc-text)">
													{formatPricePerMillion(row.costIn)}
													<span className="text-(--sc-text-subtle)"> / </span>
													{formatPricePerMillion(row.costOut)}
												</span>
											)
										) : (
											<span className="text-(--sc-text-subtle)">—</span>
										)}
									</td>
									<td className={CELL}>
										<div className="flex flex-wrap items-center gap-1">
											{row.roles.map(role => {
												const meta = metaById.get(role.id);
												return (
													<span key={role.id} title={modelRoleName(lang, meta?.name ?? role.name)}>
														<Badge
															variant={ROLE_BADGE[meta?.color ?? role.color ?? "default"] ?? "default"}
														>
															{meta?.tag ?? role.tag ?? role.name}
														</Badge>
													</span>
												);
											})}
											{row.roles.length === 0 && <span className="text-(--sc-text-subtle)">—</span>}
										</div>
									</td>
									<td className={CELL} onClick={event => event.stopPropagation()}>
										<div className="flex items-center justify-end gap-1.5">
											<Select
												aria-label={t("modelCompare.assignRole")}
												className="max-w-[8rem]"
												controlSize="sm"
												disabled={busy || roles === null || !sidecarReady}
												onChange={event => void assignRole(row, event.target.value)}
												options={roleOptions(row)}
												title={!sidecarReady ? t("modelCompare.notConnected") : undefined}
												value={row.roles[0]?.id ?? ""}
											/>
											{active ? (
												<span
													className="flex size-(--sc-control-sm) items-center justify-center text-(--sc-accent)"
													title={t("modelCompare.current")}
												>
													<Check aria-hidden className="size-(--sc-icon-sm)" />
												</span>
											) : (
												<Button
													disabled={!sidecarReady || busyKey !== null || blocked !== null}
													loading={busy}
													onClick={() => void assignSession(row)}
													size="sm"
													title={!sidecarReady ? t("modelCompare.notConnected") : undefined}
													variant="ghost"
												>
													{t("modelCompare.use")}
												</Button>
											)}
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-col gap-3 pt-1">
			{!sidecarReady && (
				<InlineNotice
					title={`${t("modelCompare.notConnected")}. ${t("modelCompare.notConnectedHint")}`}
					tone="info"
				/>
			)}
			{fatalError !== null && (
				<InlineNotice
					action={
						<Button icon={<RefreshCw />} onClick={reload} size="sm" variant="ghost">
							{t("common.retry")}
						</Button>
					}
					detail={fatalError}
					live
					title={t("modelCompare.modelsFailed")}
					tone="danger"
				/>
			)}
			{failed.length > 0 && (
				<InlineNotice
					action={
						<Button icon={<RefreshCw />} onClick={reload} size="sm" variant="ghost">
							{t("common.retry")}
						</Button>
					}
					title={t("modelCompare.partialWarning", { what: failed.join(", ") })}
					tone="warning"
				/>
			)}

			<div className="flex flex-wrap items-center gap-2">
				{rows.length > 0 && (
					<>
						<div className="min-w-[12rem] flex-1">
							<SearchField
								controlSize="sm"
								label={t("modelCompare.search")}
								onValueChange={setQuery}
								placeholder={t("modelCompare.search")}
								value={query}
							/>
						</div>
						<Select
							aria-label={t("modelCompare.providerFilter")}
							controlSize="sm"
							onChange={event => setProviderFilter(event.target.value)}
							options={providerOptions}
							value={providerFilter}
						/>
						<label
							className="flex h-(--sc-control-sm) cursor-pointer items-center gap-2 text-sc-sm whitespace-nowrap text-(--sc-text-secondary)"
							htmlFor={authOnlyId}
						>
							<Switch checked={authOnly} id={authOnlyId} onCheckedChange={setAuthOnly} />
							{t("modelCompare.authOnly")}
						</label>
					</>
				)}
				<div className="ml-auto flex items-center gap-2">
					{rows.length > 0 && (
						<span className="text-sc-xs whitespace-nowrap text-(--sc-text-muted) tabular-nums">
							{t("modelCompare.count", { shown: visibleRows.length, total: rows.length })}
						</span>
					)}
					<IconButton
						disabled={!sidecarReady}
						icon={<RefreshCw />}
						label={t("common.refresh")}
						loading={loading}
						onClick={reload}
						size="sm"
					/>
					<Button icon={<Gauge />} onClick={onOpenBenchmark} size="sm" variant="secondary">
						{t("modelCompare.runBenchmark")}
					</Button>
				</div>
			</div>

			{body}
		</div>
	);
}
