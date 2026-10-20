/**
 * useComposerSubmit: the composer submit controller extracted from InputArea.
 * Owns the entire send pipeline: bash/python mode dispatch, yield-queue
 * shorthand, slash-command routing, and the prompt/steer/followUp dispatch.
 */

import { useCallback } from "react";
import type { AgentMessage, AvailableCommand } from "../../../../shared/rpc-types";
import { refreshNextPromptAfterBash } from "../../../hooks/use-next-prompt";
import { hydrateTabSession } from "../../../hooks/use-rpc-events";
import { endAutoPlan, runAutoMode } from "../../../lib/auto-mode-client";
import {
	isGuiOnlyBuiltinCommand,
	planComposerSubmit,
	SUBMIT_CANCELLED,
	settleComposerResponse,
} from "../../../lib/composer-submit";
import { expandEmoticons } from "../../../lib/emoji";
import { errorDetail } from "../../../lib/error-detail";
import { rememberHistoryImages } from "../../../lib/history-images";
import { useT } from "../../../lib/i18n";
import { parseComposerMode } from "../../../lib/input-modes";
import { abortActiveTurn, clearSessionContext } from "../../../lib/messages";
import { danglingPasteFragment, dropReferencedPastes, expandPasteMarkers } from "../../../lib/paste-blobs";
import { IMAGE_ONLY_CHIP } from "../../../lib/queue-chip";
import { parseQueueShorthand, splitQueuedMessages } from "../../../lib/queue-input";
import { parseSlashCommand } from "../../../lib/slash-command";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type ComposerImage, type ComposerStore, useComposerStore } from "../../../stores/composer";
import { useInputHistoryStore } from "../../../stores/input-history";
import { type MessagesStore, useMessagesStore } from "../../../stores/messages";
import { type PlanApprovalStore, usePlanApprovalStore } from "../../../stores/plan-approval";
import { type QueueStore, useQueueStore } from "../../../stores/queue";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { restoreTabComposer, useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { webRuntime } from "../../../web/runtime";
import { useAutoModePrefetch } from "./use-auto-mode-prefetch";

type SendMode = "prompt" | "steer" | "followUp";

export function useComposerSubmit({
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
}: {
	text: string;
	images: ComposerImage[];
	sending: boolean;
	status: string;
	isStreaming: boolean;
	mode: SendMode;
	queuedMessageCount: number;
	commands: AvailableCommand[];
	emojiAutocomplete: boolean;
	routeReady: boolean;
	setText: (next: string | ((current: string) => string)) => void;
	setImages: (next: ComposerImage[] | ((current: ComposerImage[]) => ComposerImage[])) => void;
	setMenu: (menu: null) => void;
	setSending: (value: boolean) => void;
}) {
	const t = useT();
	const rpc = useTabRpc();
	const contextTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const runtimeTabId = contextTabId ?? activeTabId;
	// The send's own expansion (below), so a question asked while typing is the one the send asks.
	const expandProse = useCallback(
		(draft: string) => (emojiAutocomplete ? expandEmoticons(expandPasteMarkers(draft)) : expandPasteMarkers(draft)),
		[emojiAutocomplete],
	);
	useAutoModePrefetch({ text, isStreaming, status, tabId: runtimeTabId, rpc, expand: expandProse });
	const send = useCallback(
		// `overrideText` sends a freshly computed value (voice dictation submit
		// trigger) instead of the rendered `text` state, which lags a setText.
		// `forceMode` overrides the steer/followUp toggle for one send (the follow-up chord).
		(overrideText?: string, forceMode?: SendMode) => {
			const message = (overrideText ?? text).trim();
			if ((!message && images.length === 0) || sending) return;
			// An edit that cut into a paste marker left text that names a paste but is not one: sending it would
			// hand the agent the literal fragment and lose the paste (DI-3).
			const fragment = danglingPasteFragment(message);
			if (fragment) {
				toast({ variant: "warning", message: t("input.paste.dangling", { fragment }) });
				return;
			}
			// ↑ history brings the pictures back with the text (stock keeps text only). History holds the
			// paste-expanded text, as stock's does: the blobs are freed once the send is accepted.
			const historyText = expandPasteMarkers(message);
			rememberHistoryImages(historyText, images);
			if (!routeReady || !runtimeTabId) return;
			// A tab whose omp is still starting takes the message: the tab runtime holds the command until it is ready.
			if (status !== "ready" && status !== "starting") {
				toast({ variant: "warning", message: t("input.agentConnecting") });
				return;
			}
			const originTabId = runtimeTabId;
			const originSession = sessionRuntimeStore<SessionStore>(originTabId, "session");
			const originComposer = sessionRuntimeStore<ComposerStore>(originTabId, "composer") ?? useComposerStore;
			if (originComposer.getState().sending || originComposer.getState().submissionUncertain) return;

			const originMessages = sessionRuntimeStore<MessagesStore>(originTabId, "messages") ?? useMessagesStore;
			const originSessionId = originSession?.getState().sessionId ?? useSessionStore.getState().sessionId;
			const originCwd = (originSession?.getState() ?? useSessionStore.getState()).cwd;
			const originDevice = useTabsStore.getState().tabs.find(tab => tab.id === originTabId)?.device;
			// A shared tab, or any tab a phone sends to, can be sent to by another device at the same moment:
			// whether a message joins the run (steer/follow-up) or starts one is the host's word, not this window's.
			const originTab = useTabsStore.getState().tabs.find(tab => tab.id === originTabId);
			const hostDecides = webRuntime() !== null || originTab?.shared === true || (originTab?.viewerCount ?? 0) > 0;
			const originStillActive = () =>
				originSession
					? sessionRuntimeStore<ComposerStore>(originTabId, "composer") === originComposer
					: useTabsStore.getState().activeTabId === originTabId &&
						useSessionStore.getState().sessionId === originSessionId;
			const restoreDraft = (draft: string, attachments: ComposerImage[]) =>
				restoreTabComposer(
					originTabId,
					originSessionId,
					draft,
					attachments,
					originSession ? originComposer : undefined,
				);

			let uncertain = false;
			const showSendError = (title: string, error: unknown) =>
				uncertain
					? toast({
							variant: "error",
							title: t("input.deliveryUnknownTitle"),
							message: t("input.deliveryUnknown"),
							detail: errorDetail(error),
						})
					: toastError({ title, error });
			const markUncertain = () => {
				uncertain = true;
				if (!originStillActive()) return;
				originComposer.getState().setSubmissionUncertain(true);
				if (originSession) void hydrateTabSession(originTabId);
			};

			// Paste markers expand to full blob content on every dispatch path (bash, python, prompt, queue
			// items): the wire only ever sees expanded text (TUI getExpandedText parity, regression #3737).
			// Which path a message takes is read from the draft as the user sees it, markers folded: a pasted
			// block that happens to start with `!`, `$ `, `/` or `->` stays a prompt, and the badge the
			// composer showed is the path it takes. Emoticon expansion runs at submit time over the prose
			// (input-controller.ts:617 — Enter without a trailing space after `:)`), never in a shell command
			// (`expandProse` above).
			const expandedMessage = expandProse(message);

			// ↑ history is a record of what the model received, so it is written only
			// once delivery is confirmed. Recording up front left every failed or
			// blocked send in the list, and a recalled entry replays a prompt that
			// never ran.
			const typedMode = parseComposerMode(message);
			const parsed = typedMode && { ...typedMode, body: expandPasteMarkers(typedMode.body) };
			// `! cmd` → bash, `$ code` → python mode (TUI parity): a running
			// ExecutionBubble stands in until the transcript record lands. Python's
			// language is left to the sidecar — interactive eval is python-only
			// today and the GUI tracks no kernel state to source it from.
			const execution =
				parsed?.body && parsed.mode === "bash"
					? {
							pending: {
								role: "bashExecution",
								command: parsed.body,
								excludeFromContext: parsed.excluded,
								timestamp: Date.now(),
								running: true,
							} satisfies AgentMessage,
							run: () =>
								rpc.bash(parsed.body, parsed.excluded).then(response => {
									// The command's output can change what the user says next.
									if (response.success) refreshNextPromptAfterBash(rpc);
									return response;
								}),
							failedTitle: t("input.bashFailed"),
						}
					: parsed?.body && parsed.mode === "python"
						? {
								pending: {
									role: "pythonExecution",
									code: parsed.body,
									timestamp: Date.now(),
									running: true,
								} satisfies AgentMessage,
								run: () => rpc.eval(parsed.body, undefined, parsed.excluded),
								failedTitle: t("input.evalFailed"),
							}
						: undefined;
			if (execution) {
				const { pending, failedTitle } = execution;
				const previousImages = images;
				setText("");
				setImages([]);
				setMenu(null);
				setSending(true);
				let accepted = false;
				originMessages?.getState().appendMessage(pending);
				void execution
					.run()
					.then(async response => {
						if (originStillActive()) originMessages?.getState().removeMessage(pending);
						if (!response.success) {
							if (response.code === "rpc_delivery_unknown") markUncertain();
							restoreDraft(message, previousImages);
							showSendError(failedTitle, response);
							return;
						}
						accepted = true;
						useInputHistoryStore.getState().record(historyText, originCwd, rpc, originDevice);
						if (!originStillActive()) return;
						dropReferencedPastes(message);
						await hydrateTabSession(originTabId);
					})
					.catch(error => {
						if (accepted) {
							toastError({ title: t("input.refreshFailed"), error });
							return;
						}
						markUncertain();
						if (originStillActive()) originMessages?.getState().removeMessage(pending);
						restoreDraft(message, previousImages);
						showSendError(failedTitle, error);
					})
					.finally(() => {
						if (originStillActive()) setSending(false);
					});
				return;
			}

			// `->` / `=>` yield-queue shorthand (TUI #queueForYield parity): split an
			// enumerated list into one queue entry per item; first item prompts with
			// streamingBehavior:"followUp" when idle, everything else followUps;
			// images ride on the first item only.
			const queueBody = parseQueueShorthand(message);
			if (queueBody !== undefined) {
				const payload = images.map(image => image.content);
				// Split the folded draft, then expand each item: a pasted block stays inside its own item.
				const items = splitQueuedMessages(queueBody).map(expandProse);
				// Bare prefix + no images hits the usage warning, it does NOT enqueue
				// (input-controller.ts:1186-1190). Images alone queue a single empty item.
				if (items.length === 0 && payload.length === 0) {
					toast({ variant: "warning", message: t("input.queue.usage") });
					return;
				}
				const previousImages = images;
				setText("");
				setImages([]);
				setMenu(null);
				const dispatchItems = items.length > 0 ? items : [""];
				if (dispatchItems.some(item => isGuiOnlyBuiltinCommand(item, commands))) {
					setText(message);
					setImages(previousImages);
					toast({ variant: "warning", message: t("input.queue.guiCommand") });
					return;
				}
				const startImmediately = hostDecides || (!isStreaming && queuedMessageCount === 0);
				if (hostDecides) for (const item of dispatchItems) originMessages.getState().noteOwnSend(item);
				// session.followUp throws on extension-command text (agent-session.ts:5508-5510),
				// so those items go through prompt, whose slash chain executes them.
				const extensionCommandNames = new Set(
					commands.filter(command => command.source === "extension").map(command => command.name),
				);
				setSending(true);
				void (async () => {
					let sent = 0;
					let deliveryPending = false;
					try {
						for (let index = 0; index < dispatchItems.length; index++) {
							if (!originStillActive()) throw new Error("Tab changed during queue dispatch");
							const item = dispatchItems[index] ?? "";
							const itemImages = index === 0 ? payload : undefined;
							if (itemImages && itemImages.length > 0 && !(startImmediately && index === 0)) {
								(sessionRuntimeStore<QueueStore>(originTabId, "queue") ?? useQueueStore)
									.getState()
									.expectImages(item || IMAGE_ONLY_CHIP, itemImages);
							}
							const isExtensionCommand = extensionCommandNames.has(parseSlashCommand(item)?.name ?? "");
							deliveryPending = true;
							const response =
								startImmediately && index === 0
									? await rpc.prompt(item, itemImages, "followUp")
									: isExtensionCommand
										? await rpc.prompt(item, itemImages)
										: await rpc.followUp(item, itemImages);
							deliveryPending = false;
							if (!response.success) {
								if (response.code === "rpc_delivery_unknown") markUncertain();
								throw new Error(response.error ?? "queue dispatch failed");
							}
							sent += 1;
						}
						// Only a fully dispatched shorthand enters history. A partial run
						// restores the unsent remainder as the draft, so recording the
						// original would offer ↑ a list whose first items already ran.
						useInputHistoryStore.getState().record(historyText, originCwd, rpc, originDevice);
						if (originStillActive()) dropReferencedPastes(message);
					} catch (error) {
						if (deliveryPending) markUncertain();
						if (sent === 0) {
							// Zero items sent: restore the original draft (markers) and images.
							restoreDraft(message, previousImages);
						} else {
							// Partial failure: restore the remainder in the exact shorthand
							// shape the parser can consume again. Continuation indentation
							// prevents marker-looking lines inside one item from splitting.
							const remaining = dispatchItems.slice(sent);
							const remainingDraft =
								remaining.length === 1
									? `=> ${remaining[0]}`
									: `=>\n${remaining
											.map((item, index) => `${index + 1}. ${item.replaceAll("\n", "\n   ")}`)
											.join("\n")}`;
							restoreDraft(remainingDraft, []);
							if (originStillActive()) dropReferencedPastes(message);
						}
						toast({
							variant: "error",
							title: uncertain ? t("input.deliveryUnknownTitle") : t("input.sendFailed"),
							message:
								sent > 0 ? t("input.queue.partial", { sent, total: dispatchItems.length }) : String(error),
						});
					} finally {
						if (originStillActive()) setSending(false);
					}
				})();
				return;
			}

			// Routing/guarding/hydration policy lives in lib/composer-submit:
			// slash commands always go through prompt (server parses them even
			// while streaming), session-replacing commands are blocked while
			// busy, and local-only resolutions rehydrate the transcript.
			const payload = images.map(image => image.content);
			// A plain prompt from an idle composer waits for the automatic mode choice (about a second on
			// the real judge) before it leaves. Until then Stop and Esc withdraw it (lib/messages.ts
			// abortActiveTurn): nothing reaches omp, a mode the choice already picked ends, the draft returns.
			const withdraw = new AbortController();
			let left = false;
			const session = originSession ?? useSessionStore;
			const submit = planComposerSubmit({
				message: expandedMessage,
				typed: message,
				images: payload,
				isStreaming,
				mode: forceMode ?? mode,
				commands,
				hostDecides,
				rpc,
				signal: withdraw.signal,
				beforePrompt: async () => {
					if (withdraw.signal.aborted) return null;
					const choice = await runAutoMode({
						message: expandedMessage,
						isStreaming,
						session,
						rpc,
						planPending:
							(
								sessionRuntimeStore<PlanApprovalStore>(originTabId, "planApproval") ?? usePlanApprovalStore
							).getState().pending !== null,
						// Stop and Esc return at once; a decision the host makes after that is ended when it lands.
						signal: withdraw.signal,
						onDeciding: deciding => originComposer.getState().setDecidingMode(deciding),
						onLateDecision: late => {
							if (late.mode === "goal") void abortActiveTurn(rpc, originTabId, "auto-mode");
							void rpc.autoModeEnd(late.mode === "goal" ? "goal" : "plan").catch(() => {});
						},
					});
					if (!withdraw.signal.aborted) left = true;
					else if (choice?.mode === "plan") await endAutoPlan(session, rpc);
					// Stock's `goal create` already started the goal's own turn: stopping it ends the goal too.
					else if (choice?.mode === "goal") await abortActiveTurn(rpc, originTabId, "auto-mode");
					return choice;
				},
			});
			if (submit.kind === "blocked") return;
			if (submit.kind === "handled") {
				useInputHistoryStore.getState().record(historyText, originCwd, rpc, originDevice);
				setText("");
				setImages([]);
				setMenu(null);
				dropReferencedPastes(message);
				return;
			}
			// Native /clear: drop context in place via clear_context RPC; the draft
			// is restored when the server refuses (busy).
			if (submit.kind === "clear") {
				const previousImages = images;
				setText("");
				setImages([]);
				setMenu(null);
				void clearSessionContext(rpc, () => hydrateTabSession(originTabId)).then(cleared => {
					if (cleared) {
						useInputHistoryStore.getState().record(historyText, originCwd, rpc, originDevice);
						if (originStillActive()) dropReferencedPastes(message);
						return;
					}
					restoreDraft(message, previousImages);
				});
				return;
			}
			const previousImages = images;
			const optimisticMessage: AgentMessage | undefined =
				!isStreaming && !message.startsWith("/")
					? {
							role: "user",
							content: [{ type: "text", text: expandedMessage }, ...payload],
							timestamp: Date.now(),
							optimistic: true,
							optimisticAfterEntryId:
								originMessages.getState().messages.findLast(entry => entry.entryId)?.entryId ?? null,
						}
					: undefined;
			if (optimisticMessage) originMessages.getState().appendLiveMessage(optimisticMessage);
			else if (hostDecides && !message.startsWith("/")) originMessages.getState().noteOwnSend(expandedMessage);
			// On a tab other devices send to, the host's own word that the prompt arrived (its echo claimed by the
			// delivery, or dropped on a failure) frees the composer too, so a slow reply to this window's request
			// never keeps it from steering. The request's own settling stays the fallback.
			let stopWatching: (() => void) | undefined;
			if (optimisticMessage && hostDecides) {
				stopWatching = originMessages.subscribe(state => {
					if (state.liveMessages.includes(optimisticMessage)) return;
					stopWatching?.();
					if (originStillActive()) setSending(false);
				});
			}
			// Sending owns the live edge: pull the transcript back to the bottom even
			// when the user had scrolled up through history before pressing Enter.
			(originSession ?? useSessionStore).getState().pinTranscriptToBottom();
			setText("");
			setImages([]);
			setMenu(null);
			setSending(true);
			// A message with pictures that joins the run shows up as a text-only queue chip: remember its pictures
			// for the tray (the chip's id is assigned later, in main).
			if (payload.length > 0 && (isStreaming || hostDecides) && !message.startsWith("/")) {
				(sessionRuntimeStore<QueueStore>(originTabId, "queue") ?? useQueueStore)
					.getState()
					.expectImages(expandedMessage || IMAGE_ONLY_CHIP, payload);
			}
			const cancelSubmit = optimisticMessage
				? () => {
						if (left || withdraw.signal.aborted) return false;
						withdraw.abort();
						return true;
					}
				: null;
			if (cancelSubmit) originComposer.getState().setCancelSubmit(cancelSubmit);
			let accepted = false;
			// Let React commit the cleared draft before contextBridge serializes the
			// request payload. On large sessions/attachments that synchronous bridge
			// work used to make Enter look ignored for a noticeable beat.
			setTimeout(() => {
				if (!originStillActive()) {
					stopWatching?.();
					if (optimisticMessage) originMessages.getState().removeLiveMessage(optimisticMessage);
					restoreDraft(message, previousImages);
					return;
				}
				void submit
					.request()
					.then(async response => {
						if (!response.success) {
							if (optimisticMessage) originMessages.getState().removeLiveMessage(optimisticMessage);
							restoreDraft(message, previousImages);
							if (response.code === SUBMIT_CANCELLED) return;
							if (response.code === "rpc_delivery_unknown") markUncertain();
							showSendError(t("input.sendFailed"), response);
							return;
						}
						accepted = true;
						useInputHistoryStore.getState().record(historyText, originCwd, rpc, originDevice);
						if (!originStillActive()) return;
						dropReferencedPastes(message);
						await settleComposerResponse(response, () => hydrateTabSession(originTabId));
					})
					.catch(error => {
						if (accepted) {
							toastError({ title: t("input.refreshFailed"), error });
							return;
						}
						markUncertain();
						if (optimisticMessage) originMessages.getState().removeLiveMessage(optimisticMessage);
						restoreDraft(message, previousImages);
						showSendError(t("input.sendFailed"), error);
					})
					.finally(() => {
						stopWatching?.();
						if (cancelSubmit && originComposer.getState().cancelSubmit === cancelSubmit)
							originComposer.getState().setCancelSubmit(null);
						if (originStillActive()) setSending(false);
					});
			}, 0);
		},
		[
			text,
			images,
			sending,
			status,
			isStreaming,
			mode,
			queuedMessageCount,
			commands,
			expandProse,
			routeReady,
			rpc,
			runtimeTabId,
			t,
			setText,
			setImages,
			setSending,
			setMenu,
		],
	);

	return send;
}
