import {
	ArrowUp,
	ChevronDown,
	CornerDownRight,
	ExternalLink,
	History,
	ImagePlus,
	ListPlus,
	Maximize2,
	Mic,
	Minimize2,
	Paperclip,
	Plus,
	Square,
	X,
} from "lucide-react";
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AvailableCommand, ImageContent } from "../../../shared/rpc-types";
import { withGuiCommands } from "../../lib/command-registry";
import { useDisplayPreference } from "../../lib/display-preferences";
import { tryEmojiInlineReplace } from "../../lib/emoji";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { parseComposerMode } from "../../lib/input-modes";
import { formatShortcut } from "../../lib/keymap";
import { abortActiveTurn } from "../../lib/messages";
import { NEXT_PROMPT_WIDGET } from "../../lib/next-prompt";
import {
	dropReferencedPastes,
	expandPasteMarkers,
	isMarkerSized,
	pasteMarkerText,
	shouldOfferPasteMenu,
	storePaste,
	wrapPasteInAttachmentBlock,
} from "../../lib/paste-blobs";
import { parseQueueShorthand, splitQueuedMessages } from "../../lib/queue-input";
import { useTabRpc } from "../../lib/tab-rpc";
import {
	cancelVoiceRecording,
	evaluateSttSubmitTrigger,
	readSttSubmitTrigger,
	recordAndTranscribe,
	stopVoiceRecording,
} from "../../lib/voice";
import { type ComposerStore, useComposerStore } from "../../stores/composer";
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
import { Badge, Banner, Button, IconButton, Kbd, MenuButton, Spinner, Tooltip } from "../common";
import { AskDockSlot } from "../dialogs/ask-dock";
import { ComposerModes } from "./ComposerModes";
import { ComposerQueue } from "./ComposerQueue";
import { ContextUsagePopover } from "./ContextUsagePopover";
import { HistorySearchOverlay } from "./HistorySearchOverlay";
import { fileToImage, listMentionFiles, mentionFileCache } from "./input-area-utils";
import { RunSettings } from "./RunSettings";
import { type CompletionItem, type CompletionMenu, useCompletionMenu } from "./use-completion-menu";
import { useComposerSubmit } from "./use-composer-submit";

type SendMode = "prompt" | "steer" | "followUp";

const MENTION_FS_DEBOUNCE_MS = 150;

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
	const storedNextPrompt = useNextPromptStore(s => (nextPromptKey ? s.suggestions[nextPromptKey] : undefined));
	const nextPrompt = status === "ready" && !isStreaming ? storedNextPrompt : undefined;
	useEffect(() => {
		if (nextPromptKey) useNextPromptStore.getState().recordWidget(nextPromptKey, nextPromptLines);
	}, [nextPromptKey, nextPromptLines]);
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
	const [commands, setCommands] = useState<AvailableCommand[]>([]);
	const sending = useComposerStore(state => state.sending);
	const setSending = useComposerStore(state => state.setSending);
	const submissionUncertain = useComposerStore(state => state.submissionUncertain);
	const setSubmissionUncertain = useComposerStore(state => state.setSubmissionUncertain);
	const [filePaths, setFilePaths] = useState<string[]>([]);
	const [historySearchOpen, setHistorySearchOpen] = useState(false);
	const [recording, setRecording] = useState(false);
	/** Pending large-paste choice: the paste already happened, this picks the form. */
	const [pasteMenu, setPasteMenu] = useState<{ content: string; lineCount: number } | null>(null);
	const pasteMenuRef = useRef<HTMLDivElement>(null);
	/** ⌃G: the composer expands in place to fill the session pane (design-spec §2.2). */
	const [expanded, setExpanded] = useState(false);
	const [externalBusy, setExternalBusy] = useState(false);
	const [dragActive, setDragActive] = useState(false);
	const isEmptySession = useMessagesStore(s => s.messages.length === 0);
	const focusedPane = contextTabId === null || contextTabId === activeTabId;

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const mountedRef = useRef(true);

	// New and empty sessions start with the caret in the composer, unless
	// something else (a dialog, another field) already holds focus.
	useEffect(() => {
		if (!routeReady || !focusedPane || !isEmptySession || !sessionId) return;
		const active = document.activeElement;
		if (active && active !== document.body) return;
		textareaRef.current?.focus();
	}, [routeReady, focusedPane, isEmptySession, sessionId]);

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

	// Load persisted prompt history once (prefs IPC).
	useEffect(() => {
		void useInputHistoryStore.getState().hydrate();
	}, []);

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

	// Contextual argument hint (TUI ghost-text parity): the command's usage
	// hint, or the unique-matching subcommand's remainder + usage. Rendered as
	// a dim row under the textarea — an inline-after-cursor ghost needs
	// pixel-aligned overlay metrics that break with auto-grow/IME (same
	// tradeoff as the queue highlight).
	const argHint = useMemo(() => {
		if (menu || !text.startsWith("/")) return "";
		const cursor = textareaRef.current?.selectionStart ?? text.length;
		if (cursor !== text.length) return "";
		const match = /^\/([a-z-]+)(?:\s(\S*))?$/i.exec(text);
		if (!match) return "";
		const name = (match[1] ?? "").toLowerCase();
		const command = commands.find(
			candidate =>
				candidate.name.toLowerCase() === name || candidate.aliases?.some(alias => alias.toLowerCase() === name),
		);
		if (!command) return "";
		const argPrefix = match[2] ?? "";
		if (argPrefix === "") return command.input?.hint ?? "";
		if (command.subcommands?.length) {
			const lower = argPrefix.toLowerCase();
			const sub = command.subcommands.find(candidate => candidate.name.startsWith(lower));
			if (sub) return [sub.name.slice(lower.length), sub.usage].filter(Boolean).join(" ");
		}
		return "";
	}, [text, menu, commands]);

	// Keep slash commands current across sidecar startup and extension reloads.
	useEffect(() => {
		let cancelled = false;
		const applyCommands = (next: AvailableCommand[], tabId: string | null) => {
			if (!cancelled && tabId === runtimeTabId) setCommands(withGuiCommands(next));
		};
		const unsubscribe =
			typeof window.omp.events.onTabCommandsUpdate === "function"
				? window.omp.events.onTabCommandsUpdate(applyCommands)
				: window.omp.events.onCommandsUpdate(next => applyCommands(next, runtimeTabId));
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

	useCompletionMenu({
		text,
		filePaths,
		commands,
		emojiAutocomplete,
		textareaRef,
		setMenu,
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
			if (detail?.clearPastes) dropReferencedPastes(useComposerStore.getState().draft);
			// prepend (dequeue restore): queued text goes ahead of any draft, TUI-style;
			// otherwise replace (starter cards, history recall).
			setText(current => {
				if (!next) return current;
				return detail?.prepend && current.trim() ? `${next}\n\n${current}` : next;
			});
			if (restoredImages.length > 0) {
				setImages(current => [
					...current,
					...restoredImages.map(content => ({
						content,
						preview: `data:${content.mimeType};base64,${content.data}`,
					})),
				]);
			}
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (!el) return;
				el.focus();
				if (next) el.setSelectionRange(next.length, next.length);
			});
		};
		window.addEventListener("omp:fill-composer", fillComposer);
		return () => window.removeEventListener("omp:fill-composer", fillComposer);
	}, [
		// prepend (dequeue restore): queued text goes ahead of any draft, TUI-style;
		// otherwise replace (starter cards, history recall).
		setText,
		setImages,
		runtimeTabId,
	]);

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
			setText(replaced);
			setMenu(null);
			requestAnimationFrame(() => {
				el.focus();
				const newPos = menu.rangeStart + item.value.length;
				el.setSelectionRange(newPos, newPos);
			});
		},
		[text, menu, setText],
	);

	// Collapse a large paste into a `[Paste #N]` marker with the blob held in
	// memory; the marker expands back to full content at submit time (TUI
	// editor.ts parity). Inserted at the caret, replacing any selection.
	const insertPasteBlob = useCallback(
		(content: string) => {
			const blob = storePaste(content);
			const marker = pasteMarkerText(blob.id, blob.content);
			const el = textareaRef.current;
			const start = el?.selectionStart ?? text.length;
			const end = el?.selectionEnd ?? start;
			setText(current => `${current.slice(0, start)}${marker}${current.slice(end)}`);
			requestAnimationFrame(() => {
				const target = textareaRef.current;
				if (!target) return;
				target.focus();
				const caret = start + marker.length;
				target.setSelectionRange(caret, caret);
			});
		},
		[text, setText],
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
				const start = el?.selectionStart ?? text.length;
				const end = el?.selectionEnd ?? start;
				const insert = `${data.url} `;
				setText(currentText => `${currentText.slice(0, start)}${insert}${currentText.slice(end)}`);
				requestAnimationFrame(() => {
					const target = textareaRef.current;
					if (!target) return;
					target.focus();
					const caret = start + insert.length;
					target.setSelectionRange(caret, caret);
				});
			} catch (cause) {
				// The RPC threw (transport/permission): without the origin gate the
				// inline fallback would splice clipboard content into whichever
				// composer is now foreground.
				if (!stillOrigin()) return;
				toastError({ title: t("input.paste.saveFailed"), error: cause });
				insertPasteBlob(pendingPaste.content);
			}
		})();
	}, [insertPasteBlob, pasteMenu, text, t, setText, runtimeTabId, rpc]);

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

	// Mic dictation (stt.enabled): click starts capture, click again stops and
	// transcribes; the transcript inserts at the textarea caret. The
	// stt.submitTrigger setting can auto-submit the utterance (TUI parity).
	const handleMicClick = useCallback(() => {
		if (recording) {
			stopVoiceRecording();
			return;
		}
		setRecording(true);
		void recordAndTranscribe().then(async result => {
			if (!mountedRef.current) return;
			setRecording(false);
			if ("error" in result) {
				if (result.error) toastError({ title: t("voice.mic.failed"), error: result });
				return;
			}
			const utterance = result.text.trim();
			if (!utterance) return;
			const trigger = await readSttSubmitTrigger();
			const evaluation = evaluateSttSubmitTrigger(utterance, trigger);
			const insert = (
				evaluation.trimTrailing > 0 ? utterance.slice(0, utterance.length - evaluation.trimTrailing) : utterance
			).trimEnd();
			if (!insert || !mountedRef.current) return;
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
			setText(next);
			requestAnimationFrame(() => {
				const target = textareaRef.current;
				if (!target) return;
				target.focus();
				const caret = start + insertedText.length;
				target.setSelectionRange(caret, caret);
			});
			if (evaluation.submit) send(next);
		});
	}, [recording, send, t, setText]);

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
		if (
			nextPrompt !== undefined &&
			text === "" &&
			(e.key === "Tab" || e.key === "ArrowRight") &&
			!e.shiftKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			!isImeKeyEvent(e)
		) {
			e.preventDefault();
			setText(nextPrompt);
			return;
		}
		if (menu && ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
			setMenu(null);
			return;
		}
		if (menu) {
			const count = menu.items.length;
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
		// Up/Down prompt-history recall: Up from the first line cycles to older
		// entries, Down from the last line cycles back to the stashed draft.
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
				let recalled: string | undefined;
				if (e.key === "ArrowUp" && !text.slice(0, caretStart).includes("\n")) {
					recalled = history.prev(text, { cwd, owner: `${runtimeTabId}:${sessionId}` });
				} else if (e.key === "ArrowDown" && !text.slice(caretEnd).includes("\n")) {
					recalled = history.next({ cwd, owner: `${runtimeTabId}:${sessionId}` });
				}
				if (recalled !== undefined) {
					e.preventDefault();
					const recalledText = recalled;
					setText(recalledText);
					requestAnimationFrame(() => {
						el.focus();
						el.setSelectionRange(recalledText.length, recalledText.length);
					});
					return;
				}
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			// Expanded: plain Enter is a newline; ⌘↵ sends and collapses.
			if (expanded && !e.metaKey && !e.ctrlKey) return;
			e.preventDefault();
			if (expanded) setExpanded(false);
			// ⌃Enter — send as follow-up, queueing behind the current yield (TUI
			// app.message.followUp). Idle sessions start immediately either way.
			send(undefined, e.ctrlKey && !e.metaKey && !e.altKey ? "followUp" : undefined);
		}
	};

	const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
		if (files.length > 0) {
			e.preventDefault();
			void Promise.all(files.map(fileToImage)).then(pasted => setImages(prev => [...prev, ...pasted]));
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

	const addImageFiles = (files: readonly File[]) => {
		const imageFiles = files.filter(file => file.type.startsWith("image/"));
		if (imageFiles.length === 0) return;
		void Promise.all(imageFiles.map(fileToImage)).then(added => setImages(previous => [...previous, ...added]));
	};

	// Image files dropped on the composer attach like a paste; anything else
	// keeps the browser default (text drops insert into the field).
	const draggingFiles = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files");
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
			addImageFiles(Array.from(event.dataTransfer.files));
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
					: isChat
						? t("input.placeholder.chat")
						: t("input.placeholder.idle");
	/** Tab-accept hint chip: only while the suggestion is the visible placeholder. */
	const showSuggestionHint = nextPrompt !== undefined && text === "";
	const suggestionHintId = useId();
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
							role="listbox"
						>
							{menu.items.map((item, index) => (
								<button
									aria-selected={index === menu.index}
									key={`${menu.source}:${item.label}`}
									type="button"
									role="option"
									onMouseDown={event => {
										event.preventDefault();
										insertCompletion(item);
									}}
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
								setText(prompt);
								requestAnimationFrame(() => {
									const el = textareaRef.current;
									if (!el) return;
									el.focus();
									el.setSelectionRange(prompt.length, prompt.length);
								});
							}}
							onClose={() => {
								setHistorySearchOpen(false);
								requestAnimationFrame(() => textareaRef.current?.focus());
							}}
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
								<ImagePlus aria-hidden className="size-(--sc-icon-md)" />
								{t("input.dropImages")}
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
									disabled={externalBusy}
									icon={externalBusy ? <Spinner inheritColor size="sm" /> : <ExternalLink aria-hidden />}
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
										<img
											src={image.preview}
											alt={t("input.attachmentAlt", { index: index + 1 })}
											className="size-14 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) object-cover"
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
						<div className={cx("relative px-4 pt-3 pb-1", expanded && "flex min-h-0 flex-1 flex-col")}>
							<textarea
								ref={textareaRef}
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
											setText(nextText);
											requestAnimationFrame(() => {
												const target = textareaRef.current;
												if (!target) return;
												const nextCaret = before.length - hit.replaceLen + hit.insert.length;
												target.setSelectionRange(nextCaret, nextCaret);
											});
										});
									}
								}}
								onKeyDown={handleKeyDown}
								onClick={() => setMenu(null)}
								onPaste={handlePaste}
								rows={expanded ? undefined : 2}
								placeholder={placeholder}
								className={cx(
									"w-full resize-none bg-transparent text-sc-lg break-keep text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle) focus-visible:outline-none",
									expanded ? "min-h-0 flex-1" : "max-h-[40vh] min-h-6",
									composerMode && "font-mono",
									showSuggestionHint && "pr-24",
								)}
							/>
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

						{argHint && (
							<div className="truncate px-4 pb-1 font-mono text-sc-xs text-(--sc-text-muted)">{argHint}</div>
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
								]}
								label={t("input.addMenu")}
								size="sm"
							/>
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*"
								multiple
								className="hidden"
								onChange={event => {
									addImageFiles(Array.from(event.target.files ?? []));
									event.target.value = "";
								}}
							/>

							<ComposerModes />
							<RunSettings />

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
										pressed={recording}
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
									{showSend && (
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
									)}
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
