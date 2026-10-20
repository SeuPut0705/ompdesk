/**
 * The Autopilot tab of the Mode popover: the start sheet while no run is live, the run's summary and controls while
 * one is. Starting always opens a new worktree tab on a new `autopilot/<date>` branch cut from the folder's own branch
 * (the Branch row shows that branch, nothing else) and runs there with every tool approved, so this sheet is where the
 * user consents to that (it replaces the full-access confirmation).
 */

import { CircleCheck, GitBranch, PanelRight, Rocket, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	AUTOPILOT_AREAS,
	AUTOPILOT_SHIP_PRESETS,
	type AutopilotArea,
	type AutopilotGuideInfo,
	type AutopilotShipPreset,
	type AutopilotStatus,
} from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { isLiveAutopilot, tabAutopilotStore, useAutopilotStore } from "../../stores/autopilot";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { Button, InlineNotice, SettingInfo, Tabs, TextArea, type TextAreaProps, Tooltip } from "../common";
import { FocusChips } from "../panels/autopilot/AreaMix";
import { useAutopilotStateText } from "../panels/autopilot/AutopilotBoardCard";
import { AutopilotPauseButton, AutopilotStopButtons } from "../panels/autopilot/AutopilotControls";
import { useAutopilotActions } from "../panels/autopilot/use-autopilot-actions";
import { SettingsAdvanced, SettingsRow } from "../settings/SettingsLayout";

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
	const branches = useAutopilotStore(s => s.status.branches);
	const { run, pending } = useAutopilotActions();

	const [focus, setFocus] = useState<AutopilotArea[]>([]);
	const [preset, setPreset] = useState<ShipChoice>(AUTO);
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

	// The folder's branch is git's state now (the status the tab hydrated with may be hours old): read it again when the sheet opens.
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

					{branches?.current && (
						<SettingsRow
							badge={<SettingInfo text={t("autopilot.branch.hintNew", { remote: branches.remote })} />}
							compactControl
							control={
								<span
									className="flex min-w-0 max-w-48 items-center gap-1 text-sc-sm text-(--sc-text-muted)"
									data-autopilot-branch
								>
									<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0" />
									<span className="truncate font-mono">{branches.current}</span>
								</span>
							}
							label={t("autopilot.sheet.branch")}
						/>
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
