/**
 * Model setup assistant: pick the models the connected accounts serve, let a
 * research model compare them on public benchmarks (one stock omp job on the
 * focused tab's machine), then review its role-by-role proposal and apply it.
 * Nothing is written before Apply, and Apply writes only the roles whose model
 * changes plus `advisor.enabled` when its switch moved. The last proposal is
 * kept per device, so reopening shows it with its date.
 */

import { ExternalLink, Info, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ADVISOR_ROLE,
	MODEL_SETUP_MAX_MODELS,
	MODEL_SETUP_TIMEOUT_MS,
	type ModelSetupActivity,
	type ModelSetupRequest,
} from "../../../../shared/model-setup";
import type { ModelRoleEntry, ModelRolesResult } from "../../../../shared/rpc-types";
import { errorDetail, type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { cx, formatClock } from "../../../lib/format";
import { useLang, useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useModelStore } from "../../../stores/model";
import { useFocusedTabDevice } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { toast } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Badge, Button, ErrorDetail, Modal, SearchField, Select, Spinner, SwitchField } from "../../common";
import { InlineNotice } from "../InlineNotice";
import {
	baseSelector,
	changedAssignments,
	currentDefaultModel,
	defaultSelection,
	draftsOf,
	groupByProvider,
	loadLastProposal,
	type SetupModelOption,
	type StoredProposal,
	saveLastProposal,
	setupModelOptions,
	setupRoles,
} from "./model-setup-logic";

type Step = "loading" | "pick" | "research" | "review";
const STEPS = ["pick", "research", "review"] as const;

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatContext(tokens: number): string {
	return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1_000)}K`;
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
	const catalog = useModelStore(state => state.availableModels);
	const providers = useModelStore(state => state.providers);

	const [step, setStep] = useState<Step>("loading");
	const [roles, setRoles] = useState<ModelRoleEntry[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [researchModel, setResearchModel] = useState("");
	const [query, setQuery] = useState("");
	const [running, setRunning] = useState(false);
	const [startedAt, setStartedAt] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const [activity, setActivity] = useState<ModelSetupActivity | undefined>();
	const [runError, setRunError] = useState<(InlineFailure & { reply?: string }) | null>(null);
	const [proposal, setProposal] = useState<StoredProposal | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [advisorOn, setAdvisorOn] = useState(false);
	const [advisorEnabled, setAdvisorEnabled] = useState<boolean | undefined>();
	const [applying, setApplying] = useState(false);

	const options = useMemo(() => setupModelOptions(roles, catalog), [roles, catalog]);
	const defaultModel = useMemo(() => currentDefaultModel(roles, options, activeModel), [roles, options, activeModel]);
	const groups = useMemo(() => groupByProvider(options), [options]);
	const providerName = (id: string) => providers.find(provider => provider.id === id)?.name ?? id;
	const labelOf = (selector: string | undefined) =>
		selector
			? (options.find(option => option.selector === selector)?.label ?? selector)
			: t("modelSetup.review.unset");

	const showProposal = useCallback((stored: StoredProposal) => {
		setProposal(stored);
		setDrafts(draftsOf(stored.plan));
		setAdvisorOn(stored.plan.advisor.enable);
		setStep("review");
	}, []);

	const startOver = useCallback((nextRoles: ModelRoleEntry[]) => {
		const nextOptions = setupModelOptions(nextRoles, useModelStore.getState().availableModels);
		const nextDefault = currentDefaultModel(nextRoles, nextOptions, useModelStore.getState().model);
		setSelected(defaultSelection(nextOptions, nextDefault));
		setResearchModel(nextDefault ?? nextOptions[0]?.selector ?? "");
		setRunError(null);
		setStep("pick");
	}, []);

	// One read on open: the roles (their candidates are the connected accounts' models),
	// the advisor switch, the catalog for context and price, and the last proposal.
	useEffect(() => {
		if (!sidecarReady) {
			setStep(current => (current === "loading" ? "pick" : current));
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const [rolesRes, settingsRes, stored] = await Promise.all([
					tabRpc.getModelRoles(),
					tabRpc.getSettings(["advisor.enabled"]),
					loadLastProposal(device).catch(() => undefined),
					useModelStore
						.getState()
						.refreshAvailableModels()
						.catch(() => undefined),
				]);
				if (cancelled) return;
				if (!rolesRes.success) {
					setLoadError(rolesRes.error);
					setStep("pick");
					return;
				}
				const nextRoles = (rolesRes.data as ModelRolesResult).roles;
				setRoles(nextRoles);
				if (settingsRes.success) {
					const data = settingsRes.data as { values?: Record<string, unknown>; advisorEnabled?: boolean };
					const enabled = data.advisorEnabled ?? data.values?.["advisor.enabled"];
					setAdvisorEnabled(typeof enabled === "boolean" ? enabled : undefined);
				}
				startOver(nextRoles);
				if (stored) showProposal(stored);
			} catch (cause) {
				if (!cancelled) {
					setLoadError(cause instanceof Error ? cause.message : String(cause));
					setStep("pick");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [device, showProposal, sidecarReady, startOver, tabRpc]);

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

	const close = () => {
		if (running) void window.omp.modelSetup.abort(runDevice.current).catch(() => false);
		useUiStore.getState().closeModelSetup();
	};

	const toggle = (selector: string, checked: boolean) =>
		setSelected(current =>
			checked
				? [...current.filter(value => value !== selector), selector]
				: current.filter(value => value !== selector),
		);

	const research = async () => {
		const models = options.filter(option => selected.includes(option.selector));
		const request: ModelSetupRequest = {
			researchModel,
			...(defaultModel ? { defaultModel } : {}),
			models: models.map(({ label: _label, ...model }) => model),
			roles: setupRoles(roles),
			language: lang === "ko" ? "Korean" : "English",
		};
		runDevice.current = device;
		setRunError(null);
		setActivity(undefined);
		setStartedAt(Date.now());
		setNow(Date.now());
		setRunning(true);
		setStep("research");
		try {
			const result = await window.omp.modelSetup.run(request, device);
			if (result.success) {
				const stored: StoredProposal = {
					savedAt: Date.now(),
					researchModel,
					models: models.map(model => model.selector),
					plan: result.plan,
					dropped: result.dropped,
				};
				await saveLastProposal(device, stored).catch(() => {});
				showProposal(stored);
			} else if (result.cancelled) {
				setStep("pick");
			} else {
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

	const changes = useMemo(() => changedAssignments(drafts, roles), [drafts, roles]);
	const advisorChanges = advisorEnabled === undefined ? advisorOn : advisorOn !== advisorEnabled;
	const advisorModelAfter =
		drafts[ADVISOR_ROLE] ??
		baseSelector(roles.find(role => role.id === ADVISOR_ROLE)?.model) ??
		drafts.slow ??
		baseSelector(roles.find(role => role.id === "slow")?.model);

	const apply = async () => {
		setApplying(true);
		const failures: Array<{ role: string; error: unknown }> = [];
		let written = 0;
		for (const change of changes) {
			try {
				const res = await tabRpc.setModelRole(change.role, change.model);
				if (res.success) written++;
				else failures.push({ role: change.role, error: res });
			} catch (error) {
				failures.push({ role: change.role, error });
			}
		}
		let advisorActive: boolean | undefined;
		let advisorFailed: unknown;
		if (advisorChanges) {
			try {
				const res = await tabRpc.setSetting("advisor.enabled", advisorOn);
				if (res.success) {
					setAdvisorEnabled(advisorOn);
					advisorActive = (res.data as { advisorActive?: boolean } | undefined)?.advisorActive;
				} else advisorFailed = res;
			} catch (error) {
				advisorFailed = error;
			}
		}
		setApplying(false);
		if (failures.length > 0 || advisorFailed !== undefined) {
			toast({
				variant: "error",
				title: t("modelSetup.apply.failedTitle"),
				message: t("modelSetup.apply.partial", {
					count: written,
					failed: failures.length + (advisorFailed !== undefined ? 1 : 0),
				}),
				detail: [
					...failures.map(failure => `${failure.role}: ${errorDetail(failure.error)}`),
					...(advisorFailed !== undefined ? [`advisor.enabled: ${errorDetail(advisorFailed)}`] : []),
				].join("\n"),
			});
			return;
		}
		const advisorPart = advisorChanges
			? ` ${t(advisorOn ? "modelSetup.apply.advisorOn" : "modelSetup.apply.advisorOff")}`
			: "";
		toast({
			variant: written > 0 || advisorChanges ? "success" : "info",
			message:
				written > 0 || advisorChanges
					? `${t("modelSetup.apply.done", { count: written })}${advisorPart}`
					: t("modelSetup.apply.nothing"),
		});
		if (advisorOn && advisorActive === false) toast({ variant: "warning", message: t("advisor.noModel") });
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
	const atLimit = selected.length >= MODEL_SETUP_MAX_MODELS;
	const canResearch = sidecarReady && selected.length > 0 && researchModel !== "" && !running;
	const orderedAssignments = proposal
		? [...proposal.plan.assignments].sort(
				(a, b) => roles.findIndex(role => role.id === a.role) - roles.findIndex(role => role.id === b.role),
			)
		: [];
	const proposalModels = proposal ? options.filter(option => proposal.models.includes(option.selector)) : [];

	const footer =
		step === "pick" ? (
			<>
				{proposal && (
					<Button className="mr-auto" onClick={() => showProposal(proposal)} variant="ghost">
						{t("modelSetup.pick.backToProposal")}
					</Button>
				)}
				<Button onClick={close} variant="secondary">
					{t("common.cancel")}
				</Button>
				<Button disabled={!canResearch} icon={<Sparkles />} onClick={() => void research()} variant="primary">
					{t("modelSetup.pick.start")}
				</Button>
			</>
		) : step === "research" ? (
			running ? (
				<Button onClick={cancel} variant="danger">
					{t("modelSetup.research.cancel")}
				</Button>
			) : (
				<>
					<Button onClick={() => setStep("pick")} variant="secondary">
						{t("modelSetup.research.back")}
					</Button>
					<Button disabled={!canResearch} onClick={() => void research()} variant="primary">
						{t("common.retry")}
					</Button>
				</>
			)
		) : step === "review" ? (
			<>
				<Button className="mr-auto" onClick={() => startOver(roles)} variant="ghost">
					{t("modelSetup.review.startOver")}
				</Button>
				<Button onClick={close} variant="secondary">
					{t("common.cancel")}
				</Button>
				<Button
					disabled={!sidecarReady || applying}
					loading={applying}
					onClick={() => void apply()}
					variant="primary"
				>
					{t("modelSetup.review.apply")}
				</Button>
			</>
		) : undefined;

	return (
		<Modal footer={footer} onClose={close} open size="lg" title={t("modelSetup.title")}>
			<div className="space-y-4" data-model-setup-step={step}>
				<ol aria-label={t("modelSetup.steps")} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sc-sm">
					{STEPS.map((id, index) => (
						<li
							aria-current={step === id ? "step" : undefined}
							className={cx(
								"flex items-center gap-1.5",
								step === id ? "font-medium text-(--sc-text)" : "text-(--sc-text-muted)",
							)}
							key={id}
						>
							<span
								className={cx(
									"inline-flex size-5 items-center justify-center rounded-(--sc-radius-full) border text-sc-xs tabular-nums",
									step === id ? "border-(--sc-accent) text-(--sc-accent)" : "border-(--sc-border-subtle)",
								)}
							>
								{index + 1}
							</span>
							{t(`modelSetup.step.${id}`)}
						</li>
					))}
				</ol>

				{!sidecarReady && <InlineNotice title={t("modelSetup.notConnected")} tone="info" />}
				{loadError !== null && <InlineNotice detail={loadError} title={t("modelSetup.loadFailed")} tone="danger" />}

				{step === "loading" && (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				)}

				{step === "pick" && (
					<div className="space-y-4">
						<p className="text-sc-sm text-(--sc-text-secondary)">{t("modelSetup.pick.intro")}</p>
						{options.length === 0 && sidecarReady && loadError === null ? (
							<InlineNotice title={t("modelSetup.pick.none")} tone="warning" />
						) : (
							<>
								<div className="flex items-center gap-3">
									<SearchField
										className="min-w-0 flex-1"
										label={t("modelSetup.pick.filter")}
										onValueChange={setQuery}
										placeholder={t("modelSetup.pick.filter")}
										value={query}
									/>
									<span className="shrink-0 text-sc-sm tabular-nums text-(--sc-text-muted)">
										{t("modelSetup.pick.count", { count: selected.length, max: MODEL_SETUP_MAX_MODELS })}
									</span>
								</div>
								<div className="max-h-72 space-y-3 overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-3">
									{visibleGroups.map(group => (
										<fieldset className="space-y-1" key={group.provider}>
											<legend className="pb-1 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
												{providerName(group.provider)}
											</legend>
											{group.models.map(option => (
												<ModelCheckbox
													checked={selected.includes(option.selector)}
													disabled={running || (atLimit && !selected.includes(option.selector))}
													isDefault={option.selector === defaultModel}
													key={option.selector}
													onChange={checked => toggle(option.selector, checked)}
													option={option}
												/>
											))}
										</fieldset>
									))}
								</div>
								<Select
									hint={t("modelSetup.pick.researchHint")}
									label={t("modelSetup.pick.researchModel")}
									onChange={event => setResearchModel(event.target.value)}
									value={researchModel}
								>
									{groups.map(group => (
										<optgroup key={group.provider} label={providerName(group.provider)}>
											{group.models.map(option => (
												<option key={option.selector} value={option.selector}>
													{option.label === option.selector
														? option.selector
														: `${option.label} (${option.selector})`}
												</option>
											))}
										</optgroup>
									))}
								</Select>
								<p className="flex items-start gap-2 text-sc-sm text-(--sc-text-muted)">
									<Info aria-hidden className="mt-0.5 size-(--sc-icon-sm) shrink-0" />
									{t("modelSetup.pick.cost", { model: labelOf(researchModel) })}
								</p>
							</>
						)}
					</div>
				)}

				{step === "research" && (
					<div className="space-y-3 py-2" role="status">
						{running ? (
							<>
								<div className="flex items-center gap-3">
									<Spinner />
									<div className="min-w-0">
										<p className="text-sc-md font-medium text-(--sc-text)">
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
							</>
						) : (
							runError && (
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
							)
						)}
					</div>
				)}

				{step === "review" && proposal && (
					<div className="space-y-4">
						<p className="text-sc-sm text-(--sc-text-muted)">
							{t("modelSetup.review.meta", {
								date: formatClock(proposal.savedAt),
								model: labelOf(proposal.researchModel),
							})}
						</p>
						<div className="overflow-x-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle)">
							<table className="w-full text-left text-sc-sm">
								<thead className="text-sc-xs text-(--sc-text-muted)">
									<tr className="border-b border-(--sc-border-subtle)">
										<th className="px-3 py-2 font-medium">{t("modelSetup.review.role")}</th>
										<th className="px-3 py-2 font-medium">{t("modelSetup.review.model")}</th>
										<th className="px-3 py-2 font-medium">{t("modelSetup.review.reason")}</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-(--sc-divider)">
									{orderedAssignments.map(entry => {
										const role = roles.find(candidate => candidate.id === entry.role);
										const current = baseSelector(role?.model);
										const draft = drafts[entry.role] ?? entry.model;
										return (
											<tr data-model-setup-role={entry.role} key={entry.role}>
												<td className="px-3 py-2 align-top">
													<div className="font-medium text-(--sc-text)">{role?.name ?? entry.role}</div>
													<div className="text-sc-xs text-(--sc-text-muted)">
														{t("modelSetup.review.current", { model: labelOf(current) })}
													</div>
												</td>
												<td className="min-w-52 px-3 py-2 align-top">
													<Select
														aria-label={t("modelSetup.review.select", { role: role?.name ?? entry.role })}
														controlSize="sm"
														onChange={event =>
															setDrafts(previous => ({ ...previous, [entry.role]: event.target.value }))
														}
														value={draft}
													>
														{proposalModels.map(option => (
															<option key={option.selector} value={option.selector}>
																{option.label}
															</option>
														))}
														{!proposalModels.some(option => option.selector === draft) && (
															<option value={draft}>{draft}</option>
														)}
													</Select>
													{draft === current && (
														<Badge className="mt-1" variant="muted">
															{t("modelSetup.review.unchanged")}
														</Badge>
													)}
												</td>
												<td className="px-3 py-2 align-top text-(--sc-text-secondary)">{entry.reason}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
						{/* The row's hover inset sits outside the content edge, like the other dialog switches. */}
						<div className="-mx-2">
							<SwitchField
								checked={advisorOn}
								description={proposal.plan.advisor.reason || undefined}
								label={t("modelSetup.review.advisor")}
								onCheckedChange={setAdvisorOn}
							/>
						</div>
						{advisorOn && !advisorModelAfter && (
							<InlineNotice title={t("modelSetup.review.advisorNoModel")} tone="warning" />
						)}
						{proposal.plan.notes && (
							<p className="text-sc-sm text-(--sc-text-secondary)">{proposal.plan.notes}</p>
						)}
						{proposal.dropped.length > 0 && (
							<InlineNotice
								detail={proposal.dropped.join("; ")}
								title={t("modelSetup.review.dropped", { count: proposal.dropped.length })}
								tone="info"
							/>
						)}
						{proposal.plan.sources.length > 0 && (
							<div>
								<h4 className="pb-1 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
									{t("modelSetup.review.sources")}
								</h4>
								<ul className="space-y-1">
									{proposal.plan.sources.map(source => (
										<li key={source.url}>
											<a
												className="inline-flex max-w-full items-center gap-1 text-sc-sm text-(--sc-accent) hover:underline"
												href={source.url}
												onClick={event => {
													event.preventDefault();
													void window.omp.system.openExternal(source.url);
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
	const facts = [
		option.contextWindow ? t("modelSetup.pick.context", { tokens: formatContext(option.contextWindow) }) : undefined,
		option.cost?.input !== undefined && option.cost.output !== undefined
			? t("modelSetup.pick.price", { input: option.cost.input, output: option.cost.output })
			: undefined,
	].filter((fact): fact is string => fact !== undefined);
	return (
		<label
			className={cx(
				"flex items-start gap-2.5 rounded-(--sc-radius-sm) px-1.5 py-1 hover:bg-(--sc-hover)",
				disabled && "opacity-60",
			)}
		>
			<input
				checked={checked}
				className="mt-0.5 size-4 shrink-0 accent-(--sc-accent)"
				data-model-setup-model={option.selector}
				disabled={disabled}
				onChange={event => onChange(event.target.checked)}
				type="checkbox"
			/>
			<span className="min-w-0 flex-1">
				<span className="flex flex-wrap items-center gap-1.5">
					<span className="text-sc-sm text-(--sc-text)">{option.label}</span>
					{isDefault && <Badge variant="success">{t("modelSetup.pick.default")}</Badge>}
				</span>
				<span className="block truncate font-mono text-sc-xs text-(--sc-text-muted)">
					{[option.selector, ...facts].join(" · ")}
				</span>
			</span>
		</label>
	);
}
