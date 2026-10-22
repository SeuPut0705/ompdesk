/**
 * Model setup assistant. Two modes over one live proposal, planned in the renderer by `planRoles` (no model call):
 * full auto (subscription and free models only) opens straight onto its proposal; picked mode lets the person tick
 * the models first (metered ones included). One line per role from `get_model_roles`; its reason sits behind ⓘ.
 * Apply writes only the ticked rows and stores what it wrote (for Undo) with the signature "new models or
 * accounts since" is judged against. "Find more evidence" is the one action that spends tokens: it shows its cost
 * first, then runs the research on the focused tab's machine and lays its picks over the rules' rows.
 */

import { ExternalLink, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROLE_GROUPS, roleGroup } from "../../../../../resources/gui-bridge/model-role-contracts";
import type { ModelSetupFacts } from "../../../../../resources/gui-bridge/model-setup-contracts";
import { MODEL_SETUP_TIMEOUT_MS, type ModelSetupActivity, type ModelSetupPlan } from "../../../../shared/model-setup";
import { type PlanMode, planRoles, setupSignature } from "../../../../shared/role-plan";
import type { ModelRoleEntry, ModelRolesResult } from "../../../../shared/rpc-types";
import { useUsageReports } from "../../../hooks/use-usage-reports";
import { errorDetail, type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { cx, formatUsd } from "../../../lib/format";
import { useLang, useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useModelStore } from "../../../stores/model";
import { useFocusedTabDevice } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { toast } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Badge, Button, ErrorDetail, InlineNotice, Modal, SearchField, SettingInfo, Spinner, Tabs } from "../../common";
import { modelRoleName } from "../schema-i18n";
import {
	currentDefaultModel,
	distinctModels,
	groupByProvider,
	loadSetupRecord,
	mergeApplied,
	type ProposalRow,
	parseSetupFacts,
	planRoleInputs,
	RESEARCH_MINUTES,
	reasonText,
	researchEstimate,
	researchPool,
	researchRequest,
	type SetupModelOption,
	type SetupRecord,
	saveSetupRecord,
	setupModelOptions,
	usageHeadroom,
	withResearch,
	writable,
} from "./model-setup-logic";

interface SetupData {
	roles: ModelRoleEntry[];
	facts: ModelSetupFacts;
}

/** What a finished research run leaves: its plan (laid over the rules' rows) and what it dropped. */
interface Evidence {
	plan: ModelSetupPlan;
	dropped: string[];
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ModelSetupDialog() {
	const t = useT();
	const { lang } = useLang();
	const tabRpc = useTabRpc();
	// The research runs where the focused tab's omp does; status and cancel go to the same machine.
	const device = useFocusedTabDevice();
	const runDevice = useRef<string | undefined>(undefined);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const activeModel = useModelStore(state => state.model);
	const providers = useModelStore(state => state.providers);
	const reports = useUsageReports();

	const [data, setData] = useState<SetupData | null>(null);
	const [record, setRecord] = useState<SetupRecord | undefined>();
	const [loadError, setLoadError] = useState<string | null>(null);
	const [mode, setMode] = useState<PlanMode>("full");
	// Undefined until the person touches the checklist: it then follows the full-auto plan's models.
	const [picked, setPicked] = useState<string[] | undefined>();
	const [query, setQuery] = useState("");
	const [ticks, setTicks] = useState<Record<string, boolean>>({});
	const [applying, setApplying] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [running, setRunning] = useState(false);
	const [startedAt, setStartedAt] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const [activity, setActivity] = useState<ModelSetupActivity | undefined>();
	const [runError, setRunError] = useState<(InlineFailure & { reply?: string }) | null>(null);
	const [evidence, setEvidence] = useState<Evidence | null>(null);

	// One parallel read: the roles (their candidates are the connected accounts' models), the facts (billing,
	// scores, prices) and this machine's apply record. `current` says whether its answer is still wanted.
	const loadSetup = useCallback(
		async (current: () => boolean) => {
			try {
				const [rolesRes, factsRes, stored] = await Promise.all([
					tabRpc.getModelRoles(),
					tabRpc.getModelSetupFacts(),
					loadSetupRecord(device).catch(() => undefined),
				]);
				if (!current()) return;
				if (!rolesRes.success) {
					setLoadError(errorDetail(rolesRes));
					return;
				}
				if (!factsRes.success) {
					setLoadError(errorDetail(factsRes));
					return;
				}
				const facts = parseSetupFacts(factsRes.data);
				if (!facts) {
					setLoadError(t("modelSetup.loadFailed"));
					return;
				}
				setLoadError(null);
				setData({ roles: (rolesRes.data as ModelRolesResult).roles, facts });
				setRecord(stored);
			} catch (cause) {
				if (current()) setLoadError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[device, t, tabRpc],
	);
	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		void loadSetup(() => !cancelled);
		return () => {
			cancelled = true;
		};
	}, [loadSetup, sidecarReady]);

	// Progress: the clock every second, and the run's latest tool call from its machine.
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => {
			setNow(Date.now());
			void window.omp.modelSetup
				.status(runDevice.current)
				.then(status => {
					if (status.activity) setActivity(status.activity);
				})
				.catch(() => {});
		}, 1_000);
		return () => clearInterval(timer);
	}, [running]);

	const roles = data?.roles;
	const facts = data?.facts;
	const options = useMemo(() => (roles && facts ? setupModelOptions(roles, facts) : []), [roles, facts]);
	const defaultModel = useMemo(
		() => (roles ? currentDefaultModel(roles, options, activeModel) : undefined),
		[roles, options, activeModel],
	);
	const roleInputs = useMemo(() => (roles ? planRoleInputs(roles) : []), [roles]);
	const headroom = useMemo(() => usageHeadroom(reports, Date.now()), [reports]);
	const lastApplied = record?.applied?.values;
	const planInput = useMemo(
		() => (facts ? { roles: roleInputs, facts, defaultModel, headroom, lastApplied } : undefined),
		[roleInputs, facts, defaultModel, headroom, lastApplied],
	);
	const fullRows = useMemo(() => (planInput ? planRoles({ ...planInput, mode: "full" }) : []), [planInput]);
	const pickedModels = useMemo(() => picked ?? distinctModels(fullRows), [picked, fullRows]);
	const ruleRows = useMemo(
		() => (planInput && mode === "picked" ? planRoles({ ...planInput, mode, picked: pickedModels }) : fullRows),
		[planInput, mode, pickedModels, fullRows],
	);
	const pool = useMemo(
		() => (facts ? researchPool(options, facts, mode, pickedModels) : []),
		[options, facts, mode, pickedModels],
	);
	const rows = useMemo(
		() => withResearch(ruleRows, evidence?.plan, new Set(pool), roleInputs),
		[ruleRows, evidence, pool, roleInputs],
	);
	const groups = useMemo(() => groupByProvider(options), [options]);
	const researchModel = ruleRows.find(row => row.role === "default")?.model ?? defaultModel;

	const providerName = (id: string) => providers.find(provider => provider.id === id)?.name ?? id;
	const labelOf = (selector: string | undefined) =>
		selector ? facts?.models[selector]?.name || options.find(o => o.selector === selector)?.label || selector : "";
	const isTicked = (row: ProposalRow) => writable(row) && (ticks[row.role] ?? row.checked);

	const changeMode = (next: string) => {
		setMode(next === "picked" ? "picked" : "full");
		setTicks({});
	};
	const togglePicked = (selector: string, checked: boolean) => {
		setPicked(current => {
			const base = current ?? pickedModels;
			return checked
				? [...base.filter(value => value !== selector), selector]
				: base.filter(value => value !== selector);
		});
		setTicks({});
	};

	const close = () => {
		if (running) void window.omp.modelSetup.abort(runDevice.current).catch(() => false);
		useUiStore.getState().closeModelSetup();
	};

	const research = async () => {
		if (!facts || !roles || !researchModel) return;
		const request = researchRequest({
			researchModel,
			...(defaultModel ? { defaultModel } : {}),
			pool,
			facts,
			roles,
			rows: ruleRows,
			language: lang === "ko" ? "Korean" : "English",
		});
		runDevice.current = device;
		setConfirmOpen(false);
		setRunError(null);
		setActivity(undefined);
		setStartedAt(Date.now());
		setNow(Date.now());
		setRunning(true);
		try {
			const result = await window.omp.modelSetup.run(request, device);
			if (result.success) {
				setEvidence({ plan: result.plan, dropped: result.dropped });
				setTicks({});
			} else if (!result.cancelled) {
				setRunError({ ...inlineFailure(result, t("modelSetup.research.failed")), reply: result.reply });
			}
		} catch (cause) {
			setRunError(inlineFailure(cause, t("modelSetup.research.failed")));
		} finally {
			setRunning(false);
		}
	};

	const cancel = () => {
		void window.omp.modelSetup.abort(runDevice.current).catch(() => false);
	};

	const apply = async () => {
		if (!data) return;
		setApplying(true);
		const writes = rows.flatMap(row =>
			row.model !== null && isTicked(row) ? [{ role: row.role, model: row.model }] : [],
		);
		const signature = setupSignature(roleInputs, data.facts);
		const previous = record;
		if (writes.length === 0) {
			// Nothing to write: the person has seen this setup, so "new models or accounts" starts from now.
			await saveSetupRecord(device, {
				...(previous?.applied ? { applied: previous.applied } : {}),
				signature,
			}).catch(() => {});
			setApplying(false);
			toast({ variant: "info", message: t("modelSetup.apply.nothing") });
			useUiStore.getState().closeModelSetup();
			return;
		}
		const at = Date.now();
		await saveSetupRecord(device, {
			applied: mergeApplied(previous?.applied, data.roles, writes, at),
			signature,
		}).catch(() => {});
		const failures: Array<{ role: string; error: unknown }> = [];
		for (const write of writes) {
			try {
				const res = await tabRpc.setModelRole(write.role, write.model);
				if (!res.success) failures.push({ role: write.role, error: res });
			} catch (error) {
				failures.push({ role: write.role, error });
			}
		}
		if (failures.length > 0) {
			const written = writes.filter(write => !failures.some(failure => failure.role === write.role));
			await saveSetupRecord(
				device,
				written.length > 0
					? { applied: mergeApplied(previous?.applied, data.roles, written, at), signature }
					: previous,
			).catch(() => {});
			setApplying(false);
			toast({
				variant: "error",
				title: t("modelSetup.apply.failedTitle"),
				message: t("modelSetup.apply.partial", { count: written.length, failed: failures.length }),
				detail: failures.map(failure => `${failure.role}: ${errorDetail(failure.error)}`).join("\n"),
			});
			// What the roles hold now differs from what was planned: read them again.
			setTicks({});
			void loadSetup(() => true);
			return;
		}
		setApplying(false);
		toast({ variant: "success", message: t("modelSetup.apply.done", { count: writes.length }) });
		useUiStore.getState().closeModelSetup();
	};

	const visibleGroups = groups
		.map(group => ({
			...group,
			models: group.models.filter(option =>
				query.trim()
					? `${option.label} ${option.selector}`.toLowerCase().includes(query.trim().toLowerCase())
					: true,
			),
		}))
		.filter(group => group.models.length > 0);
	const rowGroups = ROLE_GROUPS.map(group => ({
		id: group.id,
		rows: rows.filter(
			row => roleGroup(row.role, roles?.find(role => role.id === row.role)?.section ?? "chat") === group.id,
		),
	})).filter(group => group.rows.length > 0);
	const canResearch = sidecarReady && data !== null && researchModel !== undefined && pool.length > 0 && !running;
	const estimate = facts && researchModel ? researchEstimate(facts, researchModel) : undefined;

	const footer = running ? (
		<Button onClick={cancel} variant="danger">
			{t("modelSetup.research.cancel")}
		</Button>
	) : (
		<>
			<Button
				aria-expanded={confirmOpen}
				className="mr-auto"
				disabled={!canResearch}
				icon={<Search />}
				onClick={() => setConfirmOpen(open => !open)}
				variant="ghost"
			>
				{t("modelSetup.evidence.open")}
			</Button>
			<Button onClick={close} variant="secondary">
				{t("common.cancel")}
			</Button>
			<Button
				disabled={!sidecarReady || data === null || applying}
				loading={applying}
				onClick={() => void apply()}
				variant="primary"
			>
				{t("modelSetup.review.apply")}
			</Button>
		</>
	);

	return (
		<Modal footer={footer} onClose={close} open size="lg" title={t("modelSetup.title")}>
			<div className="space-y-4" data-model-setup-mode={mode}>
				{!sidecarReady && <InlineNotice title={t("modelSetup.notConnected")} tone="info" />}
				{loadError !== null && <InlineNotice detail={loadError} title={t("modelSetup.loadFailed")} tone="danger" />}

				{data === null && sidecarReady && loadError === null && (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				)}

				{data !== null && (
					<>
						<div className="flex items-center gap-5 [--hit-gap-x:20px]">
							<Tabs
								ariaLabel={t("modelSetup.mode.label")}
								onChange={changeMode}
								tabs={[
									{ id: "full", label: t("modelSetup.mode.full") },
									{ id: "picked", label: t("modelSetup.mode.picked") },
								]}
								activeId={mode}
								compact
								variant="segmented"
							/>
							<SettingInfo
								text={t(mode === "full" ? "modelSetup.mode.fullInfo" : "modelSetup.mode.pickedInfo")}
							/>
						</div>

						{mode === "picked" &&
							(options.length === 0 ? (
								<InlineNotice title={t("modelSetup.pick.none")} tone="warning" />
							) : (
								<div className="space-y-2">
									<div className="flex items-center gap-3">
										<SearchField
											className="min-w-0 flex-1"
											label={t("modelSetup.pick.filter")}
											onValueChange={setQuery}
											placeholder={t("modelSetup.pick.filter")}
											value={query}
										/>
										<span
											className="shrink-0 text-sc-sm tabular-nums text-(--sc-text-muted)"
											data-model-setup-count
										>
											{t("modelSetup.pick.count", { count: pickedModels.length })}
										</span>
									</div>
									<div className="max-h-56 space-y-3 overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-3">
										{visibleGroups.map(group => (
											<fieldset className="space-y-1" key={group.provider}>
												<legend className="pb-1 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
													{providerName(group.provider)}
												</legend>
												{group.models.map(option => (
													<ModelCheckbox
														checked={pickedModels.includes(option.selector)}
														disabled={running}
														isDefault={option.selector === defaultModel}
														key={option.selector}
														onChange={checked => togglePicked(option.selector, checked)}
														option={option}
													/>
												))}
											</fieldset>
										))}
									</div>
								</div>
							))}

						{confirmOpen && researchModel && estimate && (
							<div
								className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-3 py-2 text-sc-sm text-(--sc-text-secondary)"
								data-model-setup-confirm
								role="group"
							>
								<span className="min-w-0 flex-1">
									{t("modelSetup.evidence.confirm", {
										model: labelOf(researchModel),
										cost:
											estimate.billing === "subscription"
												? t("modelSetup.evidence.costSubscription")
												: estimate.billing === "free"
													? t("modelSetup.evidence.costFree")
													: estimate.usd !== undefined
														? t("modelSetup.evidence.costBilled", { usd: formatUsd(estimate.usd) })
														: t("modelSetup.evidence.costBilledUnknown"),
										minutes: RESEARCH_MINUTES,
									})}
								</span>
								<Button onClick={() => void research()} size="sm" variant="primary">
									{t("modelSetup.evidence.run")}
								</Button>
							</div>
						)}

						{running && (
							<div className="space-y-2" role="status">
								<div className="flex items-center gap-3">
									<Spinner />
									<div className="min-w-0">
										<p className="truncate text-sc-md font-medium text-(--sc-text)">
											{t("modelSetup.research.running", { model: labelOf(researchModel) })}
										</p>
										<p className="text-sc-sm tabular-nums text-(--sc-text-muted)">
											{t("modelSetup.research.elapsed", {
												elapsed: formatElapsed(now - startedAt),
												limit: formatElapsed(MODEL_SETUP_TIMEOUT_MS),
											})}
										</p>
									</div>
								</div>
								<p className="truncate text-sc-sm text-(--sc-text-secondary)" data-model-setup-activity>
									{activity ? activityLine(t, activity) : t("modelSetup.research.starting")}
								</p>
							</div>
						)}
						{!running && runError && (
							<div
								className="rounded-(--sc-radius-md) border border-(--sc-danger)/40 p-3 text-sc-sm"
								role="alert"
							>
								<p className="text-(--sc-danger)">{runError.message}</p>
								<ErrorDetail className="mt-1" error={runError.cause} />
								{runError.reply && (
									<pre className="mt-2 max-h-40 overflow-y-auto font-mono text-sc-xs break-words whitespace-pre-wrap text-(--sc-text-muted)">
										{runError.reply}
									</pre>
								)}
							</div>
						)}

						<div className="space-y-3">
							{rowGroups.map(group => (
								<section data-model-setup-group={group.id} key={group.id}>
									<h4 className="pb-1 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
										{t(`modelRoles.group.${group.id}`)}
									</h4>
									<ul className="space-y-0.5 [html[data-input=touch]_&]:space-y-1">
										{group.rows.map(row => (
											<RoleRow
												key={row.role}
												labelOf={labelOf}
												mode={mode}
												onTick={checked => setTicks(current => ({ ...current, [row.role]: checked }))}
												role={roles?.find(role => role.id === row.role)}
												row={row}
												ticked={isTicked(row)}
												keepsDefault={row.model !== null && row.model === defaultModel}
											/>
										))}
									</ul>
								</section>
							))}
						</div>

						{evidence && (
							<div className="space-y-2">
								{evidence.plan.notes && (
									<p className="text-sc-sm text-(--sc-text-secondary)">{evidence.plan.notes}</p>
								)}
								{evidence.dropped.length > 0 && (
									<InlineNotice
										detail={evidence.dropped.join("; ")}
										title={t("modelSetup.review.dropped", { count: evidence.dropped.length })}
										tone="info"
									/>
								)}
								{evidence.plan.sources.length > 0 && (
									<div>
										<h4 className="pb-1 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
											{t("modelSetup.review.sources")}
										</h4>
										<ul className="space-y-1">
											{evidence.plan.sources.map(source => (
												<li key={source.url}>
													<a
														className="inline-flex max-w-full items-center gap-1 text-sc-sm text-(--sc-accent) hover:underline"
														href={source.url}
														onClick={event => {
															event.preventDefault();
															openExternal(source.url);
														}}
														title={source.url}
													>
														<span className="truncate">{source.title}</span>
														<ExternalLink aria-hidden className="size-3 shrink-0" />
													</a>
												</li>
											))}
										</ul>
									</div>
								)}
							</div>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}

function activityLine(
	t: (key: string, params?: Record<string, string>) => string,
	activity: ModelSetupActivity,
): string {
	const key =
		activity.tool === "web_search"
			? "modelSetup.research.searching"
			: activity.tool === "read"
				? "modelSetup.research.reading"
				: "modelSetup.research.tool";
	return t(key, { tool: activity.tool, detail: activity.detail ?? "" }).trim();
}

/**
 * One role, one line: tick · role · → · model · state · ⓘ (the reason). A role left to stock shows what it runs on now;
 * a role already on the planned model reads "unchanged"; one the person set by hand is unticked and says so.
 */
function RoleRow({
	row,
	role,
	mode,
	ticked,
	keepsDefault,
	labelOf,
	onTick,
}: {
	row: ProposalRow;
	role: ModelRoleEntry | undefined;
	mode: PlanMode;
	ticked: boolean;
	keepsDefault: boolean;
	labelOf: (selector: string | undefined) => string;
	onTick: (checked: boolean) => void;
}) {
	const t = useT();
	const { lang } = useLang();
	const name = role ? modelRoleName(lang, role.name) : row.role;
	const stock = row.model === null;
	const unchanged = !stock && !writable(row);
	const effective = role?.effective?.name || labelOf(role?.effective?.model) || t("modelSetup.row.noModel");
	const reason = [
		reasonText(t, row, {
			mode,
			keepsDefault,
			...(row.research !== undefined ? { research: row.research } : {}),
		}),
		row.manual ? t("modelSetup.reason.manual") : "",
	]
		.filter(Boolean)
		.join(" ");
	const label = stock ? effective : labelOf(row.model ?? undefined);
	return (
		<li
			className="flex min-h-(--sc-control-md) items-center gap-2 text-sc-sm [html[data-input=touch]_&]:min-h-10"
			data-model-setup-role={row.role}
			data-model-setup-state={stock ? "stock" : unchanged ? "unchanged" : row.manual ? "manual" : "plan"}
		>
			{/* The label carries the checkbox's touch reach, and a tap on the role's name ticks it too. */}
			<label className="flex w-28 shrink-0 items-center gap-2 self-stretch sm:w-40">
				{stock ? (
					<span aria-hidden className="size-4 shrink-0" />
				) : (
					<input
						aria-label={t("modelSetup.row.select", { role: name })}
						checked={ticked}
						className="size-4 shrink-0 accent-(--sc-accent)"
						data-model-setup-tick={row.role}
						disabled={unchanged}
						onChange={event => onTick(event.target.checked)}
						type="checkbox"
					/>
				)}
				<span className="min-w-0 truncate font-medium text-(--sc-text)" title={name}>
					{name}
				</span>
			</label>
			<span aria-hidden className="shrink-0 text-(--sc-text-muted)">
				→
			</span>
			<span
				className={cx(
					"min-w-0 flex-1 truncate",
					stock || unchanged ? "text-(--sc-text-muted)" : "text-(--sc-text)",
				)}
				data-model-setup-model
				title={label}
			>
				{label}
			</span>
			{stock ? (
				<Badge className="shrink-0" variant="muted">
					{t("modelSetup.row.stock")}
				</Badge>
			) : unchanged ? (
				<Badge className="shrink-0" variant="muted">
					{t("modelSetup.row.unchanged")}
				</Badge>
			) : row.manual ? (
				<Badge className="shrink-0" variant="muted">
					{t("modelSetup.row.manual")}
				</Badge>
			) : null}
			<SettingInfo text={reason} />
		</li>
	);
}

function ModelCheckbox({
	option,
	checked,
	disabled,
	isDefault,
	onChange,
}: {
	option: SetupModelOption;
	checked: boolean;
	disabled: boolean;
	isDefault: boolean;
	onChange: (checked: boolean) => void;
}) {
	const t = useT();
	return (
		<label
			className={cx(
				"flex items-center gap-2.5 rounded-(--sc-radius-sm) px-1.5 py-1 hover:bg-(--sc-hover)",
				disabled && "opacity-60",
			)}
			title={option.selector}
		>
			<input
				checked={checked}
				className="size-4 shrink-0 accent-(--sc-accent)"
				data-model-setup-model={option.selector}
				disabled={disabled}
				onChange={event => onChange(event.target.checked)}
				type="checkbox"
			/>
			<span className="min-w-0 truncate text-sc-sm text-(--sc-text)">{option.label}</span>
			{isDefault && <Badge variant="success">{t("modelSetup.pick.default")}</Badge>}
			{option.billing === "metered" && (
				<Badge className="shrink-0" variant="muted">
					{t("modelSetup.pick.metered")}
				</Badge>
			)}
		</label>
	);
}
