import {
	ArrowUp,
	ChevronDown,
	ClipboardPaste,
	CornerDownRight,
	Cpu,
	ExternalLink,
	History,
	ListPlus,
	Maximize2,
	Mic,
	Minimize2,
	Paperclip,
	Plus,
	Sparkles,
	Square,
	Target,
	X,
} from "lucide-react";
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { removeFileMention } from "../../../shared/file-mentions";
import type { AvailableCommand, ImageContent } from "../../../shared/rpc-types";
import { useInlineCompletion } from "../../hooks/use-inline-completion";
import { useNextPrompt } from "../../hooks/use-next-prompt";
import { withGuiCommands } from "../../lib/command-registry";
import { useDisplayPreference } from "../../lib/display-preferences";
import { tryEmojiInlineReplace } from "../../lib/emoji";
import { FILE_DRAG_TYPE, readFileDrag } from "../../lib/file-drag";
import { cx } from "../../lib/format";
import { historyImages } from "../../lib/history-images";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { parseComposerMode } from "../../lib/input-modes";
import { formatShortcut, isComposerFollowUpKey, PLATFORM } from "../../lib/keymap";
import { continueList } from "../../lib/list-continue";
import { abortActiveTurn } from "../../lib/messages";
import { NEXT_PROMPT_WIDGET } from "../../lib/next-prompt";
import {
	dropReferencedPastes,
	editPaste,
	expandPasteMarkers,
	getPaste,
	isMarkerSized,
	pasteMarkerText,
	referencedPasteIds,
	shouldOfferPasteMenu,
	storePaste,
	wrapPasteInAttachmentBlock,
} from "../../lib/paste-blobs";
import { parseQueueShorthand, splitQueuedMessages } from "../../lib/queue-input";
import { useTabRpc } from "../../lib/tab-rpc";
import {
	cancelVoiceRecording,
	evaluateSttSubmitTrigger,
	METER_BARS,
	readSttSubmitTrigger,
	recordAndTranscribe,
	stopVoiceRecording,
} from "../../lib/voice";
import { type ComposerImage, type ComposerStore, useComposerStore } from "../../stores/composer";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { useFirstRunStore } from "../../stores/first-run";
import { useInputHistoryStore } from "../../stores/input-history";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useNextPromptStore } from "../../stores/next-prompt";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useSettingsStore } from "../../stores/settings";
import { useActiveTabKind, useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, Banner, Button, IconButton, Kbd, MenuButton, Tooltip, ZoomableImage } from "../common";
import { AskDockSlot, BelowEditorDockSlot } from "../dialogs/ask-dock";
import { ComposerModes } from "./ComposerModes";
import { ComposerQueue } from "./ComposerQueue";
import { ContextUsagePopover } from "./ContextUsagePopover";
import { fileTextAttachment, intakeComposerFiles } from "./composer-files";
import { DelegationControl } from "./DelegationControl";
import { DictationOverlay, type DictationPhase } from "./DictationOverlay";
import { DraftFileCards } from "./DraftFileCards";
import { HistorySearchOverlay } from "./HistorySearchOverlay";
import { fileToImage, listMentionFiles, mentionFileCache } from "./input-area-utils";
import { chipIndexForCode, NextPromptChips, type NextPromptChipsHandle } from "./NextPromptChips";
import { PastedTextDialog } from "./PastedTextDialog";
import { RunSettings } from "./RunSettings";
import { SkillPickerOverlay } from "./SkillPickerOverlay";
import { type CompletionItem, type CompletionMenu, sameCompletionMenu, useCompletionMenu } from "./use-completion-menu";
import { useComposerSubmit } from "./use-composer-submit";

type SendMode = "prompt" | "steer" | "followUp";

const MENTION_FS_DEBOUNCE_MS = 150;
/** Rows PageUp/PageDown move through the completion menu. */
const MENU_PAGE = 5;
/** Second Esc within this window clears the draft or runs the double-Esc action (stock uses 500 ms; a hint needs reading time). */
const DOUBLE_ESC_MS = 1500;

/** Below this field width the idle hint no longer fits on its line (ko, 14px: ~250px of text plus padding). */
const NARROW_FIELD_PX = 290;

/**
 * Composer: auto-growing textarea, Enter to send / Shift+Enter for newline,
 * image paste, @file mentions, /command completion, steering-mode selector,
 * and an abort button while the agent streams.
 */
export function InputArea() {
	const isStreaming = useSessionStore(s => s.isStreaming);
	const t = useT();
	const rpc = useTabRpc();
	const contextTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const runtimeTabId = contextTabId ?? activeTabId;
	const historyDevice = useTabsStore(state => state.tabs.find(tab => tab.id === runtimeTabId)?.device);
	const routeReady = runtimeTabId !== null;
	/** A chat tab only differs in wording: it has no project to work in. */
	const isChat = useActiveTabKind() === "chat";
	const status = useSessionStore(s => s.status);
	const sessionId = useSessionStore(s => s.sessionId);
	const queuedMessageCount = useSessionStore(s => s.queuedMessageCount);
	const cwd = useSessionStore(s => s.cwd);
	const model = useModelStore(s => s.model);
	const settingUp = useFirstRunStore(s => s.phase !== "idle");
	const openModelPicker = useUiStore(s => s.openModelPicker);
	const openModes = useUiStore(s => s.openModes);
	const openSettings = useUiStore(s => s.openSettings);
	/** Agent `stt.enabled` setting: microphone dictation button in the composer. */
	const sttEnabled = useSettingsStore(s => s.sttEnabled);
	/** Agent `paste.largeMenuThreshold` setting: line count that triggers the paste menu. */
	const pasteMenuThreshold = useDisplayPreference("pasteMenuThreshold");
	/** Agent `emojiAutocomplete` setting: emoji popup/inline/submit expansion. */
	const emojiAutocomplete = useDisplayPreference("emojiAutocomplete");
	/** `next-prompt` extension suggestion: gray placeholder, Tab on an empty composer
	 * accepts it. Remembered per session (stores/next-prompt.ts) so a deleted draft or a
	 * session switch brings it back until a submit or a new run makes it stale. */
	const nextPromptLines = useExtensionUiStore(s => s.widgetPanels[NEXT_PROMPT_WIDGET]);
	const sessionFile = useSessionStore(s => s.sessionFile);
	const nextPromptKey = sessionFile || sessionId || undefined;
	const nextPromptView = useNextPrompt();
	/** The built-in's best candidate (or, while it is off, the legacy widget's entry): already empty unless ready and idle. */
	const nextPrompt = nextPromptView.best;
	// The legacy widget feeds the memory only while the built-in is off: with it on, a recorded
	// widget would overwrite the built-in's entry.
	useEffect(() => {
		if (nextPromptKey && !nextPromptView.builtin)
			useNextPromptStore.getState().recordWidget(nextPromptKey, nextPromptLines);
	}, [nextPromptKey, nextPromptLines, nextPromptView.builtin]);
	useEffect(() => {
		if (isStreaming) useNextPromptStore.getState().clear(nextPromptKey);
	}, [isStreaming, nextPromptKey]);

	// Draft lives in the composer store (not local state) so session-tab
	// switches snapshot/restore it per tab. Value + updater-form setter are
	// drop-in for the old useState pair.
	const text = useComposerStore(s => s.draft);
	const setText = useComposerStore(s => s.setDraft);
	const images = useComposerStore(s => s.images);
	const setImages = useComposerStore(s => s.setImages);
	const [mode, setMode] = useState<SendMode>("prompt");
	const [menu, setMenu] = useState<CompletionMenu | null>(null);
	/** The menu re-derives on every command refresh and caret event: an unchanged one keeps its highlight. */
	const publishMenu = useCallback((next: CompletionMenu | null) => {
		setMenu(current => (current && next && sameCompletionMenu(current, next) ? current : next));
	}, []);
	const [commands, setCommands] = useState<AvailableCommand[]>([]);
	const sending = useComposerStore(state => state.sending);
	const setSending = useComposerStore(state => state.setSending);
	const submissionUncertain = useComposerStore(state => state.submissionUncertain);
	const setSubmissionUncertain = useComposerStore(state => state.setSubmissionUncertain);
	const [filePaths, setFilePaths] = useState<string[]>([]);
	const [historySearchOpen, setHistorySearchOpen] = useState(false);
	const [skillPickerOpen, setSkillPickerOpen] = useState(false);
	const [dictation, setDictation] = useState<DictationPhase>("idle");
	const [dictationLevels, setDictationLevels] = useState<readonly number[]>(() => Array(METER_BARS).fill(0));
	const [dictationStartedAt, setDictationStartedAt] = useState<number | null>(null);
	/** "Stop and send": submit the draft once the take is transcribed into it. */
	const sendAfterDictationRef = useRef(false);
	const recording = dictation !== "idle";
	/** Pending large-paste choice: the paste already happened, this picks the form. */
	const [pasteMenu, setPasteMenu] = useState<{ content: string; lineCount: number } | null>(null);
	const pasteMenuRef = useRef<HTMLDivElement>(null);
	/** The folded paste open in "Edit pasted text". */
	const [editingPaste, setEditingPaste] = useState<number | null>(null);
	const draftPastes = useMemo(() => referencedPasteIds(text), [text]);
	/** The draft's pictures while ↑/↓ shows history entries (restored on the way back). */
	const navDraftImages = useRef<ComposerImage[]>([]);
	/** ⌃G: the composer expands in place to fill the session pane (design-spec §2.2). */
	const [expanded, setExpanded] = useState(false);
	const [externalBusy, setExternalBusy] = useState(false);
	const [dragActive, setDragActive] = useState(false);
	/** First Esc of a double-Esc, and whether its "Esc again" hint shows. */
	const escArmedAt = useRef<number | null>(null);
	const [escHint, setEscHint] = useState(false);
	const isEmptySession = useMessagesStore(s => s.messages.length === 0);
	const focusedPane = contextTabId === null || contextTabId === activeTabId;

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	/**
	 * Write the draft and its caret in one task. A caret placed on a later frame moved
	 * whatever the next keys did meanwhile (a select-all, typed text); written here,
	 * React finds its value already in the field and leaves the caret alone.
	 */
	const placeDraft = useCallback(
		(next: string, caret: number) => {
			const el = textareaRef.current;
			if (el) {
				el.value = next;
				el.setSelectionRange(caret, caret);
			}
			setText(next);
		},
		[setText],
	);
	/**
	 * Continue (or end) a markdown list at the caret for a newline key. The edit goes through the
	 * browser's own insertion so Cmd/Ctrl+Z restores the plain newline; a field that refuses it
	 * (no `execCommand`) takes the draft directly. False when the plain newline should stand.
	 */
	const continueListAtCaret = (): boolean => {
		const el = textareaRef.current;
		if (!el) return false;
		const value = el.value;
		const start = el.selectionStart ?? value.length;
		const edit = continueList(value, start, el.selectionEnd ?? start);
		if (!edit) return false;
		const next = value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
		el.setSelectionRange(edit.from, edit.to);
		// The newline and the bullet are separate insertions: one undo then leaves the plain newline.
		const exec = typeof document.execCommand === "function" ? document.execCommand.bind(document) : undefined;
		let done = false;
		if (exec !== undefined) {
			if (edit.insert === "") done = exec("delete");
			else if (edit.insert.length === 1) done = exec("insertText", false, edit.insert);
			else if (exec("insertText", false, "\n")) {
				// Moving the caret closes the open typing command, so the bullet is its own undo step.
				el.setSelectionRange(edit.from + 1, edit.from + 1);
				done = exec("insertText", false, edit.insert.slice(1));
			}
		}
		if (!done || el.value !== next) placeDraft(next, edit.caret);
		else el.setSelectionRange(edit.caret, edit.caret);
		return true;
	};
	const chipsRef = useRef<NextPromptChipsHandle>(null);
	/** Runner-up suggestions: only over an empty, idle composer with nothing else open. */
	const chipsShown =
		nextPromptView.chips.length > 0 && text === "" && status === "ready" && !isStreaming && !menu && !pasteMenu;
	const pickChip = useCallback(
		(chip: string) => {
			textareaRef.current?.focus();
			placeDraft(chip, chip.length);
			nextPromptView.accepted();
		},
		[placeDraft, nextPromptView],
	);
	/** Ghost text after the caret while the user types (slash / `@` menus, IME, `!` `$` `/` drafts: never). */
	const inline = useInlineCompletion({
		enabled: nextPromptView.inline && status === "ready" && !isStreaming && routeReady,
		text,
		menuOpen: menu !== null || pasteMenu !== null,
		textareaRef,
		complete: nextPromptView.completeInline,
	});
	// A pane of a 2x2 split has a field narrower than the idle hint ("Ask anything · @ files · / commands"):
	// it shows the short prompt instead of a hint cut mid-glyph.
	const [fieldNarrow, setFieldNarrow] = useState(false);
	useEffect(() => {
		const el = textareaRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setFieldNarrow(el.clientWidth > 0 && el.clientWidth < NARROW_FIELD_PX));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const mountedRef = useRef(true);

	// New and empty sessions start with the caret in the composer, unless
	// something else (a dialog, another field) already holds focus. The end of
	// first-run setup counts as a new start: its button unmounted with focus on it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: setup ending re-runs the check
	useEffect(() => {
		if (!routeReady || !focusedPane || !isEmptySession || !sessionId) return;
		const active = document.activeElement;
		if (active && active !== document.body) return;
		textareaRef.current?.focus();
	}, [routeReady, focusedPane, isEmptySession, sessionId, settingUp]);

	// A large-paste choice stays reversible until the user explicitly chooses a
	// representation. Outside click cancels it instead of silently inserting
	// the default form.
	useEffect(() => {
		if (!pasteMenu) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && pasteMenuRef.current?.contains(target)) return;
			setPasteMenu(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [pasteMenu]);

	// An in-flight dictation is cancelled (never transcribed) if the composer unmounts.
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			cancelVoiceRecording();
		};
	}, []);

	// The "Esc again to clear" hint lasts as long as the second press counts; any edit disarms it.
	useEffect(() => {
		if (!escHint) return;
		const timer = setTimeout(() => setEscHint(false), DOUBLE_ESC_MS);
		return () => clearTimeout(timer);
	}, [escHint]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: an edit of the draft disarms a pending Esc
	useEffect(() => {
		escArmedAt.current = null;
		setEscHint(false);
	}, [text]);

	/** Stock `doubleEscapeAction` (default `rewind`): the rewind picker, the session tree, or nothing. */
	const runDoubleEscapeAction = async () => {
		const response = await rpc.getSettings(["doubleEscapeAction"]).catch(() => undefined);
		const values = response?.success
			? (response.data as { values?: Record<string, unknown> } | undefined)?.values
			: undefined;
		const action = values?.doubleEscapeAction ?? "rewind";
		if (action === "tree") useUiStore.getState().openSessionTree();
		else if (action === "rewind") useUiStore.getState().openBranchPicker();
	};

	// Refresh from this tab's omp machine when its bridge is ready.
	useEffect(() => {
		if (status === "ready") void useInputHistoryStore.getState().hydrate(rpc, historyDevice);
	}, [rpc, status, historyDevice]);

	// `!` → bash / `$` → python composer mode (TUI parity): drives the toolbar
	// badge and reroutes sending. Detected from the prefix alone so the badge
	// appears while the user is still typing.
	const composerMode = useMemo(() => parseComposerMode(text), [text]);

	// `->` / `=>` yield-queue shorthand (TUI queue-input.ts parity). The badge
	// preview and the send-path dispatch share this one parser so the "splits
	// into N" promise always matches what actually gets queued.
	const queueBody = useMemo(() => parseQueueShorthand(text), [text]);
	const queueSplitCount = useMemo(() => {
		if (queueBody === undefined || queueBody.length === 0) return 0;
		const items = splitQueuedMessages(queueBody);
		return items.length > 1 ? items.length : 0;
	}, [queueBody]);

	// Keep slash commands current across sidecar startup and extension reloads.
	useEffect(() => {
		let cancelled = false;
		const unsubscribe = window.omp.events.onTabCommandsUpdate((next, tabId) => {
			if (!cancelled && tabId === runtimeTabId) setCommands(withGuiCommands(next));
		});
		const load = () => {
			if (status !== "ready" || !runtimeTabId) return;
			void rpc.getAvailableCommands().then(res => {
				if (
					cancelled ||
					sessionRuntimeStore<SessionStore>(runtimeTabId, "session")?.getState().sessionId !== sessionId ||
					!res.success
				)
					return;
				const data = res.data as { commands?: AvailableCommand[] } | undefined;
				setCommands(withGuiCommands(data?.commands ?? []));
			});
		};
		load();
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [status, sessionId, runtimeTabId, rpc]);

	// Auto-grow the textarea to fit its content (up to ~40% of the pane). The
	// expanded composer fills the pane instead (CSS owns its height).
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		if (expanded) {
			el.style.height = "";
			return;
		}
		el.style.height = "0px";
		const paneHeight = el.closest<HTMLElement>(".omp-session-pane")?.clientHeight ?? window.innerHeight;
		const maxHeight = text.length === 0 ? 24 : paneHeight * 0.4;
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	}, [text, expanded]);

	// Contextual argument hint (TUI ghost-text parity), from stock for builtins.
	// Rendered as a dim row under the textarea — an inline-after-cursor ghost
	// needs pixel-aligned overlay metrics that break with auto-grow/IME (same
	// tradeoff as the queue highlight).
	const argHint = useCompletionMenu({
		text,
		filePaths,
		commands,
		emojiAutocomplete,
		textareaRef,
		setMenu: publishMenu,
	});

	// Reset the mention file list when the session cwd changes (cache is per-cwd).
	useEffect(() => {
		setFilePaths(mentionFileCache.get(cwd) ?? []);
	}, [cwd]);

	// Lazy-load workspace files for @mention completion: debounced so a fleeting
	// "@" doesn't trigger the walk, then cached per cwd for instant filtering.
	useEffect(() => {
		if (!routeReady) return;
		if (mentionFileCache.has(cwd)) return;
		const el = textareaRef.current;
		const before = text.slice(0, el?.selectionStart ?? text.length);
		if (!/(^|\s)@[\w./-]*$/.test(before)) return;
		const key = cwd;
		const timer = setTimeout(() => {
			void listMentionFiles(key, runtimeTabId).then(paths => {
				if (sessionRuntimeStore<SessionStore>(runtimeTabId, "session")?.getState().cwd === key) setFilePaths(paths);
			});
		}, MENTION_FS_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [text, cwd, routeReady, runtimeTabId]);

	useEffect(() => {
		const onInsertMention = (event: Event) => {
			const detail = (event as CustomEvent<{ path?: string; tabId?: string }>).detail;
			if ((detail?.tabId ?? useTabsStore.getState().activeTabId) !== runtimeTabId) return;
			const path = detail?.path;
			if (!path) return;
			setText(current => `${current}${current && !current.endsWith(" ") ? " " : ""}@${path} `);
			requestAnimationFrame(() => textareaRef.current?.focus());
		};
		window.addEventListener("omp:insert-mention", onInsertMention);
		return () => window.removeEventListener("omp:insert-mention", onInsertMention);
	}, [setText, runtimeTabId]);

	useEffect(() => {
		const fillComposer = (event: Event) => {
			const detail = (
				event as CustomEvent<{
					text?: string;
					images?: ImageContent[];
					prepend?: boolean;
					clearPastes?: boolean;
					tabId?: string;
				}>
			).detail;
			if ((detail?.tabId ?? useTabsStore.getState().activeTabId) !== runtimeTabId) return;
			const next = detail?.text;
			const restoredImages = detail?.images ?? [];
			if (!next && restoredImages.length === 0) return;
			// The editor dialog writes back fully-inline text — consume the blobs.
			if (detail?.clearPastes)
				dropReferencedPastes(sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer")?.getState().draft ?? "");
			if (next) {
				// prepend (dequeue restore): queued text goes ahead of any draft, TUI-style;
				// otherwise replace (starter cards, history recall).
				const current =
					textareaRef.current?.value ??
					sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer")?.getState().draft ??
					"";
				placeDraft(detail?.prepend && current.trim() ? `${next}\n\n${current}` : next, next.length);
			}
			if (restoredImages.length > 0) {
				setImages(current => [
					...current,
					...restoredImages.map(content => ({
						content,
						preview: `data:${content.mimeType};base64,${content.data}`,
					})),
				]);
			}
			// Focus waits a frame: the surface that sent the text (a dialog, a menu) may still
			// hand focus back as it closes. Focus keeps the caret placed above.
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (!el) return;
				if (useTabsStore.getState().activeTabId !== runtimeTabId) return;
				el.focus();
			});
		};
		window.addEventListener("omp:fill-composer", fillComposer);
		return () => window.removeEventListener("omp:fill-composer", fillComposer);
	}, [placeDraft, setImages, runtimeTabId]);

	const insertCompletion = useCallback(
		(item: CompletionItem) => {
			const el = textareaRef.current;
			if (!el || !menu) return;
			const pos = el.selectionStart ?? text.length;
			if (pos !== menu.rangeEnd) {
				setMenu(null);
				return;
			}
			const replaced = `${text.slice(0, menu.rangeStart)}${item.value}${text.slice(pos)}`;
			el.focus();
			placeDraft(replaced, menu.rangeStart + item.value.length);
			setMenu(null);
		},
		[text, menu, placeDraft],
	);

	// Collapse a large paste into a `[Paste #N]` marker with the blob held in
	// memory; the marker expands back to full content at submit time (TUI
	// editor.ts parity). Inserted at the caret, replacing any selection.
	const insertPasteBlob = useCallback(
		(content: string) => {
			const blob = storePaste(content);
			const marker = pasteMarkerText(blob.id, blob.content);
			const el = textareaRef.current;
			const current = el?.value ?? text;
			const start = el?.selectionStart ?? current.length;
			const end = el?.selectionEnd ?? start;
			el?.focus();
			placeDraft(`${current.slice(0, start)}${marker}${current.slice(end)}`, start + marker.length);
		},
		[text, placeDraft],
	);

	// Paste menu actions — the paste always inserts something; the menu only
	// picks the form. Keep side effects outside state updaters: React may replay
	// updater functions, which must never duplicate a paste or an RPC write.
	const choosePasteInline = useCallback(() => {
		if (!pasteMenu) return;
		insertPasteBlob(pasteMenu.content);
		setPasteMenu(null);
	}, [insertPasteBlob, pasteMenu]);

	const choosePasteWrapped = useCallback(() => {
		if (!pasteMenu) return;
		insertPasteBlob(wrapPasteInAttachmentBlock(pasteMenu.content));
		setPasteMenu(null);
	}, [insertPasteBlob, pasteMenu]);

	// Save-as-file: the agent writes the blob into the session's local:// store
	// (counter allocated agent-side so two windows can never collide) and the
	// composer gets the returned literal reference. Any protocol or transport
	// failure falls back to the inline marker, so clipboard content is not lost.
	const choosePasteSaveFile = useCallback(() => {
		if (!pasteMenu) return;
		const pendingPaste = pasteMenu;
		setPasteMenu(null);
		// Capture tab AND session at click time: after the RPC resolves,
		// `setText` may belong to a different tab's draft (tab switch) or a
		// different session's draft (in-place session replace). Both success
		// and fallback paths are gated — a cross-session paste corrupts both.
		const origin = {
			tabId: runtimeTabId,
			sessionId: sessionRuntimeStore<SessionStore>(runtimeTabId, "session")?.getState().sessionId,
		};
		const stillOrigin = () =>
			origin.tabId !== null &&
			sessionRuntimeStore<SessionStore>(origin.tabId, "session")?.getState().sessionId === origin.sessionId;
		void (async () => {
			try {
				const response = await rpc.writeLocalPaste(pendingPaste.content);
				if (!stillOrigin()) return;
				if (!response.success) throw new Error(response.error);
				const data = response.data as { url?: string } | undefined;
				if (!data?.url) throw new Error("write_local_paste returned no URL");
				const el = textareaRef.current;
				const current = el?.value ?? text;
				const start = el?.selectionStart ?? current.length;
				const end = el?.selectionEnd ?? start;
				const insert = `${data.url} `;
				el?.focus();
				placeDraft(`${current.slice(0, start)}${insert}${current.slice(end)}`, start + insert.length);
			} catch (cause) {
				// The RPC threw (transport/permission): without the origin gate the
				// inline fallback would splice clipboard content into whichever
				// composer is now foreground.
				if (!stillOrigin()) return;
				toastError({ title: t("input.paste.saveFailed"), error: cause });
				insertPasteBlob(pendingPaste.content);
			}
		})();
	}, [insertPasteBlob, pasteMenu, text, t, placeDraft, runtimeTabId, rpc]);

	const dispatchSend = useComposerSubmit({
		text,
		images,
		sending,
		status,
		isStreaming,
		mode,
		queuedMessageCount,
		commands,
		emojiAutocomplete,
		routeReady,
		setText,
		setImages,
		setMenu,
		setSending,
	});
	/** A submit that went out (the draft emptied) makes this session's suggestion stale. */
	const send = useCallback(
		(overrideText?: string, forceMode?: SendMode) => {
			const composer = sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer") ?? useComposerStore;
			const hadContent = (overrideText ?? composer.getState().draft).trim() !== "" || images.length > 0;
			dispatchSend(overrideText, forceMode);
			const after = composer.getState();
			if (hadContent && after.draft === "" && after.images.length === 0)
				useNextPromptStore.getState().clear(nextPromptKey);
		},
		[dispatchSend, runtimeTabId, images.length, nextPromptKey],
	);

	// Mic dictation (stt.enabled): click starts capture, click again (or Enter)
	// stops and transcribes, Esc discards; the transcript inserts at the
	// textarea caret. The send button's "Stop and send" and the
	// stt.submitTrigger setting submit the utterance (TUI parity).
	const handleMicClick = useCallback(() => {
		if (recording) {
			if (dictation === "starting") cancelVoiceRecording();
			else stopVoiceRecording();
			return;
		}
		setDictation("starting");
		sendAfterDictationRef.current = false;
		void recordAndTranscribe({
			onRecording: () => {
				if (!mountedRef.current) return;
				setDictationStartedAt(Date.now());
				setDictation("recording");
			},
			onLevels: levels => {
				if (mountedRef.current) setDictationLevels(levels);
			},
			onTranscribing: () => {
				if (mountedRef.current) setDictation("transcribing");
			},
		}).then(async result => {
			if (!mountedRef.current) return;
			const sendAfter = sendAfterDictationRef.current;
			sendAfterDictationRef.current = false;
			setDictation("idle");
			setDictationStartedAt(null);
			setDictationLevels(Array(METER_BARS).fill(0));
			if ("error" in result) {
				if (result.error) toastError({ title: t("voice.mic.failed"), error: result });
				return;
			}
			const utterance = result.text.trim();
			const trigger = await readSttSubmitTrigger();
			const evaluation = evaluateSttSubmitTrigger(utterance, trigger);
			const insert = (
				evaluation.trimTrailing > 0 ? utterance.slice(0, utterance.length - evaluation.trimTrailing) : utterance
			).trimEnd();
			if (!mountedRef.current) return;
			if (!insert) {
				// Nothing heard: "Stop and send" still sends what the draft already holds.
				if (sendAfter && textareaRef.current?.value.trim()) send();
				return;
			}
			// Read the live DOM value/caret: the user may have typed mid-recording.
			const el = textareaRef.current;
			const current = el?.value ?? "";
			const start = el?.selectionStart ?? current.length;
			const end = el?.selectionEnd ?? start;
			const before = current.slice(0, start);
			const after = current.slice(end);
			const prefix = before.length > 0 && !before.endsWith(" ") ? " " : "";
			const suffix = after.length === 0 ? " " : "";
			const insertedText = `${prefix}${insert}${suffix}`;
			const next = `${before}${insertedText}${after}`;
			el?.focus();
			placeDraft(next, start + insertedText.length);
			if (evaluation.submit || sendAfter) send(next);
		});
	}, [recording, dictation, send, t, placeDraft]);

	// While the mic is open, Enter ends the take (transcribe and insert) and Esc
	// discards it, before any other key handler (the composer's, App's abort).
	useEffect(() => {
		if (dictation !== "starting" && dictation !== "recording") return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (isImeKeyEvent(event)) return;
			const finish = event.key === "Enter" && !event.shiftKey && dictation === "recording";
			if (event.key !== "Escape" && !finish) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (finish) stopVoiceRecording();
			else cancelVoiceRecording();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [dictation]);

	/**
	 * Expanded composer (TUI app.editor.external parity, GUI-native form): ⌃G
	 * or the + menu grows the composer in place to fill the session pane for
	 * long drafts — the same field, so completion, paste markers, IME and
	 * history keep working. Enter adds a line there; ⌘↵ sends; Esc collapses.
	 */
	const toggleExpanded = (next?: boolean) => {
		setExpanded(current => next ?? !current);
		requestAnimationFrame(() => textareaRef.current?.focus());
	};

	/** Round-trip the draft (paste markers resolved) through the user's $VISUAL/$EDITOR. */
	const openExternalEditor = async () => {
		if (externalBusy) return;
		setExternalBusy(true);
		const draft = text;
		try {
			const response = await window.omp.editor.openExternal(expandPasteMarkers(draft));
			if (!mountedRef.current) return;
			if (!response.ok) {
				if (response.unavailable) toast({ variant: "info", message: t("editor.externalUnavailable") });
				else toastError({ title: t("editor.externalFailed"), error: response });
				return;
			}
			// null text = the editor exited non-zero; keep the draft as it was.
			if (response.text === null) return;
			// The written-back text is fully inline: consume the draft's paste blobs.
			dropReferencedPastes(draft);
			setText(response.text);
		} finally {
			if (mountedRef.current) setExternalBusy(false);
		}
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// IME composition (Chinese/Japanese/Korean input): while the candidate
		// window is open, Enter and friends belong to the IME — committing the
		// composition must never send the message.
		if (isImeKeyEvent(e)) return;
		// Pending paste choice: Esc cancels the decision without inserting text.
		if (pasteMenu) {
			if (e.key === "Escape") {
				e.preventDefault();
				setPasteMenu(null);
			}
			return;
		}
		// Ghost text: Tab takes it, Esc hides it (and only then keeps Esc's other meanings off);
		// any other key drops it and aborts the request (typing restarts the debounce).
		const plainKey = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
		if (e.key === "Tab" && plainKey) {
			const accepted = inline.accept();
			if (accepted !== null) {
				e.preventDefault();
				placeDraft(accepted, accepted.length);
				return;
			}
		}
		if (e.key === "Escape" && plainKey && inline.dismiss()) {
			e.preventDefault();
			return;
		}
		if (!["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) inline.drop();
		if (chipsShown) {
			const chipIndex = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? chipIndexForCode(e.code) : undefined;
			const chip = chipIndex === undefined ? undefined : nextPromptView.chips[chipIndex];
			if (chip !== undefined) {
				e.preventDefault();
				pickChip(chip);
				return;
			}
			if (e.key === "ArrowDown" && plainKey) {
				e.preventDefault();
				chipsRef.current?.focusFirst();
				return;
			}
		}
		if (nextPrompt !== undefined && text === "" && (e.key === "Tab" || e.key === "ArrowRight") && plainKey) {
			e.preventDefault();
			setText(nextPrompt);
			nextPromptView.accepted();
			return;
		}
		if (menu && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			setMenu(null);
			return;
		}
		if (menu) {
			const count = menu.items.length;
			// Home/End jump to the ends, PageUp/PageDown move a page; the caret stays put.
			const paged =
				e.key === "Home"
					? 0
					: e.key === "End"
						? count - 1
						: e.key === "PageUp"
							? Math.max(0, menu.index - MENU_PAGE)
							: e.key === "PageDown"
								? Math.min(count - 1, menu.index + MENU_PAGE)
								: undefined;
			if (paged !== undefined) {
				e.preventDefault();
				setMenu({ ...menu, index: Math.max(0, paged) });
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index + 1) % Math.max(1, count) });
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index - 1 + Math.max(1, count)) % Math.max(1, count) });
				return;
			}
			if (e.key === "Tab" || e.key === "Enter") {
				e.preventDefault();
				const item = menu.items[menu.index];
				if (item) insertCompletion(item);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMenu(null);
				return;
			}
		}
		// Ctrl+R: history search overlay (TUI `app.history.search`).
		if (e.key === "r" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			e.preventDefault();
			setHistorySearchOpen(open => !open);
			return;
		}
		// ⌃G: expand / collapse the composer in place.
		if (e.key === "g" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			e.preventDefault();
			toggleExpanded();
			return;
		}
		if (expanded && e.key === "Escape") {
			// Claim the key: the app-wide Escape would abort a running turn.
			e.preventDefault();
			e.stopPropagation();
			toggleExpanded(false);
			return;
		}
		// ⌃J inserts a newline at the caret (macOS: on Windows Ctrl+J toggles the panel), continuing a list;
		// ⌃U deletes the selection, or back to the start of the line.
		if (
			e.key === "j" &&
			PLATFORM === "mac" &&
			e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			!e.shiftKey &&
			continueListAtCaret()
		) {
			e.preventDefault();
			return;
		}
		if (
			((e.key === "j" && PLATFORM === "mac") || e.key === "u") &&
			e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			!e.shiftKey
		) {
			const el = textareaRef.current;
			if (!el) return;
			e.preventDefault();
			const start = el.selectionStart ?? text.length;
			const end = el.selectionEnd ?? start;
			const from = e.key === "j" || start !== end ? start : start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
			const insert = e.key === "j" ? "\n" : "";
			placeDraft(`${text.slice(0, from)}${insert}${text.slice(end)}`, from + insert.length);
			return;
		}
		// Esc: a selection collapses first. While no turn runs, a draft clears on a
		// second Esc (the first shows a hint; the cleared draft stays in ↑ history),
		// and an empty composer runs stock's `doubleEscapeAction` (rewind picker or
		// session tree, as in the TUI). A running turn keeps the app-wide stop.
		if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const el = textareaRef.current;
			if (el && el.selectionStart !== el.selectionEnd) {
				e.preventDefault();
				el.setSelectionRange(el.selectionEnd, el.selectionEnd);
				return;
			}
			if (!isStreaming) {
				e.preventDefault();
				const now = Date.now();
				const armed = escArmedAt.current !== null && now - escArmedAt.current < DOUBLE_ESC_MS;
				escArmedAt.current = armed ? null : now;
				if (text.trim() === "" && images.length === 0) {
					if (armed) void runDoubleEscapeAction();
					return;
				}
				if (!armed) {
					setEscHint(true);
					return;
				}
				useInputHistoryStore.getState().record(expandPasteMarkers(text), cwd, rpc, historyDevice);
				dropReferencedPastes(text);
				setText("");
				setImages([]);
				setEscHint(false);
				return;
			}
		}
		// Up/Down prompt-history recall, as in a terminal: ↑ recalls an older entry only from an empty
		// composer or with the caret at position 0, ↓ a newer entry (and finally the stashed draft) only
		// with the caret at the very end. Anywhere else the arrows move the caret through the text.
		// Browsing stays a run of plain presses because a recall places the caret on the edge the key
		// came from — ↑ at position 0, ↓ at the end (stock pi-tui's directional anchor, #99) — so the
		// next press in the same direction satisfies the same rule; turning around takes one caret move.
		if (
			!expanded &&
			(e.key === "ArrowUp" || e.key === "ArrowDown") &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			!e.shiftKey
		) {
			const el = textareaRef.current;
			if (el) {
				const caretStart = el.selectionStart ?? 0;
				const caretEnd = el.selectionEnd ?? caretStart;
				const history = useInputHistoryStore.getState();
				const context = { cwd, owner: `${runtimeTabId}:${sessionId}`, device: historyDevice };
				const older = e.key === "ArrowUp";
				const wasBrowsing =
					history.navIndex !== -1 &&
					history.navContext?.owner === context.owner &&
					history.navContext?.cwd === context.cwd &&
					history.navContext?.device === context.device;
				const recalled =
					older && caretEnd === 0
						? history.prev(text, context)
						: !older && caretStart === text.length
							? history.next(context)
							: undefined;
				if (recalled !== undefined) {
					e.preventDefault();
					// The draft's own pictures step aside while browsing and come back with it.
					if (!wasBrowsing) navDraftImages.current = images;
					const backToDraft = useInputHistoryStore.getState().navIndex === -1;
					setImages(backToDraft ? navDraftImages.current : [...historyImages(recalled)]);
					placeDraft(recalled, older ? 0 : recalled.length);
					return;
				}
			}
		}
		// Line-adding keys (Shift+Enter, plain Enter while expanded) continue a markdown list.
		if (
			e.key === "Enter" &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			(e.shiftKey || expanded) &&
			continueListAtCaret()
		) {
			e.preventDefault();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			// The follow-up chord (⌃↵ on macOS, ⌥↵ on Windows) sends as a follow-up, queueing
			// behind the current yield (TUI app.message.followUp); idle sessions start
			// immediately either way. Every other Enter sends in the chip's mode, so the
			// platform's send chord (⌘↵, Ctrl+Enter on Windows) steers a running turn.
			const followUp = isComposerFollowUpKey(e);
			// Expanded: plain Enter is a newline; ⌘↵ sends and collapses.
			if (expanded && !e.metaKey && !e.ctrlKey && !followUp) return;
			e.preventDefault();
			// A held Enter sends once, never again on auto-repeat.
			if (e.repeat) return;
			if (expanded) setExpanded(false);
			send(undefined, followUp ? "followUp" : undefined);
		}
	};

	const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(e.clipboardData.files);
		if (files.length > 0) {
			e.preventDefault();
			attachFiles(files);
			return;
		}
		// Large TEXT paste (TUI editor.ts:1996-2044 parity): sanitize, then collapse
		// to a `[Paste #N]` marker past the marker threshold; past the (separate,
		// line-count-only) menu threshold, offer the inline/wrapped choice first.
		const pasted = e.clipboardData.getData("text/plain");
		if (!pasted) return;
		const content = pasted
			.replace(/\r\n?/g, "\n")
			.normalize("NFC")
			.replace(/\t/g, "   ")
			.replace(/[\x00-\x08\x0B-\x1F]/g, "");
		if (!isMarkerSized(content)) return; // small paste: default textarea behavior
		e.preventDefault();
		const lineCount = content.split("\n").length;
		if (shouldOfferPasteMenu(lineCount, pasteMenuThreshold)) {
			setPasteMenu({ content, lineCount });
			return;
		}
		insertPasteBlob(content);
	};

	const modeLabel = mode === "followUp" ? t("input.followUp") : t("input.steer");

	/** Splice text in at the caret (replacing a selection), space-separated from its neighbours. */
	const insertAtCaret = (insert: string) => {
		const el = textareaRef.current;
		const current = el?.value ?? text;
		const start = el?.selectionStart ?? current.length;
		const end = el?.selectionEnd ?? start;
		const before = current.slice(0, start);
		const after = current.slice(end);
		const inserted = `${before && !/\s$/.test(before) ? " " : ""}${insert}${/^\s/.test(after) ? "" : " "}`;
		el?.focus();
		placeDraft(`${before}${inserted}${after}`, start + inserted.length);
	};

	/**
	 * Picker, drop and clipboard files (composer-files.ts): images attach, other
	 * files and folders become `@path` mentions stock reads at send time (PDF and
	 * Office through its read tool), and a file this tab's machine cannot reach by
	 * path goes in as its text; the rest are refused with a reason.
	 */
	const attachFiles = (files: readonly File[]) => {
		if (files.length === 0) return;
		void intakeComposerFiles(files, {
			cwd,
			pathFor: file => window.omp.fs.pathForFile(file),
			remote: historyDevice !== undefined,
		}).then(async intake => {
			if (!mountedRef.current) return;
			const pieces = [
				...intake.mentions,
				...intake.texts.map(file => {
					const blob = storePaste(fileTextAttachment(file.name, file.content));
					return pasteMarkerText(blob.id, blob.content);
				}),
			];
			if (pieces.length > 0) insertAtCaret(pieces.join(" "));
			const reasons = {
				empty: "input.files.empty",
				tooLarge: "input.files.tooLarge",
				binary: historyDevice === undefined ? "input.files.noPath" : "input.files.remoteBinary",
				unreadable: "input.files.unreadable",
			} as const;
			for (const rejection of intake.rejected)
				toast({ variant: "warning", message: t(reasons[rejection.reason], { name: rejection.name }) });
			if (intake.images.length === 0) return;
			const added = await Promise.all(intake.images.map(fileToImage));
			setImages(previous => [...previous, ...added]);
		});
	};

	// Files dropped on the composer go through attachFiles like a paste; a Files
	// tree row becomes an @mention (C42); anything else keeps the browser
	// default (text drops insert into the field).
	const draggingFiles = (event: DragEvent<HTMLElement>) => {
		const types = Array.from(event.dataTransfer.types);
		return types.includes("Files") || types.includes(FILE_DRAG_TYPE);
	};
	const dropProps = {
		onDragEnter: (event: DragEvent<HTMLDivElement>) => {
			if (draggingFiles(event)) setDragActive(true);
		},
		onDragOver: (event: DragEvent<HTMLDivElement>) => {
			if (!draggingFiles(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
		},
		onDragLeave: (event: DragEvent<HTMLDivElement>) => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
		},
		onDrop: (event: DragEvent<HTMLDivElement>) => {
			setDragActive(false);
			if (!draggingFiles(event)) return;
			event.preventDefault();
			const row = readFileDrag(event.dataTransfer);
			if (row) {
				window.dispatchEvent(
					new CustomEvent("omp:insert-mention", { detail: { path: row.path, tabId: runtimeTabId } }),
				);
				return;
			}
			attachFiles(Array.from(event.dataTransfer.files));
		},
	};

	const sendDisabled =
		!routeReady || status !== "ready" || sending || submissionUncertain || (!text.trim() && images.length === 0);
	// While first-run setup runs, the live model is whatever omp fell back to
	// (e.g. a tiny on-device model); show the neutral prompt instead.
	const modelLabel = model && !settingUp ? model.name || model.id : t("input.chooseModel");
	const placeholder =
		status !== "ready"
			? t("input.placeholder.connecting")
			: nextPrompt !== undefined
				? nextPrompt
				: isStreaming
					? mode === "followUp"
						? t("input.placeholder.followUp")
						: t("input.placeholder.streaming")
					: isChat || fieldNarrow
						? t("input.placeholder.chat")
						: t("input.placeholder.idle");
	/** Tab-accept hint chip: only while the suggestion is the visible placeholder. */
	const showSuggestionHint = nextPrompt !== undefined && text === "";
	const suggestionHintId = useId();
	const menuId = useId();
	const menuIndex = menu?.index;
	// Home/End/PageDown/↓ can land on a row below the listbox's fold.
	useEffect(() => {
		if (menuIndex === undefined) return;
		document.getElementById(`${menuId}-${menuIndex}`)?.scrollIntoView?.({ block: "nearest" });
	}, [menuId, menuIndex]);
	/** Streaming with nothing to send: Stop takes the send slot instead of a dead Send. */
	const showSend = !isStreaming || text.trim() !== "" || images.length > 0;

	return (
		<div
			className={cx(
				"omp-composer-region relative shrink-0 bg-transparent pb-3",
				expanded && "omp-composer-region--expanded",
			)}
		>
			<div className="omp-composer-shell relative w-full">
				<AskDockSlot />
				{pasteMenu && (
					<div
						ref={pasteMenuRef}
						role="dialog"
						aria-label={t("input.paste.title", { lines: pasteMenu.lineCount, chars: pasteMenu.content.length })}
						className="omp-pop-in absolute right-0 bottom-full left-0 z-(--sc-z-popover) mb-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-3 shadow-(--sc-shadow-md)"
					>
						<div className="flex items-baseline justify-between gap-3">
							<span className="text-sc-md font-medium text-(--sc-text)">
								{t("input.paste.title", { lines: pasteMenu.lineCount, chars: pasteMenu.content.length })}
							</span>
							<span className="shrink-0 text-sc-sm text-(--sc-text-muted)">{t("input.paste.hint")}</span>
						</div>
						<pre className="mt-2 max-h-32 overflow-hidden rounded-(--sc-radius-md) border border-(--sc-divider) bg-(--sc-surface-1) px-2.5 py-2 font-mono text-sc-sm break-all whitespace-pre-wrap text-(--sc-text-secondary)">
							{(() => {
								const lines = pasteMenu.content.split("\n");
								if (lines.length <= 6) return pasteMenu.content;
								const head = lines.slice(0, 3).join("\n");
								const tail = lines.slice(-2).join("\n");
								return `${head}\n${t("input.paste.moreLines", { count: lines.length - 5 })}\n${tail}`;
							})()}
						</pre>
						<div className="mt-3 flex flex-wrap gap-2">
							<Button onClick={choosePasteInline} size="sm" variant="primary">
								{t("input.paste.inline")}
							</Button>
							<Button onClick={choosePasteWrapped} size="sm">
								{t("input.paste.wrap")}
							</Button>
							<Button onClick={choosePasteSaveFile} size="sm">
								{t("input.paste.saveFile")}
							</Button>
							<Button onClick={() => setPasteMenu(null)} size="sm" variant="ghost">
								{t("input.paste.cancel")}
							</Button>
						</div>
					</div>
				)}
				<ComposerQueue />

				{/* Anchoring context for completion/history overlays: they sit directly
				    above the input box instead of the surrounding composer region. */}
				<div className="omp-composer-anchor relative">
					{menu && (
						<div
							aria-label={t("input.completion.label")}
							className="absolute bottom-full left-0 z-(--sc-z-popover) mb-2 max-h-[60vh] w-[min(440px,100%)] overflow-y-auto rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-1 shadow-(--sc-shadow-md)"
							id={menuId}
							role="listbox"
						>
							{menu.items.map((item, index) => (
								<button
									aria-selected={index === menu.index}
									id={`${menuId}-${index}`}
									key={`${menu.source}:${item.label}`}
									type="button"
									role="option"
									onMouseDown={event => {
										event.preventDefault();
										insertCompletion(item);
									}}
									title={
										item.description
											? `${item.label}\n${item.description.replace(/\s+/g, " ").trim()}`
											: undefined
									}
									className={cx(
										"flex min-h-(--sc-control-md) w-full items-baseline gap-3 rounded-(--sc-radius-sm) px-2.5 py-1.5 text-left",
										index === menu.index ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
									)}
								>
									<span className="shrink-0 font-mono text-sc-md font-medium text-(--sc-text)">
										{item.label}
									</span>
									{item.description && (
										<span className="min-w-0 truncate text-sc-sm text-(--sc-text-muted)">
											{item.description}
										</span>
									)}
									{item.hint && (
										<span className="ml-auto shrink-0 font-mono text-sc-xs text-(--sc-text-subtle)">
											{item.hint}
										</span>
									)}
								</button>
							))}
						</div>
					)}

					{historySearchOpen && (
						<HistorySearchOverlay
							cwd={cwd}
							onSelect={prompt => {
								setHistorySearchOpen(false);
								textareaRef.current?.focus();
								placeDraft(prompt, prompt.length);
							}}
							onClose={() => {
								setHistorySearchOpen(false);
								requestAnimationFrame(() => textareaRef.current?.focus());
							}}
						/>
					)}
					{skillPickerOpen && (
						<SkillPickerOverlay
							skills={commands
								.filter(command => command.name.startsWith("skill:"))
								.map(command => ({
									name: command.name.slice("skill:".length),
									description: command.description ?? "",
								}))
								.sort((a, b) => a.name.localeCompare(b.name))}
							onClose={() => {
								setSkillPickerOpen(false);
								requestAnimationFrame(() => textareaRef.current?.focus());
							}}
							onManage={() => {
								setSkillPickerOpen(false);
								openSettings("tools:skills");
							}}
							onSelect={name => {
								setSkillPickerOpen(false);
								textareaRef.current?.focus();
								insertAtCaret(`/skill:${name}`);
							}}
						/>
					)}
					{chipsShown && (
						<NextPromptChips
							chips={nextPromptView.chips}
							handleRef={chipsRef}
							onPick={pickChip}
							onReturn={() => textareaRef.current?.focus()}
						/>
					)}
					{/* Focus and drag paint live in components.css (.omp-composer-box): the
					    field state follows the TEXT field, not any focused descendant, so a
					    focused toolbar control draws its own ring, never a ring in a ring. */}
					<div
						className="omp-composer-box relative flex flex-col rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field) shadow-(--sc-shadow-sm) transition-[border-color,box-shadow] duration-(--sc-duration-fast)"
						data-composer-mode={composerMode?.mode}
						data-drag-active={dragActive || undefined}
						{...dropProps}
					>
						{dragActive && (
							<div aria-hidden className="omp-composer-drop omp-fade-in">
								<Paperclip aria-hidden className="size-(--sc-icon-md)" />
								{t("input.dropFiles")}
							</div>
						)}
						{expanded && (
							<div className="flex items-center gap-2 border-b border-(--sc-divider) py-1.5 pr-2 pl-4">
								<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text-secondary)">
									{t("editor.title")}
								</span>
								<span className="text-sc-xs text-(--sc-text-muted) max-sm:hidden">
									{t("input.expanded.hint", { send: formatShortcut("⌘↵") })}
								</span>
								<Button
									icon={<ExternalLink aria-hidden />}
									loading={externalBusy}
									onClick={() => void openExternalEditor()}
									size="sm"
									variant="ghost"
								>
									{externalBusy ? t("editor.externalBusy") : t("editor.external")}
								</Button>
								<IconButton
									icon={<Minimize2 />}
									label={t("input.expanded.collapse")}
									onClick={() => toggleExpanded(false)}
									shortcut="⌃G"
									size="sm"
								/>
							</div>
						)}
						{submissionUncertain && (
							<Banner
								actions={
									<Button onClick={() => setSubmissionUncertain(false)} size="sm">
										{t("input.allowResend")}
									</Button>
								}
								className="m-2 mb-0"
								live
								variant="warning"
							>
								{t("input.deliveryUnknown")}
							</Banner>
						)}
						{images.length > 0 && (
							<ul aria-label={t("input.attachments")} className="flex flex-wrap gap-2.5 px-3 pt-3">
								{images.map((image, index) => (
									<li key={index} className="relative">
										<ZoomableImage
											src={image.preview}
											alt={t("input.attachmentAlt", { index: index + 1 })}
											className="size-14 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) object-cover"
											gallery={images.map((item, itemIndex) => ({
												src: item.preview,
												alt: t("input.attachmentAlt", { index: itemIndex + 1 }),
											}))}
											onRemove={() =>
												setImages(previous => previous.filter((_, itemIndex) => itemIndex !== index))
											}
										/>
										<IconButton
											className="omp-composer-attachment-remove absolute -top-1.5 -right-1.5"
											icon={<X />}
											label={t("input.removeAttachment", { index: index + 1 })}
											onClick={() =>
												setImages(previous => previous.filter((_, itemIndex) => itemIndex !== index))
											}
											size="sm"
											variant="secondary"
										/>
									</li>
								))}
							</ul>
						)}
						{draftPastes.length > 0 && (
							<ul aria-label={t("input.paste.listLabel")} className="flex flex-wrap gap-1.5 px-3 pt-3">
								{draftPastes.map(id => (
									<li key={id}>
										<button
											className="flex h-7 items-center gap-1.5 rounded-(--sc-radius-full) border border-(--sc-border-subtle) px-2.5 text-sc-xs text-(--sc-text-secondary) hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-2 focus-visible:outline-(--sc-accent)"
											data-paste-chip={id}
											onClick={() => setEditingPaste(id)}
											title={t("input.paste.edit")}
											type="button"
										>
											<ClipboardPaste aria-hidden className="size-(--sc-icon-sm) text-(--sc-text-muted)" />
											<span className="tabular-nums">
												{t("input.paste.chip", { id, lines: getPaste(id)?.lineCount ?? 0 })}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
						<DraftFileCards onRemove={path => setText(current => removeFileMention(current, path))} text={text} />
						<PastedTextDialog
							onClose={() => setEditingPaste(null)}
							onSave={(id, content) => {
								setText(current => editPaste(current, id, content));
								setEditingPaste(null);
							}}
							pasteId={editingPaste}
						/>
						<div className={cx("relative px-4 pt-3 pb-1", expanded && "flex min-h-0 flex-1 flex-col")}>
							<textarea
								ref={textareaRef}
								aria-activedescendant={menu ? `${menuId}-${menu.index}` : undefined}
								aria-autocomplete={menu ? "list" : undefined}
								aria-controls={menu ? menuId : undefined}
								aria-describedby={showSuggestionHint ? suggestionHintId : undefined}
								aria-label={t("input.ariaLabel")}
								autoCapitalize="sentences"
								autoCorrect="on"
								spellCheck
								value={text}
								onChange={event => {
									useInputHistoryStore.getState().resetNav();
									const value = event.target.value;
									// TUI parity (custom-editor.ts:1001-1007): the moment the buffer
									// becomes exactly the queue prefix, a newline starts the list body.
									if (value === "->" || value === "=>") {
										setText(`${value}\n`);
										return;
									}
									setText(value);
									// Emoji inline replace (TUI parity): `:name:` fires on the closing
									// colon, emoticons fire on a trailing space/tab/newline.
									if (emojiAutocomplete) {
										const caret = event.target.selectionStart ?? value.length;
										const before = value.slice(0, caret);
										void tryEmojiInlineReplace(before).then(hit => {
											if (!hit) return;
											const el = textareaRef.current;
											if (!el) return;
											// Stale-check: the user typed on meanwhile.
											const currentBefore = el.value.slice(0, el.selectionStart ?? el.value.length);
											if (currentBefore !== before) return;
											const nextText =
												before.slice(0, before.length - hit.replaceLen) +
												hit.insert +
												el.value.slice(before.length);
											placeDraft(nextText, before.length - hit.replaceLen + hit.insert.length);
										});
									}
								}}
								onKeyDown={handleKeyDown}
								onClick={() => {
									setMenu(null);
									inline.syncCaret();
								}}
								onFocus={inline.onFocus}
								onBlur={inline.onBlur}
								onCompositionStart={inline.onCompositionStart}
								onCompositionEnd={inline.onCompositionEnd}
								onKeyUp={inline.syncCaret}
								onSelect={inline.syncCaret}
								onPaste={handlePaste}
								rows={expanded ? undefined : 2}
								placeholder={placeholder}
								className={cx(
									"omp-composer-input w-full resize-none bg-transparent text-sc-lg break-keep text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle) focus-visible:outline-none",
									expanded ? "min-h-0 flex-1" : "max-h-[40vh] min-h-6",
									composerMode && "font-mono",
									showSuggestionHint && "pr-24",
								)}
							/>
							{inline.ghost !== null && (
								<div aria-hidden className="omp-inline-ghost text-sc-lg break-keep" data-inline-ghost>
									<span>{text}</span>
									<span className="omp-inline-ghost-text">{inline.ghost}</span>
									<Kbd shortcut="Tab" />
								</div>
							)}
							{dictation !== "idle" && (
								<DictationOverlay levels={dictationLevels} phase={dictation} startedAt={dictationStartedAt} />
							)}
							{showSuggestionHint && (
								<span
									className="pointer-events-none absolute top-3 right-4 flex h-6 items-center gap-1.5 text-sc-xs text-(--sc-text-subtle)"
									id={suggestionHintId}
								>
									<Kbd shortcut="Tab" />
									<Kbd shortcut="→" />
									{t("input.suggestion.accept")}
								</span>
							)}
						</div>

						{escHint ? (
							<div className="truncate px-4 pb-1 text-sc-xs text-(--sc-text-muted)" data-esc-hint role="status">
								{t("input.escAgainToClear")}
							</div>
						) : !menu && argHint ? (
							<div className="truncate px-4 pb-1 font-mono text-sc-xs text-(--sc-text-muted)">{argHint}</div>
						) : (
							nextPromptView.unavailable &&
							status === "ready" && (
								<div
									className="truncate px-4 pb-1 text-sc-xs text-(--sc-text-muted)"
									data-next-prompt-unavailable
									role="status"
									title={nextPromptView.unavailable.detail}
								>
									{t(`input.suggestion.unavailable.${nextPromptView.unavailable.reason}`)}
								</div>
							)
						)}

						<div
							aria-busy={!routeReady}
							aria-label={t("input.toolbar")}
							className="omp-composer-toolbar flex min-h-11 flex-wrap items-center gap-1 pr-2.5 pb-2.5 pl-2"
							inert={!routeReady}
							role="toolbar"
						>
							<MenuButton
								icon={<Plus />}
								items={[
									{
										id: "attach",
										label: t("input.attach"),
										icon: Paperclip,
										onSelect: () => fileInputRef.current?.click(),
									},
									{
										id: "history",
										label: t("input.history.title"),
										description: t("input.history.menuDesc"),
										icon: History,
										shortcut: "⌃R",
										onSelect: () => setHistorySearchOpen(true),
									},
									{
										id: "expand",
										label: expanded ? t("input.expanded.collapse") : t("input.expanded.open"),
										icon: expanded ? Minimize2 : Maximize2,
										shortcut: "⌃G",
										onSelect: () => toggleExpanded(),
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
										onSelect: () => setSkillPickerOpen(true),
									},
								]}
								label={t("input.addMenu")}
								side="above"
								size="sm"
							/>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								className="hidden"
								onChange={event => {
									attachFiles(Array.from(event.target.files ?? []));
									event.target.value = "";
								}}
							/>

							<ComposerModes />
							<RunSettings />
							<DelegationControl />

							{composerMode && (
								<Tooltip
									content={
										composerMode.mode === "bash" ? t("input.mode.bash.title") : t("input.mode.python.title")
									}
								>
									<span className="inline-flex">
										<Badge variant={composerMode.mode === "bash" ? "info" : "warning"}>
											{composerMode.mode === "bash"
												? t("input.mode.bash.badge")
												: t("input.mode.python.badge")}
										</Badge>
									</span>
								</Tooltip>
							)}
							{queueBody !== undefined && (
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
								<Tooltip content={model ? t("input.modelTooltip", { id: model.id }) : t("input.model")}>
									<Button
										aria-label={t("input.modelLabel", { model: modelLabel })}
										className="omp-composer-chip min-w-0 max-w-56"
										data-model-chip
										icon={<Cpu aria-hidden className="omp-composer-model-icon" />}
										onClick={() => openModelPicker()}
										size="sm"
										trailingIcon={
											<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />
										}
										variant="ghost"
									>
										<span className="omp-composer-model-label truncate">{modelLabel}</span>
									</Button>
								</Tooltip>
								{!settingUp && <ContextUsagePopover />}
								{sttEnabled && (
									<IconButton
										className={cx(
											recording && "bg-(--sc-danger-soft) text-(--sc-danger) hover:text-(--sc-danger)",
										)}
										icon={recording ? <Square className="omp-pulse-dot" fill="currentColor" /> : <Mic />}
										label={recording ? t("voice.mic.stop") : t("voice.mic.start")}
										onClick={handleMicClick}
										size="sm"
									/>
								)}
								{isStreaming && (
									<Tooltip content={t("input.sendModeHint")}>
										<Button
											aria-label={t("input.sendModeLabel", { mode: modeLabel })}
											className="omp-composer-chip"
											data-send-mode={mode === "followUp" ? "followUp" : "steer"}
											disabled={!routeReady}
											icon={mode === "followUp" ? <ListPlus aria-hidden /> : <CornerDownRight aria-hidden />}
											onClick={() => setMode(current => (current === "followUp" ? "steer" : "followUp"))}
											size="sm"
											variant="ghost"
										>
											<span className="omp-composer-control-label omp-composer-label-early">
												{modeLabel}
											</span>
										</Button>
									</Tooltip>
								)}
								{/* The turn's primary actions: a round Send that turns into Stop while a
								    turn runs with nothing to send; with a draft, Stop steps back beside it. */}
								<div className="ml-1 flex items-center gap-1.5">
									{isStreaming && (
										<IconButton
											className="omp-composer-action"
											disabled={!routeReady}
											icon={<Square className="omp-composer-stop-glyph" fill="currentColor" />}
											label={t("input.abort")}
											onClick={() => void abortActiveTurn(rpc, runtimeTabId)}
											shortcut="Esc"
											variant={showSend ? "secondary" : "primary"}
										/>
									)}
									{dictation === "recording" ? (
										<IconButton
											className="omp-composer-action"
											data-dictation-send
											disabled={!routeReady}
											icon={<ArrowUp strokeWidth={2.25} />}
											label={t("voice.dictation.stopAndSend")}
											onClick={() => {
												sendAfterDictationRef.current = true;
												stopVoiceRecording();
											}}
											variant="primary"
										/>
									) : (
										showSend && (
											<IconButton
												className="omp-composer-action"
												disabled={sendDisabled}
												icon={<ArrowUp strokeWidth={2.25} />}
												label={t("input.send")}
												onClick={() => {
													if (expanded) setExpanded(false);
													send();
													// The button disables itself once the draft clears; a disabled
													// focused control swallows keystrokes (⌘, and friends), so keep
													// typing focus in the composer like Enter does.
													textareaRef.current?.focus();
												}}
												variant="primary"
											/>
										)
									)}
								</div>
							</div>
						</div>
					</div>
				</div>
				<BelowEditorDockSlot />
			</div>
		</div>
	);
}
