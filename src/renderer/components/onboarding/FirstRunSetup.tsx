/**
 * First-run setup, inline in the empty main area (design-spec §2.2): omp is
 * installed on this machine (main does it on its own; `SetupTakeover` shows it
 * full-window before this ever renders) → connect a provider (search, recommended first, sign-in or API
 * key inline, or a custom endpoint) → the default model is picked and saved on its own and setup ends,
 * ready to prompt. Only when no model can be picked, or saving it fails, the model step lets the person
 * choose (optionally verified with one short test request). `FirstRunGate` decides when the provider
 * steps show (and resumes the model step left before a relaunch).
 * ⌘/Ctrl+Enter runs the step's primary action; Esc asks before leaving setup.
 */

import { ArrowLeft, CheckCircle2, Plus, Sparkles } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo } from "../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { modelSelector } from "../../lib/model-usage";
import { useTabRpc } from "../../lib/tab-rpc";
import { type FirstRunPhase, useFirstRunStore } from "../../stores/first-run";
import { useModelStore } from "../../stores/model";
import { focusedTabDevice } from "../../stores/remote";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import {
	Badge,
	Banner,
	BrandMark,
	Button,
	EmptyState,
	ErrorDetail,
	ListRow,
	Modal,
	SettingInfo,
	SkeletonRows,
} from "../common";
import { CustomProviderForm } from "../settings/providers/CustomProviderForm";
import { type ProviderCatalog, useProviderCatalog } from "../settings/providers/ProviderList";
import { ProviderLoginPanel, useProviderLogin } from "../settings/providers/ProviderLogin";
import { ProviderPicker } from "../settings/providers/ProviderPicker";
import {
	canServe,
	modelDisplayName,
	pickDefaultModel,
	STARTER_PROVIDERS,
	servingProviderIds,
} from "../settings/providers/provider-catalog";
import { applyDefaultModel } from "./default-model";
import { useMachineSetupNeeded } from "./MachineSetupView";

/**
 * True while the first-run setup replaces the empty-session hero: a provider
 * step is open, or this local tab's omp is not usable yet because machine
 * setup is still installing it.
 */
export function useFirstRunActive(): boolean {
	const phase = useFirstRunStore(state => state.phase);
	const installing = useMachineSetupNeeded();
	return phase !== "idle" || installing;
}

/** The step's primary action, which ⌘/Ctrl+Enter runs; null while it has none. */
const PrimaryActionContext = createContext<{ current: (() => void) | null }>({ current: null });

function usePrimaryAction(action: (() => void) | null): void {
	const ref = useContext(PrimaryActionContext);
	useEffect(() => {
		ref.current = action;
		return () => {
			if (ref.current === action) ref.current = null;
		};
	});
}
type SetupStep = Exclude<FirstRunPhase, "idle">;

/** The setup's top edge into view: a step opens there, whatever the last one left scrolled. */
function revealSetup(): void {
	document.querySelector("[data-first-run-step]")?.scrollIntoView?.({ block: "start" });
}

function ConnectStep() {
	const t = useT();
	const tabRpc = useTabRpc();
	const setPhase = useFirstRunStore(state => state.setPhase);
	const setModelError = useFirstRunStore(state => state.setModelError);
	const refreshAvailableModels = useModelStore(state => state.refreshAvailableModels);
	const live = useProviderCatalog();
	// Before omp answers (its first boot after machine setup installed it) the step shows the recommended
	// providers, not a spinner or a "not connected" error; their buttons wait for the session, and the live
	// catalog replaces them as soon as it is ready.
	const catalog: ProviderCatalog =
		!live.sidecarReady && live.providers.length === 0
			? { ...live, providers: [...STARTER_PROVIDERS], error: null, loading: false }
			: live;
	const customForm = useFirstRunStore(state => state.customForm);
	const setCustomForm = useFirstRunStore(state => state.setCustomForm);
	const { providers, customConfigs, load } = catalog;
	// The catalog drops its options whenever the tab's runtime is replaced and reads them again. Keep the last
	// ones, so a form that is open (and what is typed in it) stays put through that read.
	const lastOptions = useRef(catalog.options);
	if (catalog.options) lastOptions.current = catalog.options;
	const options = catalog.options ?? lastOptions.current;

	// The provider this setup just connected (sign-in or custom endpoint): its models are preferred, and
	// `connected` is set once the catalog has been read again, so the pick below sees the new provider.
	const justConnected = useRef<string | null>(null);
	const [connected, setConnected] = useState<string | null>(null);
	const settling = useRef(false);
	const advance = useCallback(
		async (providerId: string) => {
			justConnected.current = providerId;
			await load(true);
			setConnected(providerId);
		},
		[load],
	);
	const login = useProviderLogin(advance);

	// A provider can serve now (just connected here, or somewhere else meanwhile: Settings, the CLI, env): pick
	// its default model and end the setup. Only a pick that is missing or cannot be saved opens the model step.
	// A step opened ahead of the gate's check waits for it (a serving provider there means no setup at all).
	const provisional = useFirstRunStore(state => state.provisional);
	useEffect(() => {
		if (provisional || customForm || login.state.running || settling.current) return;
		const serving = servingProviderIds(providers, customConfigs);
		if (serving.size === 0 && connected === null) return;
		settling.current = true;
		const [first] = serving;
		const preferred = justConnected.current ?? first ?? null;
		void (async () => {
			const models = await refreshAvailableModels(false).then(
				result => result.models,
				() => useModelStore.getState().availableModels,
			);
			const pick = pickDefaultModel(models, serving, preferred ?? undefined);
			if (!pick) {
				setPhase("model", preferred);
				return;
			}
			try {
				await applyDefaultModel(tabRpc, useTabsStore.getState().activeTabId, pick);
			} catch (cause) {
				setModelError(cause instanceof Error ? cause.message : String(cause));
				setPhase("model", preferred);
				return;
			}
			setPhase("idle", null);
			announceReady(t, pick);
		})();
	}, [
		connected,
		customConfigs,
		customForm,
		login.state.running,
		provisional,
		providers,
		refreshAvailableModels,
		setModelError,
		setPhase,
		t,
		tabRpc,
	]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `customForm` is the trigger; the effect reads the DOM.
	useEffect(() => {
		revealSetup();
	}, [customForm]);

	// A new sign-in's panel opens under the whole provider list: bring it into view. Centered, because the
	// composer covers the scroller's bottom edge, where `nearest` would leave it.
	useEffect(() => {
		if (login.state.since > 0) document.querySelector("[data-login-panel]")?.scrollIntoView?.({ block: "center" });
	}, [login.state.since]);

	// The form needs the provider options. Until they arrive (or when reading them failed) say so in place,
	// instead of leaving the list as it was and popping the form in later.
	if (customForm && !options) {
		return (
			<div className="mt-6 flex flex-col gap-3" data-testid="first-run-custom-pending">
				{catalog.configError ? (
					<Banner
						actions={
							<Button onClick={() => void load(true)} size="sm" variant="secondary">
								{t("common.retry")}
							</Button>
						}
						live
						variant="warning"
					>
						{t("setup.configReadFailed")}
					</Banner>
				) : (
					<SkeletonRows className="py-2" label={t("modelPicker.loading")} widths={[60, 44, 70, 52]} />
				)}
				<div>
					<Button icon={<ArrowLeft />} onClick={() => setCustomForm(false)} variant="ghost">
						{t("setup.model.back")}
					</Button>
				</div>
			</div>
		);
	}

	if (customForm && options) {
		return (
			<div className="mt-6">
				<CustomProviderForm
					editing={null}
					existing={customConfigs}
					options={options}
					onCancel={() => setCustomForm(false)}
					onSaved={providerId => {
						setCustomForm(false);
						void advance(providerId);
					}}
				/>
			</div>
		);
	}

	return (
		<div className="mt-6 flex flex-col gap-3">
			{catalog.error && (
				<Banner
					actions={
						<Button
							disabled={!catalog.sidecarReady}
							onClick={() => void load(true)}
							size="sm"
							variant="secondary"
						>
							{t("common.retry")}
						</Button>
					}
					live
					title={t("providers.loadFailed")}
					variant="danger"
				>
					<ErrorDetail error={catalog.error} />
				</Banner>
			)}
			{catalog.configError && <Banner variant="warning">{t("setup.configReadFailed")}</Banner>}
			<ProviderPicker
				catalog={catalog}
				login={login}
				onAddCustom={() => setCustomForm(true)}
				showConnectedFeatured
			/>
			{login.state.providerId !== null && (
				<div data-login-panel>
					<ProviderLoginPanel
						login={login}
						onRetry={() => void login.start(login.state.providerId ?? "")}
						providerName={
							providers.find(row => row.id === login.state.providerId)?.name ?? login.state.providerId
						}
					/>
				</div>
			)}
			<div className="mt-2 flex items-center gap-3 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) px-4 py-3">
				<div className="flex min-w-0 flex-1 items-center gap-1.5">
					<span className="truncate text-sc-md font-medium text-(--sc-text)">{t("setup.custom.title")}</span>
					<SettingInfo text={t("setup.custom.description")} />
				</div>
				<Button icon={<Plus />} onClick={() => setCustomForm(true)} variant="secondary">
					{t("providerList.addCustom")}
				</Button>
			</div>
			<div className="mt-4 flex justify-end border-t border-(--sc-divider) pt-4">
				<Button onClick={() => setPhase("idle")} variant="ghost">
					{t("setup.later")}
				</Button>
			</div>
		</div>
	);
}

type TestState =
	| { kind: "idle" }
	| { kind: "running" }
	| { kind: "ok"; ms: number | null }
	| { kind: "failed"; failure: InlineFailure };

/** The last step is done: say which model the first request goes to. */
function announceReady(
	t: (key: string, params?: Record<string, string | number>) => string,
	model: Pick<ModelInfo, "id" | "name">,
): void {
	toast({
		variant: "success",
		title: t("setup.ready.title"),
		message: t("setup.ready.message", { model: modelDisplayName(model) }),
	});
}

function ModelStep() {
	const t = useT();
	const tabRpc = useTabRpc();
	const setPhase = useFirstRunStore(state => state.setPhase);
	const connectedProvider = useFirstRunStore(state => state.connectedProvider);
	const catalog = useProviderCatalog();
	const models = useModelStore(state => state.availableModels);
	const current = useModelStore(state => state.model);
	const refreshAvailableModels = useModelStore(state => state.refreshAvailableModels);
	const [selected, setSelected] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(() => useFirstRunStore.getState().modelError);
	const [test, setTest] = useState<TestState>({ kind: "idle" });
	const list = useRef<HTMLDivElement>(null);

	useEffect(() => {
		void refreshAvailableModels(false).catch(() => {});
	}, [refreshAvailableModels]);

	const serving = useMemo(
		() => servingProviderIds(catalog.providers, catalog.customConfigs),
		[catalog.providers, catalog.customConfigs],
	);
	const candidates = useMemo(() => models.filter(model => canServe(model, serving)), [models, serving]);
	const recommended = useMemo(
		() => pickDefaultModel(models, serving, connectedProvider ?? undefined),
		[models, serving, connectedProvider],
	);
	const ordered = useMemo(() => {
		// The provider just connected first, then the rest in catalog order.
		const first = candidates.filter(model => model.provider === connectedProvider);
		return [...first, ...candidates.filter(model => model.provider !== connectedProvider)];
	}, [candidates, connectedProvider]);
	const providerName = (id: string) => catalog.providers.find(provider => provider.id === id)?.name ?? id;

	const chosen =
		ordered.find(model => modelSelector(model) === selected) ??
		(current && canServe(current, serving) && !connectedProvider ? current : recommended);
	const chosenKey = chosen ? modelSelector(chosen) : null;

	// biome-ignore lint/correctness/useExhaustiveDependencies: a result belongs to the model it tested.
	useEffect(() => {
		setTest({ kind: "idle" });
	}, [chosenKey]);

	// The pre-selected default can sit far down a long list: show it, or nothing looks selected.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the row exists once the list has entries; the effect reads the DOM.
	useEffect(() => {
		list.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
	}, [chosenKey, ordered.length]);

	const runTest = async (model: ModelInfo) => {
		setTest({ kind: "running" });
		try {
			const result = await window.omp.bench.run(
				{
					models: [modelSelector(model)],
					profile: "chat",
					runs: 1,
					parallel: 1,
					maxTokens: 16,
				},
				focusedTabDevice(),
			);
			if (!result.success) {
				setTest({ kind: "failed", failure: inlineFailure(result, t("setup.test.failed")) });
				return;
			}
			const report = result.summary.models[0];
			const failure = report?.results.find(item => !item.ok);
			if (!report || failure || result.summary.failures > 0) {
				setTest({
					kind: "failed",
					failure: { message: t("setup.test.failed"), cause: failure?.error ?? t("setup.test.unknownError") },
				});
				return;
			}
			setTest({ kind: "ok", ms: report.stats ? Math.round(report.stats.ttftMs.mean) : null });
		} catch (cause) {
			setTest({ kind: "failed", failure: inlineFailure(cause, t("setup.test.failed")) });
		}
	};

	const finish = async (model: ModelInfo) => {
		setSaving(true);
		setError(null);
		try {
			await applyDefaultModel(tabRpc, useTabsStore.getState().activeTabId, model);
			setPhase("idle", null);
			announceReady(t, model);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	usePrimaryAction(chosen && !saving ? () => void finish(chosen) : null);

	return (
		<div className="mt-8 flex flex-col gap-3">
			<div>
				<h2 className="text-sc-xl font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)">
					{t("setup.model.title")}
				</h2>
				<p className="mt-1 text-sc-md text-(--sc-text-secondary)">{t("setup.model.description")}</p>
			</div>

			{ordered.length === 0 ? (
				catalog.loading || catalog.refreshPending ? (
					<SkeletonRows className="py-2" label={t("modelPicker.loading")} widths={[60, 44, 70, 52]} />
				) : (
					<EmptyState
						actions={
							<Button icon={<ArrowLeft />} onClick={() => setPhase("connect")} size="sm" variant="secondary">
								{t("setup.model.back")}
							</Button>
						}
						size="sm"
						title={t("setup.model.empty")}
						description={t("setup.model.emptyHint")}
					/>
				)
			) : (
				<div
					aria-label={t("setup.model.title")}
					className="flex max-h-96 flex-col overflow-y-auto rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-1"
					ref={list}
					role="radiogroup"
				>
					{ordered.map(model => {
						const key = modelSelector(model);
						const isChosen = key === chosenKey;
						return (
							<ListRow
								buttonProps={{ role: "radio", "aria-checked": isChosen }}
								description={[
									providerName(model.provider),
									model.contextWindow
										? t("setup.model.context", { tokens: formatTokens(model.contextWindow) })
										: null,
								]
									.filter(Boolean)
									.join(" · ")}
								key={key}
								leading={
									isChosen ? (
										<CheckCircle2 aria-hidden className="text-(--sc-accent)" />
									) : (
										<span
											aria-hidden
											className="size-4 rounded-(--sc-radius-full) border border-(--sc-border)"
										/>
									)
								}
								meta={
									key === (recommended ? modelSelector(recommended) : null) ? (
										<Badge variant="accent">{t("modelPicker.badge.recommended")}</Badge>
									) : undefined
								}
								onClick={() => setSelected(key)}
								selected={isChosen}
								title={modelDisplayName(model)}
								titleText={key}
							/>
						);
					})}
				</div>
			)}

			{test.kind === "ok" && (
				<Banner live variant="success">
					{test.ms !== null ? t("setup.test.okIn", { ms: test.ms }) : t("setup.test.ok")}
				</Banner>
			)}
			{test.kind === "failed" && (
				<Banner live title={test.failure.message} variant="danger">
					<ErrorDetail error={test.failure.cause} />
				</Banner>
			)}
			{error && (
				<Banner live title={t("setup.model.saveFailed")} variant="danger">
					<ErrorDetail error={error} />
				</Banner>
			)}

			<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-(--sc-divider) pt-4">
				<Button icon={<ArrowLeft />} onClick={() => setPhase("connect")} variant="ghost">
					{t("setup.model.back")}
				</Button>
				<span className="flex-1" />
				{chosen && (
					<Button
						loading={test.kind === "running"}
						onClick={() => void runTest(chosen)}
						title={t("setup.test.hint")}
						variant="secondary"
					>
						{t("setup.test.action")}
					</Button>
				)}
				<Button
					disabled={!chosen}
					icon={<Sparkles />}
					loading={saving}
					onClick={() => {
						if (chosen) void finish(chosen);
					}}
					variant="primary"
				>
					{t("setup.model.use")}
				</Button>
			</div>
		</div>
	);
}

function LeaveConfirm({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const setPhase = useFirstRunStore(state => state.setPhase);
	return (
		<Modal
			footer={
				<>
					<Button autoFocus onClick={onClose} variant="secondary">
						{t("setup.leave.stay")}
					</Button>
					<Button
						onClick={() => {
							onClose();
							setPhase("idle", null);
						}}
						variant="primary"
					>
						{t("setup.later")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="sm"
			title={t("setup.leave.title")}
		>
			<p className="text-sc-md break-keep text-(--sc-text-secondary)">{t("setup.leave.message")}</p>
		</Modal>
	);
}

export function FirstRunSetup() {
	const t = useT();
	const phase = useFirstRunStore(state => state.phase);
	const primary = useRef<(() => void) | null>(null);
	const [leaving, setLeaving] = useState(false);
	const active = phase !== "idle";
	const step: SetupStep = phase === "idle" ? "connect" : phase;

	// Bubbling on document: a field, popover or the composer that handles a key
	// first (and prevents it) keeps it; a dialog above setup owns its own keys.
	useEffect(() => {
		if (!active) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.repeat || event.defaultPrevented || isImeKeyEvent(event)) return;
			if (event.altKey || event.shiftKey || document.querySelector('[role="dialog"]')) return;
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				const action = primary.current;
				if (!action) return;
				event.preventDefault();
				action();
			} else if (event.key === "Escape" && !event.metaKey && !event.ctrlKey) {
				event.preventDefault();
				setLeaving(true);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [active]);

	// The provider step on screen: the launch timing mark the slow-first-run measurements end on.
	useEffect(() => {
		if (active && step === "connect") window.omp.runtime.startupMark("first-run-visible");
	}, [active, step]);

	// A step is a new page: it opens at its top, not at the scroll position the last step left.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `step` is the trigger; the effect reads the DOM.
	useEffect(() => {
		if (active) revealSetup();
	}, [active, step]);

	if (!active) return null;
	return (
		<PrimaryActionContext.Provider value={primary}>
			<section
				aria-labelledby="first-run-title"
				className="mx-auto flex w-full max-w-2xl flex-col px-4 py-8 sm:px-6 sm:py-10"
				data-first-run-step={step}
			>
				<BrandMark size={48} />
				<h1
					className="mt-5 text-sc-3xl font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)"
					id="first-run-title"
				>
					{t("setup.title")}
				</h1>
				{step === "connect" && (
					<p className="mt-2 text-sc-md text-(--sc-text-muted)">{t("setup.connect.description")}</p>
				)}
				{step === "connect" ? <ConnectStep /> : <ModelStep />}
				<LeaveConfirm onClose={() => setLeaving(false)} open={leaving} />
			</section>
		</PrimaryActionContext.Provider>
	);
}
