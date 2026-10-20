/**
 * The composer's toolbar row: + (attach, photos, history, expand, goal, skills), the Run chip (modes, thinking,
 * approval, delegation) and its conditional extras, the `!`/`$` and queue badges, the Steer/Follow-up chip while a turn
 * runs (it takes the free room before the send cluster, so it appearing moves nothing), then the send cluster: the
 * model chip (`Model · Thinking`), the context ring, mic, and ONE action button. Send and Stop share that button
 * (`send-slot.ts`): Stop while a turn runs with an empty draft, Send otherwise; nothing is reserved beside it, and a
 * state change swaps its icon and name in the same box. While a turn runs and the button is Send, a long press (touch)
 * or right click opens a one-item menu whose Stop keeps the draft, and a small ■ on the button says so; Esc still stops
 * from the keyboard (double Esc with a draft). Label levels fold by the toolbar's own width (components.css
 * `omp-toolbar` container), never by the window's.
 *
 * On a phone the composer is always open: the field is a full-width row and this toolbar is one compact row under it,
 * inside the box, with every control the tablet has (+, the Run chip for mode, thinking, approval and delegation, the
 * model chip, the context ring, Send/Stop), labels folded to icons by the toolbar's width and any overflow scrolling
 * sideways inside the row (mobile.css); nothing folds the composer away. The idle, empty button is the mic while
 * dictation is on (while Stop holds the button the mic moves into the row). Touch controls keep focus in the field
 * (`keepFocus`: a cancelled `mousedown`, never `pointerdown`). Memoised: its props are scalars and stable callbacks,
 * so a keystroke in the field re-renders it only when what it shows changes.
 */
import {
	ArrowUp,
	Check,
	ChevronDown,
	CornerDownRight,
	Cpu,
	History,
	ListPlus,
	Mic,
	MicOff,
	Paperclip,
	Plus,
	Sparkles,
	Square,
} from "lucide-react";
import { type ChangeEvent, type MouseEvent, memo, type ReactNode, type RefObject, useId, useState } from "react";
import { useShellMode } from "../../../hooks/use-shell-mode";
import { useT } from "../../../lib/i18n";
import type { ComposerInputMode } from "../../../lib/input-modes";
import { actionKbd, composerFollowUpChord, formatShortcut } from "../../../lib/keymap";
import { useComposerStore } from "../../../stores/composer";
import { useFirstRunStore } from "../../../stores/first-run";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useSettingsStore } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";
import {
	anchorFromEvent,
	Badge,
	Button,
	ContextMenu,
	type ContextMenuAnchor,
	IconButton,
	MenuButton,
	Tooltip,
} from "../../common";
import { ProviderMark } from "../../settings/providers/ProviderMark";
import { chipModelName } from "../../settings/providers/provider-marks";
import { ComposerSend } from "./ComposerLive";
import { ComposerModeExtras } from "./ComposerModes";
import { ContextUsagePopover } from "./ContextUsagePopover";
import type { DictationPhase } from "./DictationOverlay";
import { keepFocus } from "./keep-focus";
import { RunChip } from "./RunChip";
import { useThinkingName } from "./RunSettings";
import { sendSlot } from "./send-slot";
import { useThinkingSelector } from "./ThinkingControl";

/** Settings row of the stock `stt.enabled` switch; the + menu's Dictation item opens it while dictation is off (stock owns the setting, nothing here writes it). */
const STT_SETTING_TARGET = "agent:setting-stt.enabled";

export interface ComposerToolbarProps {
	/** The tab's route exists: without it the row is inert and busy. */
	routeReady: boolean;
	/** Touch input: no shortcut hints, and the + menu keeps the field's focus. */
	touchInput: boolean;
	/** Open the file chooser for any file (a phone's chooser also offers its photo library and camera). */
	onOpenFilePicker: () => void;
	fileInputRef: RefObject<HTMLInputElement | null>;
	onFilesPicked: (event: ChangeEvent<HTMLInputElement>) => void;
	onOpenHistory: () => void;
	onOpenSkills: () => void;
	/** The draft's `!` (bash) / `$` (python) mode, if any. */
	composerMode: ComposerInputMode | undefined;
	/** The draft is a `->` / `=>` queue shorthand; `queueSplitCount` > 1 when it splits into that many messages. */
	queued: boolean;
	queueSplitCount: number;
	/** The `!!` / `$$` form: kept out of the model context. */
	composerExcluded?: boolean;
	dictationPhase: DictationPhase;
	onMic: () => void;
	onStopAndSend: () => void;
	/** The steer/follow-up chip says Follow-up. */
	followUp: boolean;
	onToggleSendMode: () => void;
	/** Something Stop ends: the run, or a prompt not yet sent. */
	stoppable: boolean;
	/** The draft holds text or a picture: while a turn runs the button is Send, else Stop. */
	hasDraft: boolean;
	sendDisabled: boolean;
	/** Which control stopped: the button itself, or its right-click / long-press menu. */
	onStop: (surface: "stop-button" | "send-menu") => void;
	onSend: () => void;
	/** The queue pill (QueueImpl): rendered before the action button; `null` when nothing is queued, so it reserves no width. */
	queueSlot?: ReactNode;
	/** A queued message is being edited: Send saves it (a check) and the lane chip steps aside (QueueImpl). */
	editingQueued?: boolean;
}

export const ComposerToolbar = memo(function ComposerToolbar({
	routeReady,
	touchInput,
	onOpenFilePicker,
	fileInputRef,
	onFilesPicked,
	onOpenHistory,
	onOpenSkills,
	composerMode,
	composerExcluded,
	queued,
	queueSplitCount,
	dictationPhase,
	onMic,
	onStopAndSend,
	followUp,
	onToggleSendMode,
	stoppable,
	hasDraft,
	sendDisabled,
	onStop,
	onSend,
	queueSlot,
	editingQueued = false,
}: ComposerToolbarProps) {
	const t = useT();
	const isStreaming = useSessionStore(s => s.isStreaming);
	const model = useModelStore(s => s.model);
	const settingUp = useFirstRunStore(s => s.phase !== "idle");
	const openModelPicker = useUiStore(s => s.openModelPicker);
	/** Agent `stt.enabled` setting: microphone dictation button in the composer. */
	const sttEnabled = useSettingsStore(s => s.sttEnabled);
	/** Phone: model, mode, approval, delegation and context live in the ⋯ sheet inside the box (`ComposerRunMenu`). */
	const phone = useShellMode() === "phone";
	/** Touch presses keep focus in the field: a tap on a control never closes the soft keyboard. */
	const hold = touchInput ? keepFocus : undefined;
	const recording = dictationPhase !== "idle";
	const modeLabel = followUp ? t("input.followUp") : t("input.steer");
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const stopping = useComposerStore(s => s.stopping);
	const thinkingName = useThinkingName();
	const supportsThinking = useModelStore(s => s.availableThinkingLevels.length > 0);
	// While first-run setup runs, the live model is whatever omp fell back to
	// (e.g. a tiny on-device model); show the neutral prompt instead.
	const modelLabel = model && !settingUp ? model.name || model.id : t("input.chooseModel");
	// The chip beside the provider's mark leaves the brand word out ("Claude Opus 5.5" → "Opus 5.5") and names Auto
	// alone, not the effort Auto picked; the tooltip, the accessible name and the picker keep both in full.
	const chipLabel =
		model && !settingUp ? chipModelName({ id: model.provider, name: model.provider }, modelLabel) : modelLabel;
	const thinking = useThinkingSelector();
	const chipThinking = thinking === "auto" && supportsThinking ? t("input.thinking.name.auto") : thinkingName;
	const slot = sendSlot({
		recording: dictationPhase === "recording",
		editingQueued,
		stoppable,
		hasDraft,
		micOffered: phone && sttEnabled && !recording,
	});
	const stopHintId = useId();
	/** The long press / right click menu of the button while a turn runs, at the pointer (a bottom sheet on touch). */
	const [stopMenu, setStopMenu] = useState<ContextMenuAnchor | null>(null);
	const openStopMenu = slot.stopHint
		? (event: MouseEvent<HTMLElement>) => setStopMenu(anchorFromEvent(event))
		: undefined;
	// The menu belongs to this turn: once Stop is not offered (the turn ended, the draft emptied) it is gone for good,
	// never reopening on the next turn's draft.
	if (stopMenu && !slot.stopHint) setStopMenu(null);
	/** What a long press or right click offers while the button is not Stop: the button is named, and wears a small ■. */
	const stopHintProps = slot.stopHint ? { "aria-describedby": stopHintId, onContextMenu: openStopMenu } : {};
	const withStopHint = (glyph: ReactNode) =>
		slot.stopHint ? (
			<>
				{glyph}
				<span aria-hidden className="omp-send-stop-hint" data-send-stop-hint />
			</>
		) : (
			glyph
		);
	// The button's tooltip names the lane a running turn sends into and the chord of the other one; on the desktop it
	// also says how to stop without losing the draft.
	const laneTip = followUp
		? t("input.send.tipFollowUp")
		: t("input.send.tipSteer", { chord: formatShortcut(composerFollowUpChord()) });
	const sendTip = !isStreaming
		? t("input.send")
		: slot.stopHint && !touchInput
			? `${laneTip} · ${t("input.send.stopHintDesktop")}`
			: laneTip;
	/** Dictation: the desktop button, or on a phone the empty button's mic (1 tap); while Stop holds the button, the row. */
	const micAtOldSpot = sttEnabled && (!phone || recording || slot.state === "stop");
	const stopState = slot.state === "stop";

	/** The queue pill and the one action button. A phone keeps them outside the row's sideways scroller, so they never move or scroll away. */
	const actions = (
		<div className="omp-composer-actions ml-1 flex items-center gap-1.5">
			{queueSlot}
			<span className="inline-flex items-center" data-slot="send">
				{slot.state === "mic" ? (
					<IconButton
						{...hold}
						className="omp-composer-action omp-composer-mic"
						disabled={!routeReady}
						icon={<Mic />}
						label={t("voice.mic.start")}
						onClick={onMic}
						variant="secondary"
					/>
				) : slot.state === "dictation" ? (
					<IconButton
						{...hold}
						{...stopHintProps}
						className="omp-composer-action relative"
						data-dictation-send
						disabled={!routeReady}
						icon={withStopHint(<ArrowUp strokeWidth={2.25} />)}
						label={t("voice.dictation.stopAndSend")}
						onClick={onStopAndSend}
						variant="primary"
					/>
				) : (
					<ComposerSend
						cue={!stopState}
						label={stopState ? t("input.abort") : slot.state === "save" ? t("composerQueue.editSave") : sendTip}
						shortcut={stopState ? "Esc" : isStreaming || touchInput ? undefined : "↵"}
					>
						<IconButton
							{...hold}
							{...stopHintProps}
							className="omp-composer-action relative"
							data-send-editing={slot.state === "save" || undefined}
							data-send-lane={isStreaming && !stopState ? (followUp ? "followUp" : "steer") : undefined}
							data-send-state={slot.state}
							disabled={stopState ? !routeReady : sendDisabled}
							icon={
								stopState ? (
									<Square className="omp-composer-stop-glyph" fill="currentColor" />
								) : (
									withStopHint(
										slot.state === "save" ? <Check strokeWidth={2.25} /> : <ArrowUp strokeWidth={2.25} />,
									)
								)
							}
							label={
								stopState
									? t("input.abort")
									: slot.state === "save"
										? t("composerQueue.editSave")
										: t("input.send")
							}
							loading={stopState && stopping}
							onClick={stopState ? () => onStop("stop-button") : onSend}
							tooltip={false}
							variant="primary"
						/>
					</ComposerSend>
				)}
			</span>
			{slot.stopHint && (
				<span className="sr-only" id={stopHintId}>
					{touchInput ? t("input.send.stopHintTouch") : t("input.send.stopHintDesktop")}
				</span>
			)}
			{stopMenu && (
				<ContextMenu
					align="end"
					ariaLabel={t("input.stopMenu")}
					items={[
						{
							id: "stop",
							label: t("input.abort"),
							description: t("input.stopKeepsDraft"),
							icon: Square,
							onSelect: () => {
								setStopMenu(null);
								onStop("send-menu");
							},
						},
					]}
					keepFocus={touchInput}
					onClose={() => setStopMenu(null)}
					side="above"
					above={stopMenu.y}
					x={stopMenu.x}
					y={stopMenu.y}
				/>
			)}
		</div>
	);
	/** Everything before Stop/Send: the whole row on the desktop, the sideways scroller on a phone. */
	const lead = (
		<>
			<MenuButton
				keepFocus={touchInput}
				icon={<Plus />}
				items={[
					// One item for every kind of file: with no `accept` filter a phone offers its photo library, camera and files
					// in one chooser.
					{
						id: "attach",
						label: t("input.attach"),
						icon: Paperclip,
						onSelect: () => onOpenFilePicker(),
					},
					{
						id: "history",
						label: t("input.history.title"),
						description: t("input.history.menuDesc"),
						icon: History,
						shortcut: "⌃R",
						onSelect: onOpenHistory,
					},
					...(sttEnabled
						? []
						: [
								{
									id: "dictation",
									label: t("voice.menu.off"),
									description: t("voice.menu.offDesc"),
									icon: Mic,
									onSelect: () => useUiStore.getState().openSettings(STT_SETTING_TARGET),
								},
							]),
					{
						id: "skills",
						label: t("input.addMenu.skills"),
						icon: Sparkles,
						separatorBefore: true,
						onSelect: onOpenSkills,
					},
				]}
				label={t("input.addMenu")}
				side="above"
				size={phone ? "md" : "sm"}
			/>
			<input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFilesPicked} />

			<RunChip />
			<ComposerModeExtras />

			{composerMode && (
				<Tooltip content={composerMode === "bash" ? t("input.mode.bash.title") : t("input.mode.python.title")}>
					<span className="omp-composer-badge inline-flex min-w-0">
						<Badge className="min-w-0 shrink!" variant={composerMode === "bash" ? "info" : "warning"}>
							<span className="truncate">
								{composerMode === "bash"
									? t(composerExcluded ? "input.mode.bash.badgeExcluded" : "input.mode.bash.badge")
									: t(composerExcluded ? "input.mode.python.badgeExcluded" : "input.mode.python.badge")}
							</span>
						</Badge>
					</span>
				</Tooltip>
			)}
			{queued && (
				<Tooltip content={t("input.queue.title")}>
					<span className="omp-composer-badge inline-flex min-w-0">
						<Badge className="min-w-0 shrink!" variant="warning">
							<span className="truncate">
								{queueSplitCount > 1
									? t("input.queue.badgeSplit", { count: queueSplitCount })
									: stoppable
										? t("input.queue.badge")
										: t("input.queue.badgeIdle")}
							</span>
						</Badge>
					</span>
				</Tooltip>
			)}
			{/* While a turn runs: the lane Send goes to. It takes the free room before the send cluster, so it appearing
			    moves nothing and nothing waits for it while idle. */}
			{isStreaming && !editingQueued && (
				<Tooltip content={t("input.sendModeHint")} shortcut={followUp ? undefined : composerFollowUpChord()}>
					<Button
						{...hold}
						aria-label={t("input.sendModeLabel", { mode: modeLabel })}
						className="omp-composer-chip omp-composer-fold-1"
						data-send-mode={followUp ? "followUp" : "steer"}
						disabled={!routeReady}
						icon={followUp ? <ListPlus aria-hidden /> : <CornerDownRight aria-hidden />}
						onClick={onToggleSendMode}
						size="sm"
						variant="ghost"
					>
						<span className="omp-composer-control-label">{modeLabel}</span>
					</Button>
				</Tooltip>
			)}

			<div className="flex-1" />

			<div className="omp-composer-send-cluster flex shrink-0 items-center gap-1">
				<Tooltip
					content={
						model
							? settingUp
								? t("input.modelTooltip", { id: model.id })
								: t("input.modelTooltipThinking", { name: modelLabel, id: model.id, level: thinkingName })
							: t("input.model")
					}
					shortcut={actionKbd("model.select", keymapOverrides)}
				>
					<Button
						aria-label={
							model && !settingUp
								? t("input.modelLabelThinking", { model: modelLabel, level: thinkingName })
								: t("input.modelLabel", { model: modelLabel })
						}
						className="omp-composer-chip omp-composer-fold-4 min-w-0 max-w-64"
						data-model-chip
						icon={
							model && !settingUp ? (
								<ProviderMark
									className="size-(--sc-icon-md)"
									provider={{ id: model.provider, name: model.provider }}
								/>
							) : (
								<Cpu aria-hidden />
							)
						}
						onClick={() => openModelPicker()}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />}
						variant="ghost"
					>
						<span className="omp-composer-model-label truncate">{chipLabel}</span>
						{model && !settingUp && (
							<span className="omp-composer-effort shrink-0 font-normal text-(--sc-text-muted)">
								· {chipThinking}
							</span>
						)}
					</Button>
				</Tooltip>
				{!settingUp && <ContextUsagePopover variant={phone ? "sheet" : "ring"} />}
				{micAtOldSpot && (
					<IconButton
						{...hold}
						className="omp-composer-mic"
						data-recording={recording ? "" : undefined}
						icon={
							recording ? (
								// While a turn runs a second filled square would read as another Stop.
								isStreaming ? (
									<MicOff />
								) : (
									<Square className="omp-pulse-dot" fill="currentColor" />
								)
							) : (
								<Mic />
							)
						}
						label={recording ? t("voice.mic.stop") : t("voice.mic.start")}
						onClick={onMic}
						size="sm"
					/>
				)}
				{!phone && actions}
			</div>
		</>
	);

	return (
		<div
			aria-busy={!routeReady}
			aria-label={t("input.toolbar")}
			className="omp-composer-toolbar flex min-h-11 flex-nowrap items-center gap-1 pr-2.5 pb-2.5 pl-2"
			inert={!routeReady}
			role="toolbar"
		>
			{phone ? (
				<>
					<div className="omp-composer-scroll">{lead}</div>
					{actions}
				</>
			) : (
				lead
			)}
		</div>
	);
});
