/**
 * First-run setup, inline in the empty main area (design-spec §2.2): connect
 * a provider (search, recommended first, sign-in or API key inline, or a
 * custom endpoint) → choose the default model (optionally verified with one
 * short test request) → ready to prompt. `FirstRunGate` decides when it shows.
 */

import { ArrowLeft, Check, CheckCircle2, Plus, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "../../../shared/rpc-types";
import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { type FirstRunPhase, useFirstRunStore } from "../../stores/first-run";
import { useModelStore } from "../../stores/model";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { Badge, Banner, BrandMark, Button, EmptyState, ListRow, Spinner } from "../common";
import { CustomProviderForm } from "../settings/providers/CustomProviderForm";
import { ProviderList, useProviderCatalog } from "../settings/providers/ProviderList";
import { useProviderLogin } from "../settings/providers/ProviderLogin";
import {
	canServe,
	hasUsableModelProvider,
	modelDisplayName,
	modelSelector,
	pickDefaultModel,
	servingProviderIds,
} from "../settings/providers/provider-catalog";
import { applyDefaultModel } from "./default-model";

/** True while the first-run setup replaces the empty-session hero. */
export function useFirstRunActive(): boolean {
	return useFirstRunStore(state => state.phase !== "idle");
}

const STEPS = ["connect", "model", "prompt"] as const;

function StepList({ phase }: { phase: Exclude<FirstRunPhase, "idle"> }) {
	const t = useT();
	const current = STEPS.indexOf(phase);
	return (
		<ol aria-label={t("setup.steps")} className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
			{STEPS.map((step, index) => {
				const done = index < current;
				const active = index === current;
				return (
					<li
						aria-current={active ? "step" : undefined}
						className={`flex items-center gap-2 text-sc-sm ${active ? "font-medium text-(--sc-text)" : "text-(--sc-text-muted)"}`}
						key={step}
					>
						<span
							aria-hidden
							className={`flex size-5 items-center justify-center rounded-(--sc-radius-full) border text-sc-2xs font-semibold ${
								done
									? "border-transparent bg-(--sc-success-soft) text-(--sc-success)"
									: active
										? "border-transparent bg-(--sc-accent) text-(--sc-accent-fg)"
										: "border-(--sc-border-subtle) text-(--sc-text-muted)"
							}`}
						>
							{done ? <Check className="size-3" /> : index + 1}
						</span>
						{t(`setup.step.${step}`)}
						{done && <span className="sr-only">{t("setup.stepDone")}</span>}
					</li>
				);
			})}
		</ol>
	);
}

function ConnectStep() {
	const t = useT();
	const setPhase = useFirstRunStore(state => state.setPhase);
	const catalog = useProviderCatalog();
	const [customForm, setCustomForm] = useState(false);
	const { providers, customConfigs, load } = catalog;

	const advance = useCallback(
		async (providerId: string) => {
			await load(true);
			setPhase("model", providerId);
		},
		[load, setPhase],
	);
	const login = useProviderLogin(advance);

	// Connected somewhere else meanwhile (Settings, the CLI, env): move on.
	useEffect(() => {
		if (customForm || login.state.running || !hasUsableModelProvider(providers, customConfigs)) return;
		const [first] = servingProviderIds(providers, customConfigs);
		setPhase("model", first ?? null);
	}, [customConfigs, customForm, login.state.running, providers, setPhase]);

	if (customForm) {
		return (
			<div className="mt-8">
				<CustomProviderForm
					editing={null}
					existing={customConfigs}
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
		<div className="mt-8 flex flex-col gap-3">
			<div>
				<h2 className="text-sc-xl font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)">
					{t("setup.connect.title")}
				</h2>
				<p className="mt-1 text-sc-md text-(--sc-text-secondary)">{t("setup.connect.description")}</p>
			</div>
			{catalog.error && (
				<Banner
					actions={
						<Button
							disabled={!catalog.sidecarReady}
							onClick={() => void load(true)}
							size="sm"
							variant="secondary"
						>
							{t("providerCfg.list.retry")}
						</Button>
					}
					live
					title={t("providers.loadFailed")}
					variant="danger"
				>
					{catalog.error}
				</Banner>
			)}
			{catalog.configError && <Banner variant="warning">{t("setup.configReadFailed")}</Banner>}
			<ProviderList catalog={catalog} login={login} onAddCustom={() => setCustomForm(true)} />
			<div className="mt-2 flex flex-wrap items-center gap-3 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) px-4 py-3">
				<div className="min-w-0 flex-1">
					<div className="text-sc-md font-medium text-(--sc-text)">{t("setup.custom.title")}</div>
					<div className="text-sc-sm text-(--sc-text-muted)">{t("setup.custom.description")}</div>
				</div>
				<Button icon={<Plus />} onClick={() => setCustomForm(true)} variant="secondary">
					{t("providerList.addCustom")}
				</Button>
			</div>
			<div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-(--sc-divider) pt-4">
				<p className="min-w-0 flex-1 text-sc-sm text-(--sc-text-muted)">{t("setup.laterHint")}</p>
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
	| { kind: "failed"; error: string };

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
	const [error, setError] = useState<string | null>(null);
	const [test, setTest] = useState<TestState>({ kind: "idle" });

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

	const runTest = async (model: ModelInfo) => {
		setTest({ kind: "running" });
		try {
			const result = await window.omp.bench.run({
				models: [modelSelector(model)],
				profile: "chat",
				runs: 1,
				parallel: 1,
				maxTokens: 16,
			});
			if (!result.success) {
				setTest({ kind: "failed", error: result.error });
				return;
			}
			const report = result.summary.models[0];
			const failure = report?.results.find(item => !item.ok);
			if (!report || failure || result.summary.failures > 0) {
				setTest({ kind: "failed", error: failure?.error ?? t("setup.test.unknownError") });
				return;
			}
			setTest({ kind: "ok", ms: report.stats ? Math.round(report.stats.ttftMs.mean) : null });
		} catch (cause) {
			setTest({ kind: "failed", error: cause instanceof Error ? cause.message : String(cause) });
		}
	};

	const finish = async (model: ModelInfo) => {
		setSaving(true);
		setError(null);
		try {
			await applyDefaultModel(tabRpc, useTabsStore.getState().activeTabId, model);
			setPhase("idle", null);
			toast({
				variant: "success",
				title: t("setup.ready.title"),
				message: t("setup.ready.message", { model: modelDisplayName(model) }),
			});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

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
					<div className="flex justify-center py-8">
						<Spinner label={t("modelPicker.loading")} />
					</div>
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
				<Banner live title={t("setup.test.failed")} variant="danger">
					{test.error}
				</Banner>
			)}
			{error && (
				<Banner live title={t("setup.model.saveFailed")} variant="danger">
					{error}
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

export function FirstRunSetup() {
	const t = useT();
	const phase = useFirstRunStore(state => state.phase);
	if (phase === "idle") return null;
	return (
		<section aria-labelledby="first-run-title" className="mx-auto flex w-full max-w-2xl flex-col py-10">
			<BrandMark size={36} />
			<h1
				className="mt-5 text-sc-3xl font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)"
				id="first-run-title"
			>
				{t("setup.title")}
			</h1>
			<p className="mt-2 text-sc-lg text-(--sc-text-muted)">{t("setup.subtitle")}</p>
			<StepList phase={phase} />
			{phase === "connect" ? <ConnectStep /> : <ModelStep />}
		</section>
	);
}
