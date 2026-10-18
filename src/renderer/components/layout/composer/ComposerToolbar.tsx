/**
 * The composer's toolbar row: + (attach, photos, history, expand, goal, skills), ⋯ on a phone, the Run chip (modes,
 * thinking, approval, delegation) and its conditional extras, the `!`/`$` and queue badges, then the send cluster:
 * the model chip (`Model · Thinking`), the context ring, mic, and the Steer/Follow-up chip, Stop and Send in
 * RESERVED slots. A slot never unmounts: while off it is `inert` and `visibility: hidden`, so a turn starting or
 * ending, or a draft appearing, moves nothing (Stop left, Send right). Label levels fold by the toolbar's own
 * width (components.css `omp-toolbar` container), never by the window's. Memoised: its props are scalars and
 * stable callbacks, so a keystroke in the field re-renders it only when what it shows changes.
 */
import {
	ArrowUp,
	Check,
	ChevronDown,
	CornerDownRight,
	Cpu,
	Ellipsis,
	History,
	ImageIcon,
	ListPlus,
	Maximize2,
	Mic,
	MicOff,
	Minimize2,
	Paperclip,
	Plus,
	Sparkles,
	Square,
	Target,
} from "lucide-react";
import { type ChangeEvent, memo, type ReactNode, type RefObject, useState } from "react";
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
import { Badge, Button, IconButton, MenuButton, Tooltip } from "../../common";
import { ComposerSend } from "./ComposerLive";
import { ComposerModeExtras } from "./ComposerModes";
import { ContextUsagePopover } from "./ContextUsagePopover";
import type { DictationPhase } from "./DictationOverlay";
import { RunChip } from "./RunChip";
import { useThinkingName } from "./RunSettings";

export interface ComposerToolbarProps {
	/** The tab's route exists: without it the row is inert and busy. */
	routeReady: boolean;
	/** Touch input: the + menu also offers Photos. */
	touchInput: boolean;
	expanded: boolean;
	onToggleExpanded: () => void;
	/** Open the file chooser (`accept`: what it offers; none = any file). */
	onOpenFilePicker: (accept?: string) => void;
	fileInputRef: RefObject<HTMLInputElement | null>;
	onFilesPicked: (event: ChangeEvent<HTMLInputElement>) => void;
	onOpenHistory: () => void;
	onOpenSkills: () => void;
	/** The draft's `!` (bash) / `$` (python) mode, if any. */
	composerMode: ComposerInputMode | undefined;
	/** The draft is a `->` / `=>` queue shorthand; `queueSplitCount` > 1 when it splits into that many messages. */
	queued: boolean;
	queueSplitCount: number;
	dictationPhase: DictationPhase;
	onMic: () => void;
	onStopAndSend: () => void;
	/** The steer/follow-up chip says Follow-up. */
	followUp: boolean;
	onToggleSendMode: () => void;
	/** Something Stop ends: the run, or a prompt not yet sent. */
	stoppable: boolean;
	/** Send shows (else Stop takes its slot). */
	showSend: boolean;
	sendDisabled: boolean;
	onStop: () => void;
	onSend: () => void;
	/** The queue pill (QueueImpl): rendered before Stop; `null` when nothing is queued, so it reserves no width. */
	queueSlot?: ReactNode;
	/** A queued message is being edited: Send saves it (a check) and the lane chip steps aside (QueueImpl). */
	editingQueued?: boolean;
}

export const ComposerToolbar = memo(function ComposerToolbar({
	routeReady,
	touchInput,
	expanded,
	onToggleExpanded,
	onOpenFilePicker,
	fileInputRef,
	onFilesPicked,
	onOpenHistory,
	onOpenSkills,
	composerMode,
	queued,
	queueSplitCount,
	dictationPhase,
	onMic,
	onStopAndSend,
	followUp,
	onToggleSendMode,
	stoppable,
	showSend,
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
	const openModes = useUiStore(s => s.openModes);
	/** Agent `stt.enabled` setting: microphone dictation button in the composer. */
	const sttEnabled = useSettingsStore(s => s.sttEnabled);
	/** Phone: the mode, thinking, model and context controls fold behind one ⋯ so the idle composer is one row. */
	const phone = useShellMode() === "phone";
	const [moreOpen, setMoreOpen] = useState(false);
	const recording = dictationPhase !== "idle";
	const modeLabel = followUp ? t("input.followUp") : t("input.steer");
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const stopping = useComposerStore(s => s.stopping);
	const thinkingName = useThinkingName();
	// While first-run setup runs, the live model is whatever omp fell back to
	// (e.g. a tiny on-device model); show the neutral prompt instead.
	const modelLabel = model && !settingUp ? model.name || model.id : t("input.chooseModel");
	// Send's tooltip names the lane a running turn sends into and the chord of the other one.
	const sendTip = !isStreaming
		? t("input.send")
		: followUp
			? t("input.send.tipFollowUp")
			: t("input.send.tipSteer", { chord: formatShortcut(composerFollowUpChord()) });
	const sendChord = isStreaming || touchInput ? undefined : "↵";

	return (
		<div
			aria-busy={!routeReady}
			aria-label={t("input.toolbar")}
			className="omp-composer-toolbar flex min-h-11 flex-nowrap items-center gap-1 pr-2.5 pb-2.5 pl-2"
			data-more-open={moreOpen || undefined}
			inert={!routeReady}
			role="toolbar"
		>
			<MenuButton
				icon={<Plus />}
				items={[
					// A phone offers its gallery and camera only for pictures (`image/*`); any file opens its
					// file manager, which lists no gallery.
					...(touchInput
						? [
								{
									id: "photos",
									label: t("input.attachPhotos"),
									description: t("input.attachPhotosDesc"),
									icon: ImageIcon,
									onSelect: () => onOpenFilePicker("image/*"),
								},
							]
						: []),
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
					{
						id: "expand",
						label: expanded ? t("input.expanded.collapse") : t("input.expanded.open"),
						icon: expanded ? Minimize2 : Maximize2,
						shortcut: "⌃G",
						onSelect: onToggleExpanded,
					},
					{
						id: "goal",
						label: t("input.addMenu.goal"),
						description: t("input.addMenu.goalDesc"),
						icon: Target,
						separatorBefore: true,
						onSelect: () => openModes("goal"),
					},
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
				size="sm"
			/>
			{phone && (
				<IconButton
					aria-expanded={moreOpen}
					className="omp-composer-more"
					icon={<Ellipsis />}
					label={t("input.moreControls")}
					onClick={() => setMoreOpen(open => !open)}
					size="sm"
				/>
			)}
			<input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFilesPicked} />

			<RunChip />
			<ComposerModeExtras />

			{composerMode && (
				<Tooltip content={composerMode === "bash" ? t("input.mode.bash.title") : t("input.mode.python.title")}>
					<span className="inline-flex">
						<Badge variant={composerMode === "bash" ? "info" : "warning"}>
							{composerMode === "bash" ? t("input.mode.bash.badge") : t("input.mode.python.badge")}
						</Badge>
					</span>
				</Tooltip>
			)}
			{queued && (
				<Tooltip content={t("input.queue.title")}>
					<span className="inline-flex">
						<Badge variant="warning">
							{queueSplitCount > 1
								? t("input.queue.badgeSplit", { count: queueSplitCount })
								: t("input.queue.badge")}
						</Badge>
					</span>
				</Tooltip>
			)}

			<div className="flex-1" />

			<div className="omp-composer-send-cluster flex shrink-0 items-center gap-1">
				<Tooltip
					content={model ? t("input.modelTooltip", { id: model.id }) : t("input.model")}
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
						icon={<Cpu aria-hidden />}
						onClick={() => openModelPicker()}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />}
						variant="ghost"
					>
						<span className="omp-composer-model-label truncate">{modelLabel}</span>
						{model && !settingUp && (
							<span className="omp-composer-effort shrink-0 font-normal text-(--sc-text-muted)">
								· {thinkingName}
							</span>
						)}
					</Button>
				</Tooltip>
				{!settingUp && <ContextUsagePopover />}
				{sttEnabled && (
					<IconButton
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
				{/* Reserved slots: a control that is not on screen keeps its box, inert and invisible, so a turn
				    starting or ending moves nothing. The steer/follow-up chip first, then Stop (left) and Send (right). */}
				<span
					className="omp-composer-slot"
					data-off={isStreaming && !editingQueued ? undefined : ""}
					data-slot="steer"
					inert={!isStreaming || editingQueued}
				>
					<Tooltip content={t("input.sendModeHint")} shortcut={followUp ? undefined : composerFollowUpChord()}>
						<Button
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
				</span>
				<div className="omp-composer-actions ml-1 flex items-center gap-1.5">
					{queueSlot}
					<span
						className="omp-composer-slot"
						data-off={stoppable ? undefined : ""}
						data-slot="stop"
						inert={!stoppable}
					>
						<IconButton
							className="omp-composer-action"
							disabled={!routeReady}
							icon={<Square className="omp-composer-stop-glyph" fill="currentColor" />}
							label={t("input.abort")}
							loading={stopping}
							onClick={onStop}
							shortcut="Esc"
							variant={showSend ? "secondary" : "primary"}
						/>
					</span>
					<span className="omp-composer-slot" data-slot="send">
						{dictationPhase === "recording" ? (
							<IconButton
								className="omp-composer-action"
								data-dictation-send
								disabled={!routeReady}
								icon={<ArrowUp strokeWidth={2.25} />}
								label={t("voice.dictation.stopAndSend")}
								onClick={onStopAndSend}
								variant="primary"
							/>
						) : (
							<ComposerSend label={editingQueued ? t("input.send.saveEdit") : sendTip} shortcut={sendChord}>
								<IconButton
									className="omp-composer-action"
									data-send-lane={isStreaming ? (followUp ? "followUp" : "steer") : undefined}
									data-send-editing={editingQueued || undefined}
									disabled={sendDisabled || !showSend}
									icon={editingQueued ? <Check strokeWidth={2.25} /> : <ArrowUp strokeWidth={2.25} />}
									label={editingQueued ? t("input.send.saveEdit") : t("input.send")}
									onClick={onSend}
									tooltip={false}
									variant={showSend ? "primary" : "secondary"}
								/>
							</ComposerSend>
						)}
					</span>
				</div>
			</div>
		</div>
	);
});
