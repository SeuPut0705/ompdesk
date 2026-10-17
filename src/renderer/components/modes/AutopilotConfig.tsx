/**
 * The Autopilot tab of the Mode popover: the start sheet while no run is live, the run's summary and controls while
 * one is. Starting always opens a new worktree tab on a new `autopilot/<date>` branch and runs there with every tool
 * approved, so this sheet is where the user consents to that (it replaces the full-access confirmation).
 */

import { ChevronRight, CircleCheck, PanelRight, Rocket, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	AUTOPILOT_AREAS,
	AUTOPILOT_LIMITS_PREF,
	AUTOPILOT_NOTIFY_MODES,
	AUTOPILOT_NOTIFY_PREF,
	AUTOPILOT_SHIP_PREF,
	AUTOPILOT_SHIP_PRESETS,
	type AutopilotArea,
	type AutopilotGuideInfo,
	type AutopilotNotifyMode,
	type AutopilotReleaseCadence,
	type AutopilotShipPolicy,
	type AutopilotShipPreset,
	type AutopilotStatus,
	DEFAULT_AUTOPILOT_SETTINGS,
	DEFAULT_RELEASE_EVERY,
	MAX_PARALLEL_CHILDREN,
	shipPolicyForPreset,
} from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { isLiveAutopilot, tabAutopilotStore, useAutopilotStore } from "../../stores/autopilot";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import {
	Button,
	InlineNotice,
	Input,
	Select,
	SettingInfo,
	Tabs,
	TextArea,
	type TextAreaProps,
	Tooltip,
} from "../common";
import { FocusChips } from "../panels/autopilot/AreaMix";
import { useAutopilotStateText } from "../panels/autopilot/AutopilotBoardCard";
import { AutopilotPauseButton, AutopilotStopButtons } from "../panels/autopilot/AutopilotControls";
import { limitsFromText, presetOfPolicy, startBlock } from "../panels/autopilot/autopilot-view";
import { useAutopilotActions } from "../panels/autopilot/use-autopilot-actions";
import { SettingsRow } from "../settings/SettingsLayout";

const PARALLEL_CHOICES = Array.from({ length: MAX_PARALLEL_CHILDREN + 1 }, (_, n) => n);
const EVERY_CHOICES = [3, 5, 10];

function isPreset(value: unknown): value is AutopilotShipPreset {
	return (AUTOPILOT_SHIP_PRESETS as readonly unknown[]).includes(value);
}

function isNotifyMode(value: unknown): value is AutopilotNotifyMode {
	return (AUTOPILOT_NOTIFY_MODES as readonly unknown[]).includes(value);
}

function isIdleStatus(value: unknown): value is AutopilotStatus {
	return typeof value === "object" && value !== null && "active" in value && value.active === false;
}

type GuideHintKey =
	| "autopilot.sheet.guideTooLarge"
	| "autopilot.sheet.guideExists"
	| "autopilot.sheet.guideDrafting"
	| "autopilot.sheet.guideModel"
	| "autopilot.sheet.guideTemplate";

/** The line under the guide box: what the text is (the repo's file, a draft, a template) and where it goes. */
function guideHintKey(guide: AutopilotGuideInfo | undefined, drafting: boolean): GuideHintKey | null {
	if (guide?.tooLarge) return "autopilot.sheet.guideTooLarge";
	if (guide?.exists) return "autopilot.sheet.guideExists";
	if (drafting) return "autopilot.sheet.guideDrafting";
	if (guide?.draft === "model") return "autopilot.sheet.guideModel";
	return guide?.draft === "template" ? "autopilot.sheet.guideTemplate" : null;
}

/** A saved ship policy (Settings › Agent behavior › Smart automation), tolerating a missing or hand-edited value. */
function savedPolicy(value: unknown): AutopilotShipPolicy | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<AutopilotShipPolicy>;
	const release = candidate.autoRelease;
	return {
		autoPush: candidate.autoPush === true,
		autoRelease: {
			on: release?.on === true,
			cadence:
				release?.cadence?.kind === "every" && Number.isFinite(release.cadence.n) && release.cadence.n > 0
					? { kind: "every", n: Math.floor(release.cadence.n) }
					: release?.cadence?.kind === "agent"
						? { kind: "agent" }
						: DEFAULT_AUTOPILOT_SETTINGS.ship.autoRelease.cadence,
		},
		remote: typeof candidate.remote === "string" && candidate.remote.trim() ? candidate.remote.trim() : "origin",
	};
}

function cadenceValue(cadence: AutopilotReleaseCadence): string {
	return cadence.kind === "agent" ? "agent" : `every:${cadence.n}`;
}

function parseCadence(value: string): AutopilotReleaseCadence {
	if (value === "agent") return { kind: "agent" };
	const n = Number(value.slice("every:".length));
	return { kind: "every", n: Number.isFinite(n) && n > 0 ? n : DEFAULT_RELEASE_EVERY };
}

interface StartDefaults {
	loaded: boolean;
	policy: AutopilotShipPolicy | null;
	notify: AutopilotNotifyMode | null;
	limits: Record<"tokens" | "minutes" | "cycles" | "usd", string> | null;
}

/** The sheet's starting values: the saved defaults (Settings), else "local only", every ceiling off, notify on stops. */
function useStartDefaults(): StartDefaults {
	const [state, setState] = useState<StartDefaults>({
		loaded: false,
		policy: null,
		notify: null,
		limits: null,
	});
	useEffect(() => {
		let live = true;
		void Promise.all([
			window.omp.prefs.get(AUTOPILOT_SHIP_PREF),
			window.omp.prefs.get(AUTOPILOT_NOTIFY_PREF),
			window.omp.prefs.get(AUTOPILOT_LIMITS_PREF),
		])
			.then(([ship, notify, limits]) => {
				if (!live) return;
				const stored = typeof limits === "object" && limits !== null ? (limits as Record<string, unknown>) : {};
				const text = (key: string) => (typeof stored[key] === "number" ? String(stored[key]) : "");
				setState({
					loaded: true,
					policy: savedPolicy(ship),
					notify: isNotifyMode(notify) ? notify : null,
					limits: { tokens: text("tokens"), minutes: text("minutes"), cycles: text("cycles"), usd: text("usd") },
				});
			})
			.catch(() => live && setState(current => ({ ...current, loaded: true })));
		return () => {
			live = false;
		};
	}, []);
	return state;
}

/** Whether the tab's folder is a git repository (`get_git_status`); null until answered or when it cannot be read. */
function useIsRepo(): boolean | null {
	const rpc = useTabRpc();
	const [isRepo, setIsRepo] = useState<boolean | null>(null);
	useEffect(() => {
		let live = true;
		void rpc
			.getGitStatus()
			.then(response => {
				if (live && response.success)
					setIsRepo((response.data as { isRepo?: boolean } | undefined)?.isRepo ?? null);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [rpc]);
	return isRepo;
}

/** The sentence that says where the run is, with the controls that apply to it. */
function RunSummary({ onOpened }: { onOpened?: () => void }) {
	const t = useT();
	const text = useAutopilotStateText();
	const branch = useAutopilotStore(s => s.status.branch);
	return (
		<div className="flex flex-col gap-3" data-autopilot-run>
			<p className="text-sc-sm text-(--sc-text-muted)">{t("autopilot.sheet.running")}</p>
			<div className="flex min-w-0 flex-col gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-2) px-3 py-2">
				<span className="truncate text-sc-md font-medium" data-autopilot-run-text>
					{text}
				</span>
				{branch && <span className="truncate font-mono text-sc-xs text-(--sc-text-muted)">{branch}</span>}
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				<Button
					data-autopilot-open-screen
					icon={<PanelRight aria-hidden />}
					onClick={() => {
						useUiStore.getState().openAutopilotPanel();
						onOpened?.();
					}}
					size="sm"
					variant="secondary"
				>
					{t("autopilot.chip.open")}
				</Button>
				<AutopilotPauseButton />
				<AutopilotStopButtons />
			</div>
		</div>
	);
}

/**
 * A text box that reads as one line until it is first focused, then stays open at `focusRows` lines (the sheet stays
 * short until the user writes in it). It never collapses on blur: the blur of a press on Start happens at mousedown, so
 * a collapse reflowed the popover under the pointer, the release landed elsewhere and the click never reached Start.
 */
function GrowArea({ focusRows, onFocus, className, ...rest }: TextAreaProps & { focusRows: number }) {
	const [opened, setOpened] = useState(false);
	return (
		<TextArea
			{...rest}
			className={cx("resize-none py-1 text-sc-sm", className)}
			onFocus={event => {
				setOpened(true);
				onFocus?.(event);
			}}
			rows={opened ? focusRows : 1}
		/>
	);
}

/** The release-procedure check: a small glyph, the full sentence in its tooltip and accessible name. */
function ProcedureGlyph({ text, tone }: { text: string; tone: "ok" | "warning" }) {
	const Glyph = tone === "ok" ? CircleCheck : TriangleAlert;
	return (
		<Tooltip content={text} describe={false}>
			<button
				aria-label={text}
				className={cx(
					"inline-flex size-(--sc-icon-md) shrink-0 items-center justify-center rounded-(--sc-radius-sm) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)",
					tone === "ok" ? "text-(--sc-success)" : "text-(--sc-warning)",
				)}
				{...(tone === "ok" ? { "data-autopilot-procedure": true } : { "data-autopilot-no-procedure": true })}
				type="button"
			>
				<Glyph aria-hidden className="size-(--sc-icon-sm)" />
			</button>
		</Tooltip>
	);
}

export function AutopilotModeConfig({ onStarted }: { onStarted?: () => void }) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const live = useAutopilotStore(isLiveAutopilot);
	const detected = useAutopilotStore(s => s.status.ship);
	const guide = useAutopilotStore(s => s.status.guide);
	const rpc = useTabRpc();
	const remote = useTabsStore(s => Boolean(s.tabs.find(tab => tab.id === tabId)?.device));
	const planMode = useSessionStore(s => s.planModeEnabled);
	const hasGoal = useSessionStore(s => s.goal !== null);
	const isRepo = useIsRepo();
	const defaults = useStartDefaults();
	const { run, pending } = useAutopilotActions();

	const [focus, setFocus] = useState<AutopilotArea[]>([]);
	const [preset, setPreset] = useState<AutopilotShipPreset>("local");
	const [cadence, setCadence] = useState<AutopilotReleaseCadence>(DEFAULT_AUTOPILOT_SETTINGS.ship.autoRelease.cadence);
	const [remoteName, setRemoteName] = useState("origin");
	const [parallel, setParallel] = useState(DEFAULT_AUTOPILOT_SETTINGS.maxParallel);
	const [limits, setLimits] = useState({ tokens: "", minutes: "", cycles: "", usd: "" });
	const [notify, setNotify] = useState<AutopilotNotifyMode>(DEFAULT_AUTOPILOT_SETTINGS.notify);
	const [backlog, setBacklog] = useState("");
	const [guideText, setGuideText] = useState("");
	const [guideEdited, setGuideEdited] = useState(false);
	const [drafting, setDrafting] = useState(false);
	const draftAsked = useRef(false);

	// The repo's guide (or the draft the first look asked for) fills the box until the user types in it.
	useEffect(() => {
		if (!guideEdited && guide?.text) setGuideText(guide.text);
	}, [guide, guideEdited]);

	// A repo with no guide gets one drafted, once per sheet: one cheap smol request in the bridge, the template on failure.
	useEffect(() => {
		if (live || remote || isRepo !== true || !guide || guide.exists || guide.text || draftAsked.current) return;
		draftAsked.current = true;
		setDrafting(true);
		void rpc
			.setAutopilot({ action: "guide_draft" })
			.then(response => {
				if (response.success && isIdleStatus(response.data))
					tabAutopilotStore(tabId).getState().apply(response.data);
			})
			.catch(() => {})
			.finally(() => setDrafting(false));
	}, [live, remote, isRepo, guide, rpc, tabId]);

	// The saved defaults seed the sheet once they are read; what the user then changes is theirs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the read lands once.
	useEffect(() => {
		if (!defaults.loaded) return;
		if (defaults.policy) {
			setPreset(presetOfPolicy(defaults.policy));
			setCadence(defaults.policy.autoRelease.cadence);
			setRemoteName(defaults.policy.remote);
		}
		if (defaults.notify) setNotify(defaults.notify);
		if (defaults.limits) setLimits(defaults.limits);
	}, [defaults.loaded]);

	if (live) return <RunSummary onOpened={onStarted} />;
	const guideKey = guideHintKey(guide, drafting);
	const guideHint = guideKey ? t(guideKey) : undefined;

	const block = startBlock({ remote, isRepo, planMode, hasGoal });
	const procedure = detected?.releaseProcedure;
	const releaseUnavailable = !procedure || detected?.releaseBlocked !== undefined;
	const releaseChosen = preset === "release";
	const cleanRemote = remoteName.trim() || "origin";
	const everyChoices =
		cadence.kind === "every" && !EVERY_CHOICES.includes(cadence.n)
			? [...EVERY_CHOICES, cadence.n].sort((a, b) => a - b)
			: EVERY_CHOICES;

	const start = async () => {
		const base = shipPolicyForPreset(preset, cleanRemote);
		const items = backlog
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean);
		const started = await run({
			action: "start",
			focus,
			preset,
			ship: { ...base, autoRelease: { ...base.autoRelease, cadence } },
			limits: limitsFromText(limits),
			maxParallel: parallel,
			notify,
			...(items.length > 0 ? { backlog: items } : {}),
			...(guideText.trim() && guide?.tooLarge !== true ? { guide: guideText } : {}),
		});
		if (started) onStarted?.();
	};

	return (
		<div className="flex flex-col gap-2" data-autopilot-sheet>
			{block && <InlineNotice title={t(`autopilot.sheet.blocked.${block}`)} tone="info" />}

			<fieldset className="settings-section-body min-w-0" disabled={block !== null}>
				<SettingsRow
					badge={<SettingInfo text={t("autopilot.sheet.focusHint", { count: AUTOPILOT_AREAS.length })} />}
					label={t("autopilot.sheet.focus")}
				>
					<FocusChips
						compact
						focus={focus}
						onToggle={area =>
							setFocus(current =>
								current.includes(area) ? current.filter(item => item !== area) : [...current, area],
							)
						}
					/>
				</SettingsRow>

				<SettingsRow
					badge={<SettingInfo text={t(`autopilot.ship.preset.${preset}.desc`)} />}
					compactControl
					control={
						<span className="flex items-center gap-1.5">
							{releaseUnavailable ? (
								<ProcedureGlyph text={t("autopilot.ship.noProcedure")} tone="warning" />
							) : (
								procedure && (
									<ProcedureGlyph
										text={t("autopilot.ship.procedure", {
											file: procedure.file,
											anchors: procedure.anchors.join(" › "),
										})}
										tone="ok"
									/>
								)
							)}
							<Tabs
								activeId={preset}
								ariaLabel={t("autopilot.sheet.ship")}
								compact
								onChange={id => isPreset(id) && setPreset(id)}
								tabs={AUTOPILOT_SHIP_PRESETS.map(id => ({
									id,
									label: t(`autopilot.ship.preset.${id}`),
									disabled: id === "release" && releaseUnavailable,
								}))}
								variant="segmented"
							/>
						</span>
					}
					label={t("autopilot.sheet.ship")}
				/>
				{releaseChosen && (
					<SettingsRow
						compactControl
						control={
							<div className="w-44">
								<Select
									aria-label={t("autopilot.ship.cadence")}
									controlSize="sm"
									onChange={event => setCadence(parseCadence(event.target.value))}
									options={[
										...everyChoices.map(n => ({
											value: `every:${n}`,
											label: t("autopilot.ship.cadenceEvery", { n }),
										})),
										{ value: "agent", label: t("autopilot.ship.cadenceAgent") },
									]}
									value={cadenceValue(cadence)}
								/>
							</div>
						}
						label={t("autopilot.ship.cadence")}
					/>
				)}
				{preset !== "local" && (
					<SettingsRow
						compactControl
						control={
							<div className="w-32">
								<Input
									aria-label={t("autopilot.sheet.remote")}
									controlSize="sm"
									onChange={event => setRemoteName(event.target.value)}
									value={remoteName}
								/>
							</div>
						}
						label={t("autopilot.sheet.remote")}
					/>
				)}

				<SettingsRow
					badge={<SettingInfo text={t("autopilot.sheet.parallelHint")} />}
					compactControl
					control={
						<div className="w-16">
							<Select
								aria-label={t("autopilot.sheet.parallel")}
								controlSize="sm"
								onChange={event => setParallel(Number(event.target.value))}
								options={PARALLEL_CHOICES.map(n => ({ value: String(n), label: String(n) }))}
								value={String(parallel)}
							/>
						</div>
					}
					label={t("autopilot.sheet.parallel")}
				/>
				<SettingsRow
					compactControl
					control={
						<div className="w-40">
							<Select
								aria-label={t("autopilot.sheet.notify")}
								controlSize="sm"
								onChange={event => isNotifyMode(event.target.value) && setNotify(event.target.value)}
								options={AUTOPILOT_NOTIFY_MODES.map(mode => ({
									value: mode,
									label: t(`autopilot.notify.${mode}`),
								}))}
								value={notify}
							/>
						</div>
					}
					label={t("autopilot.sheet.notify")}
				/>
				<SettingsRow
					badge={<SettingInfo text={t("autopilot.sheet.backlogHint")} />}
					compactControl
					control={
						<div className="w-44">
							<GrowArea
								aria-label={t("autopilot.sheet.backlog")}
								focusRows={4}
								onChange={event => setBacklog(event.target.value)}
								placeholder={t("autopilot.sheet.backlogPlaceholder")}
								value={backlog}
							/>
						</div>
					}
					label={t("autopilot.sheet.backlog")}
				/>
				<SettingsRow
					badge={guideHint ? <SettingInfo text={guideHint} /> : undefined}
					label={t("autopilot.sheet.guide")}
				>
					<GrowArea
						aria-label={t("autopilot.sheet.guide")}
						data-autopilot-guide
						disabled={guide?.tooLarge === true}
						focusRows={8}
						mono
						onChange={event => {
							setGuideEdited(true);
							setGuideText(event.target.value);
						}}
						placeholder={t("autopilot.sheet.guidePlaceholder")}
						value={guideText}
					/>
				</SettingsRow>
				<details className="group py-1" data-autopilot-limits data-setting-row="true">
					<summary className="flex min-h-(--sc-control-md) cursor-pointer list-none items-center gap-1.5 text-sc-md font-medium text-(--sc-text) hover:text-(--sc-text) [&::-webkit-details-marker]:hidden">
						<ChevronRight
							aria-hidden
							className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted) transition-transform duration-(--sc-duration-fast) group-open:rotate-90 motion-reduce:transition-none"
						/>
						{t("autopilot.sheet.limits")}
					</summary>
					<div className="grid grid-cols-2 gap-2 pb-1">
						<p className="col-span-2 text-sc-xs text-(--sc-text-muted)">{t("autopilot.sheet.limitsHint")}</p>
						{(["tokens", "minutes", "cycles", "usd"] as const).map(key => (
							<Input
								controlSize="sm"
								key={key}
								label={t(`autopilot.limit.${key}`)}
								min={0}
								onChange={event => setLimits(current => ({ ...current, [key]: event.target.value }))}
								placeholder={t("autopilot.limit.off")}
								type="number"
								value={limits[key]}
							/>
						))}
					</div>
				</details>
			</fieldset>

			<div className="flex items-center gap-2 border-t border-(--sc-divider) pt-2">
				<span
					className="flex min-w-0 flex-1 items-center gap-1 text-sc-xs text-(--sc-warning)"
					data-autopilot-warning
				>
					<TriangleAlert aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="truncate">{t("autopilot.sheet.warningShort")}</span>
					<SettingInfo
						text={`${t("input.approval.yolo")} — ${t("input.approval.yoloConfirmBody")} ${t("autopilot.sheet.worktreeNote")}`}
					/>
				</span>
				<Tooltip content={t("autopilot.sheet.desc")} describe={false}>
					<Button
						data-autopilot-start
						disabled={block !== null || pending !== null}
						icon={<Rocket aria-hidden />}
						loading={pending === "start"}
						onClick={() => void start()}
						size="sm"
						variant="primary"
					>
						{t("autopilot.sheet.start")}
					</Button>
				</Tooltip>
			</div>
		</div>
	);
}
