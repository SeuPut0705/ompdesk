/**
 * The Autopilot tab of the Mode popover: the start sheet while no run is live, the run's summary and controls while
 * one is. Starting always opens a new worktree tab on the branch the Branch row picks (a new `autopilot/<date>` by
 * default, an existing branch no other worktree has, or the default branch with a warning) and runs there with every tool
 * approved, so this sheet is where the user consents to that (it replaces the full-access confirmation).
 */

import { CircleCheck, PanelRight, Rocket, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	AUTOPILOT_AREAS,
	AUTOPILOT_BRANCH_PREF,
	AUTOPILOT_SHIP_PREF,
	AUTOPILOT_SHIP_PRESETS,
	type AutopilotArea,
	type AutopilotBranchChoice,
	type AutopilotBranchEntry,
	type AutopilotGuideInfo,
	type AutopilotShipPolicy,
	type AutopilotShipPreset,
	type AutopilotStatus,
	DEFAULT_AUTOPILOT_SETTINGS,
} from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { branchProblem, initialChoice, isDefaultBranchChoice, viaWorkBranch } from "../../../shared/autopilot-branch";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { isLiveAutopilot, tabAutopilotStore, useAutopilotStore } from "../../stores/autopilot";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
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
import { presetOfPolicy } from "../panels/autopilot/autopilot-view";
import { useAutopilotActions } from "../panels/autopilot/use-autopilot-actions";
import { SettingsAdvanced, SettingsRow } from "../settings/SettingsLayout";

/** The picker's value for "a new branch"; an existing branch's value is `EXISTING_PREFIX` + its name. */
const NEW_BRANCH = "new";
const EXISTING_PREFIX = "branch:";

/** One picker row: the name, what it is (default, remote only) and why it cannot be taken. */
function branchLabel(
	entry: AutopilotBranchEntry,
	t: (key: string, params?: Record<string, string | number>) => string,
): string {
	const notes: string[] = [];
	if (entry.default) notes.push(t("autopilot.branch.default"));
	if (!entry.local) notes.push(t("autopilot.branch.remoteOnly"));
	if (entry.checkedOutAt) notes.push(t("autopilot.branch.viaWork"));
	return notes.length > 0 ? `${entry.name} · ${notes.join(" · ")}` : entry.name;
}

/** Remember the choice per repository for the next sheet (never part of `autopilotShip`: the branch is per run). */
async function rememberChoice(repo: string, choice: AutopilotBranchChoice): Promise<void> {
	try {
		const stored = await window.omp.prefs.get(AUTOPILOT_BRANCH_PREF);
		const all = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {};
		await window.omp.prefs.set(AUTOPILOT_BRANCH_PREF, { ...all, [repo]: choice });
	} catch {
		// The choice is only a convenience for the next sheet.
	}
}

/** The sheet's shipping choice: a preset, or `auto` (main decides from the repository; nothing is sent). */
const AUTO = "auto";
type ShipChoice = AutopilotShipPreset | typeof AUTO;

function isShipChoice(value: unknown): value is ShipChoice {
	return value === AUTO || (AUTOPILOT_SHIP_PRESETS as readonly unknown[]).includes(value);
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

/** The shipping level Settings stored, else Automatic; `loaded` once the read landed. */
function useStoredShip(): { loaded: boolean; choice: ShipChoice } {
	const [state, setState] = useState<{ loaded: boolean; choice: ShipChoice }>({ loaded: false, choice: AUTO });
	useEffect(() => {
		let live = true;
		void window.omp.prefs
			.get(AUTOPILOT_SHIP_PREF)
			.then(ship => {
				const policy = savedPolicy(ship);
				if (live) setState({ loaded: true, choice: policy ? presetOfPolicy(policy) : AUTO });
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
	const isRepo = useIsRepo();
	const storedShip = useStoredShip();
	const branches = useAutopilotStore(s => s.status.branches);
	const { run, pending } = useAutopilotActions();

	const [focus, setFocus] = useState<AutopilotArea[]>([]);
	const [preset, setPreset] = useState<ShipChoice>(AUTO);
	const [backlog, setBacklog] = useState("");
	const [guideText, setGuideText] = useState("");
	const [guideEdited, setGuideEdited] = useState(false);
	const [drafting, setDrafting] = useState(false);
	const draftAsked = useRef(false);
	const [branchSel, setBranchSel] = useState(NEW_BRANCH);
	// null: the user has not typed a name, so the field follows the suggestion (`autopilot/<date>`).
	const [branchName, setBranchName] = useState<string | null>(null);
	const seededRepo = useRef<string | null>(null);

	// The repo's guide (or the draft the first look asked for) fills the box until the user types in it.
	useEffect(() => {
		if (!guideEdited && guide?.text) setGuideText(guide.text);
	}, [guide, guideEdited]);

	// A repo with no guide gets one drafted, once per sheet: one cheap smol request in the bridge, the template on failure.
	useEffect(() => {
		if (live || isRepo !== true || !guide || guide.exists || guide.text || draftAsked.current) return;
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
	}, [live, isRepo, guide, rpc, tabId]);

	// The shipping level Settings stored seeds the sheet once it is read; what the user then picks is theirs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the read lands once.
	useEffect(() => {
		if (storedShip.loaded) setPreset(storedShip.choice);
	}, [storedShip.loaded]);

	// The branch list is git's state now (the status the tab hydrated with may be hours old): read it again when the sheet opens.
	useEffect(() => {
		if (live || isRepo !== true) return;
		let current = true;
		try {
			void Promise.resolve(rpc.getAutopilot())
				.then(response => {
					if (!current || !response.success || !isIdleStatus(response.data) || !response.data.branches) return;
					const store = tabAutopilotStore(tabId).getState();
					if (!store.status.active) store.apply({ ...store.status, branches: response.data.branches });
				})
				.catch(() => {});
		} catch {
			// A client without the read keeps the status it has.
		}
		return () => {
			current = false;
		};
	}, [live, isRepo, rpc, tabId]);

	// The remembered choice (or a new branch) seeds the picker once per repository; what the user then picks is theirs.
	useEffect(() => {
		if (!branches || seededRepo.current === branches.repo) return;
		seededRepo.current = branches.repo;
		const initial = initialChoice(branches.last, branches.branches);
		setBranchSel(initial.kind === "existing" ? `${EXISTING_PREFIX}${initial.name}` : NEW_BRANCH);
		setBranchName(initial.kind === "new" && initial.name ? initial.name : null);
	}, [branches]);

	if (live) return <RunSummary onOpened={onStarted} />;
	const guideKey = guideHintKey(guide, drafting);
	const guideHint = guideKey ? t(guideKey) : undefined;

	const block = isRepo === false ? "notRepo" : null;
	const procedure = detected?.releaseProcedure;
	const releaseUnavailable = !procedure || detected?.releaseBlocked !== undefined;
	const shipNote =
		preset === AUTO
			? branches?.remote
				? t("autopilot.ship.preset.auto.descRemote", { remote: branches.remote })
				: t("autopilot.ship.preset.auto.desc")
			: t(`autopilot.ship.preset.${preset}.desc`);

	// The choice this sheet would send: a new branch (named only when the user changed the suggestion) or an existing one.
	const pickedBranch = branchSel.startsWith(EXISTING_PREFIX) ? branchSel.slice(EXISTING_PREFIX.length) : "";
	const shownName = branchName ?? branches?.suggested ?? "";
	const typedName = shownName.trim();
	const choice: AutopilotBranchChoice =
		pickedBranch !== ""
			? { kind: "existing", name: pickedBranch }
			: typedName !== "" && typedName !== branches?.suggested
				? { kind: "new", name: typedName }
				: { kind: "new" };
	const problem = branches ? branchProblem(choice, branches.branches) : null;
	const branchBlocked = problem !== null;
	const branchProblemText = problem
		? problem.code === "invalid_name"
			? t("autopilot.branch.invalid")
			: problem.code === "exists"
				? t("autopilot.branch.exists")
				: null
		: null;
	const onDefaultBranch = branches ? isDefaultBranchChoice(choice, branches.branches) : false;
	const viaTarget = branches ? viaWorkBranch(choice, branches.branches) !== null : false;
	const start = async () => {
		const items = backlog
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean);
		// Only what the user chose is sent: main decides the rest (shipping from the repository, fan-out, notifications).
		const started = await run({
			action: "start",
			...(focus.length > 0 ? { focus } : {}),
			...(preset !== AUTO ? { preset } : {}),
			...(branches ? { branch: choice } : {}),
			...(items.length > 0 ? { backlog: items } : {}),
			...(guideText.trim() && guide?.tooLarge !== true ? { guide: guideText } : {}),
		});
		if (started && branches) await rememberChoice(branches.repo, choice);
		if (started) onStarted?.();
	};

	return (
		<div className="flex flex-col gap-2" data-autopilot-sheet>
			{block && <InlineNotice title={t(`autopilot.sheet.blocked.${block}`)} tone="info" />}

			<fieldset className="settings-section-body min-w-0" disabled={block !== null}>
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

				<SettingsAdvanced>
					<SettingsRow
						badge={<SettingInfo text={shipNote} />}
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
									onChange={id => isShipChoice(id) && setPreset(id)}
									tabs={[AUTO, ...AUTOPILOT_SHIP_PRESETS].map(id => ({
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

					{branches && (
						<>
							<SettingsRow
								badge={
									<SettingInfo
										text={
											branchSel === NEW_BRANCH
												? t("autopilot.branch.hintNew", { remote: branches.remote })
												: t("autopilot.branch.hintExisting", { remote: branches.remote })
										}
									/>
								}
								compactControl
								control={
									<div className="w-48" data-autopilot-branch>
										<Select
											aria-label={t("autopilot.sheet.branch")}
											controlSize="sm"
											onChange={event => setBranchSel(event.target.value)}
											options={[
												{ value: NEW_BRANCH, label: t("autopilot.branch.new") },
												...branches.branches.map(entry => ({
													value: `${EXISTING_PREFIX}${entry.name}`,
													label: branchLabel(entry, t),
												})),
											]}
											value={branchSel}
										/>
									</div>
								}
								label={t("autopilot.sheet.branch")}
							/>
							{branchSel === NEW_BRANCH && (
								<SettingsRow
									compactControl
									control={
										<div className="w-48">
											<Input
												aria-label={t("autopilot.branch.name")}
												controlSize="sm"
												data-autopilot-branch-name
												error={branchProblemText ?? undefined}
												onChange={event => setBranchName(event.target.value)}
												value={shownName}
											/>
										</div>
									}
									label={t("autopilot.branch.name")}
								/>
							)}
							{onDefaultBranch && (
								<span
									className="flex items-center gap-1 pb-1 text-sc-xs text-(--sc-warning)"
									data-autopilot-branch-warning
								>
									<TriangleAlert aria-hidden className="size-(--sc-icon-sm) shrink-0" />
									<span>{t("autopilot.branch.defaultWarning", { branch: pickedBranch })}</span>
								</span>
							)}
							{viaTarget && (
								<span
									className="flex items-center gap-1 pb-1 text-sc-xs text-(--sc-text-muted)"
									data-autopilot-branch-via
								>
									<span className="truncate">
										{t("autopilot.branch.viaLine", { work: branches.suggested, target: pickedBranch })}
									</span>
								</span>
							)}
						</>
					)}
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
				</SettingsAdvanced>
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
						disabled={block !== null || pending !== null || branchBlocked}
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
