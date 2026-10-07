/**
 * Extension UI dispatcher: renders the oldest pending extension_ui_request
 * as the right surface (select / confirm / input / editor / open_url as
 * modals, `ask` as a non-modal card docked above the composer), routes
 * tool-approval selects to ApprovalDialog, turns `notify` into a toast, and
 * enforces request timeouts with a visible countdown.
 *
 * `setStatus` / `setWidget` are captured by the extension-ui store and
 * surfaced here as floating status segments / widget panels.
 * `setTitle` / `set_editor_text` / `cancel` are consumed by the store /
 * event router and never render here; if one slips into the queue it is
 * dropped silently.
 */

import type { EditorView } from "@codemirror/view";
import { Check, ExternalLink, MessageCircleQuestion } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ExtensionAskDialogResult, ExtensionUIRequest } from "../../../shared/rpc-types";
import { AnsiText } from "../../lib/ansi";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { MarkdownRenderer } from "../../lib/markdown";
import { NEXT_PROMPT_WIDGET } from "../../lib/next-prompt";
import { isInlineLoginRequest, useExtensionUiStore } from "../../stores/extension-ui";
import { toast } from "../../stores/toast";
import { Badge, Button, Input, Modal, Spinner } from "../common";
import { ApprovalDialog, isApprovalRequest } from "./ApprovalDialog";
import { useAskDock } from "./ask-dock";

/** Requests handled elsewhere (store/router) — never rendered as dialogs. */
const NON_DIALOG_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "cancel"]);

/**
 * Floating surface for extension-pushed widgets. Transient `setStatus` text is
 * intentionally not rendered: the GUI has no status line, and floating pills
 * obscure composer controls. The `next-prompt` widget is the composer's
 * placeholder (InputArea), not a panel.
 */
function ExtensionSurfaces() {
	const widgetPanels = useExtensionUiStore(state => state.widgetPanels);
	const widgets = Object.entries(widgetPanels).filter(([key]) => key !== NEXT_PROMPT_WIDGET);
	if (widgets.length === 0) return null;
	return (
		<div className="pointer-events-none fixed bottom-9 left-1/2 z-40 flex max-h-[40vh] w-[min(560px,92vw)] -translate-x-1/2 flex-col gap-1.5 overflow-y-auto">
			{widgets.map(([key, lines]) => (
				<div
					aria-label={key}
					className="pointer-events-auto rounded-md border border-(--omp-border-muted) bg-(--omp-bg-elevated) px-2.5 py-1.5 shadow-lg shadow-black/40"
					key={key}
					role="region"
				>
					<div className="mb-0.5 text-omp-xxs font-medium tracking-widest text-(--omp-dim) uppercase">{key}</div>
					{lines.map((line, index) => (
						<div
							className="font-mono text-omp-xs leading-snug break-words whitespace-pre-wrap text-(--omp-text)"
							key={index}
						>
							{line === "" ? "\u00A0" : <AnsiText text={line} />}
						</div>
					))}
				</div>
			))}
		</div>
	);
}

function useCountdown(request: ExtensionUIRequest | null): number | null {
	const requestId = request?.id ?? null;
	const timeout =
		request && request.method === "select"
			? request.timeout
			: request && request.method === "confirm"
				? request.timeout
				: request && (request.method === "input" || request.method === "ask")
					? request.timeout
					: undefined;
	// Remaining time is derived PER REQUEST at render: a state-only countdown
	// leaked the previous request's last value (0ms) into the next commit,
	// whose auto-cancel effect then answered the new request as timed out
	// before the reset could render.
	const [, setTick] = useState(0);
	const startedAtRef = useRef<{ id: string | null; at: number }>({ id: null, at: 0 });
	if (startedAtRef.current.id !== requestId) {
		startedAtRef.current = { id: requestId, at: Date.now() };
	}
	const startedAt = startedAtRef.current.at;

	useEffect(() => {
		if (timeout === undefined) return;
		const timer = setInterval(() => setTick(v => v + 1), 200);
		return () => clearInterval(timer);
	}, [timeout]);

	if (timeout === undefined) return null;
	const remaining = Math.max(0, timeout - (Date.now() - startedAt));
	return remaining;
}

function TimeoutFooter({ remaining }: { remaining: number | null }) {
	const t = useT();
	if (remaining === null) return null;
	return (
		<span className="text-omp-xs tabular-nums text-(--omp-dim)">
			{t("extDialog.autoDismiss", { seconds: Math.ceil(remaining / 1000) })}
		</span>
	);
}

function SelectDialog({
	request,
	remaining,
	onValue,
	onCancel,
}: {
	request: Extract<ExtensionUIRequest, { method: "select" }>;
	remaining: number | null;
	onValue: (value: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	return (
		<Modal onClose={onCancel} open size="sm" title={request.title}>
			<div className="space-y-1">
				{request.options.map((option, index) => (
					<button
						autoFocus={index === 0}
						className="flex w-full items-center gap-2 rounded-md border border-(--omp-border-muted) px-3 py-2 text-left text-xs text-(--omp-text) transition-colors hover:border-(--omp-border-accent) hover:bg-(--omp-selected-bg) focus-visible:outline-2 focus-visible:outline-(--omp-border-accent)"
						key={option}
						onClick={() => onValue(option)}
						type="button"
					>
						<span className="w-4 shrink-0 text-omp-xs text-(--omp-dim)">{index + 1}</span>
						<span className="min-w-0 break-words">
							<span className="block">{option}</span>
							{request.optionDetails?.[index]?.description && (
								<span className="mt-1 block text-omp-xs whitespace-pre-wrap text-(--omp-muted)">
									{request.optionDetails[index].description}
								</span>
							)}
						</span>
					</button>
				))}
				<div className="flex items-center justify-between pt-2">
					<TimeoutFooter remaining={remaining} />
					<Button onClick={onCancel} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function ConfirmDialog({
	request,
	remaining,
	onConfirm,
	onCancel,
}: {
	request: Extract<ExtensionUIRequest, { method: "confirm" }>;
	remaining: number | null;
	onConfirm: (confirmed: boolean) => void;
	onCancel: () => void;
}) {
	const t = useT();
	return (
		<Modal onClose={onCancel} open size="sm" title={request.title}>
			<p className="text-xs leading-relaxed break-words whitespace-pre-wrap text-(--omp-muted)">{request.message}</p>
			<div className="mt-4 flex items-center justify-between gap-2">
				<TimeoutFooter remaining={remaining} />
				<div className="flex gap-2">
					<Button onClick={() => onConfirm(false)} size="sm" variant="ghost">
						{t("approval.deny")}
					</Button>
					<Button autoFocus onClick={() => onConfirm(true)} size="sm" variant="primary">
						{t("approval.approve")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function InputDialog({
	request,
	remaining,
	onValue,
	onCancel,
}: {
	request: Extract<ExtensionUIRequest, { method: "input" }>;
	remaining: number | null;
	onValue: (value: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [value, setValue] = useState("");
	return (
		<Modal onClose={onCancel} open size="sm" title={request.title}>
			<form
				className="space-y-3"
				onSubmit={event => {
					event.preventDefault();
					onValue(value);
				}}
			>
				<Input
					autoFocus
					onChange={event => setValue(event.target.value)}
					placeholder={request.placeholder}
					value={value}
				/>
				<div className="flex items-center justify-between gap-2">
					<TimeoutFooter remaining={remaining} />
					<div className="flex gap-2">
						<Button onClick={onCancel} size="sm" type="button" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button size="sm" type="submit" variant="primary">
							{t("extDialog.submit")}
						</Button>
					</div>
				</div>
			</form>
		</Modal>
	);
}

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Places the ask card in the composer dock of the current session (in flow,
 * directly above the composer, same width). Without a mounted composer — e.g.
 * Settings is open — it floats at the bottom of the window at composer width.
 * Either way there is no scrim: the transcript stays visible and interactive.
 */
function AskDock({ children }: { children: ReactNode }) {
	const dock = useAskDock();
	if (dock) return createPortal(children, dock);
	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-3 z-(--sc-z-popover)">
			<div className="omp-composer-shell pointer-events-auto">{children}</div>
		</div>
	);
}

interface AskAnswerState {
	selected: Set<string>;
	custom: string;
	note: string;
}

/**
 * Multi-question ask card: each question renders its options as checkboxes
 * (multi) or radio rows (single), plus an optional custom-answer input and an
 * optional note input. Single-select mirrors the TUI: picking an option
 * replaces the custom answer, typing one clears the option selection.
 * Non-modal: docked above the composer, focus moves in on open and returns on
 * close; Escape inside the card cancels.
 */
function AskDialog({
	request,
	remaining,
	onSubmit,
	onCancel,
}: {
	request: Extract<ExtensionUIRequest, { method: "ask" }>;
	remaining: number | null;
	onSubmit: (result: ExtensionAskDialogResult) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const cardRef = useRef<HTMLElement>(null);

	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const card = cardRef.current;
		(card?.querySelector<HTMLElement>(FOCUSABLE) ?? card)?.focus();
		return () => {
			// Return focus (normally the composer) only if it was still in the card.
			const active = document.activeElement;
			if (!active || active === document.body || card?.contains(active)) opener?.focus();
		};
	}, []);
	const [answers, setAnswers] = useState<AskAnswerState[]>(() =>
		request.questions.map(() => ({ selected: new Set<string>(), custom: "", note: "" })),
	);

	const toggleOption = (questionIndex: number, label: string) => {
		setAnswers(prev =>
			prev.map((answer, index) => {
				if (index !== questionIndex) return answer;
				if (request.questions[questionIndex]?.multi) {
					const selected = new Set(answer.selected);
					if (selected.has(label)) selected.delete(label);
					else selected.add(label);
					return { ...answer, selected };
				}
				// Single-select: picking an option replaces any custom answer.
				return { ...answer, selected: new Set([label]), custom: "" };
			}),
		);
	};

	const setCustom = (questionIndex: number, custom: string) => {
		setAnswers(prev =>
			prev.map((answer, index) => {
				if (index !== questionIndex) return answer;
				// Single-select: typing a custom answer clears the option selection.
				if (!request.questions[questionIndex]?.multi && custom.trim() !== "") {
					return { ...answer, custom, selected: new Set<string>() };
				}
				return { ...answer, custom };
			}),
		);
	};

	const setNote = (questionIndex: number, note: string) => {
		setAnswers(prev => prev.map((answer, index) => (index === questionIndex ? { ...answer, note } : answer)));
	};

	const unansweredCount = request.questions.reduce((count, _question, index) => {
		const answer = answers[index];
		return answer && answer.selected.size === 0 && answer.custom.trim() === "" ? count + 1 : count;
	}, 0);

	const submit = () => {
		onSubmit({
			kind: "submit",
			results: request.questions.map((question, index) => {
				const answer = answers[index];
				const custom = answer?.custom.trim() ?? "";
				const note = answer?.note.trim() ?? "";
				return {
					id: question.id,
					question: question.question,
					options: question.options.map(option => option.label),
					multi: question.multi ?? false,
					selectedOptions: question.options
						.map(option => option.label)
						.filter(label => answer?.selected.has(label)),
					...(custom !== "" ? { customInput: answer?.custom ?? "" } : {}),
					...(note !== "" ? { note: answer?.note ?? "" } : {}),
				};
			}),
		});
	};

	/* Arrow keys move between a question's options (WAI-ARIA radio group);
	   single-select also selects, like a native radio group. */
	const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, questionIndex: number) => {
		const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
		if (!forward && event.key !== "ArrowUp" && event.key !== "ArrowLeft") return;
		const group = event.currentTarget.closest<HTMLElement>("[data-ask-options]");
		const options = Array.from(group?.querySelectorAll<HTMLButtonElement>("[data-ask-option]") ?? []);
		const index = options.indexOf(event.currentTarget);
		if (index < 0 || options.length === 0) return;
		event.preventDefault();
		const next = options[(index + (forward ? 1 : -1) + options.length) % options.length];
		next?.focus();
		const label = next?.dataset.askOption;
		if (label !== undefined && !request.questions[questionIndex]?.multi) toggleOption(questionIndex, label);
	};

	return (
		<AskDock>
			<section
				aria-label={t("extDialog.ask.title")}
				className="omp-pop-in mb-2 flex max-h-[min(50vh,36rem)] flex-col overflow-hidden rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-md)"
				onKeyDown={event => {
					if (event.key !== "Escape" || isImeKeyEvent(event.nativeEvent)) return;
					event.preventDefault();
					event.stopPropagation();
					onCancel();
				}}
				ref={cardRef}
				tabIndex={-1}
			>
				<form
					className="flex min-h-0 flex-1 flex-col"
					onSubmit={event => {
						event.preventDefault();
						submit();
					}}
				>
					<div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
						<MessageCircleQuestion aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-accent)" />
						<span className="min-w-0 flex-1 truncate text-sc-md font-semibold">{t("extDialog.ask.title")}</span>
						{request.questions.length > 1 && (
							<span className="shrink-0 text-sc-xs text-(--sc-text-muted) tabular-nums">
								{t("extDialog.ask.count", { count: request.questions.length })}
							</span>
						)}
					</div>
					<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pt-1 pb-4">
						{request.questions.map((question, questionIndex) => {
							const answer = answers[questionIndex];
							const multi = question.multi ?? false;
							const questionId = `${request.id}-q${questionIndex}`;
							const hasSelection = (answer?.selected.size ?? 0) > 0;
							return (
								<div className="space-y-2.5" key={question.id}>
									<div className="space-y-1">
										{question.header && (
											<div className="text-sc-xs font-medium text-(--sc-text-muted)">{question.header}</div>
										)}
										<p
											className="text-sc-md leading-(--sc-leading-normal) font-medium break-keep break-words whitespace-pre-wrap"
											id={questionId}
										>
											{request.questions.length > 1 ? `${questionIndex + 1}. ` : ""}
											{question.question}
										</p>
										{multi && (
											<p className="text-sc-xs text-(--sc-text-muted)">{t("extDialog.ask.multiHint")}</p>
										)}
									</div>
									<div
										aria-labelledby={questionId}
										className="space-y-1.5"
										data-ask-options
										role={multi ? "group" : "radiogroup"}
									>
										{question.options.map((option, optionIndex) => {
											const checked = answer?.selected.has(option.label) ?? false;
											// Single-select is one tab stop (the checked option, else the first).
											const tabStop = multi || checked || (!hasSelection && optionIndex === 0);
											return (
												<button
													aria-checked={checked}
													className={cx(
														"flex w-full items-start gap-2.5 rounded-(--sc-radius-md) border px-3 py-2 text-left transition-colors duration-(--sc-duration-fast)",
														checked
															? "border-(--sc-accent-border) bg-(--sc-accent-soft)"
															: "border-(--sc-border-subtle) hover:border-(--sc-border) hover:bg-(--sc-hover)",
													)}
													data-ask-option={option.label}
													key={option.label}
													onClick={() => toggleOption(questionIndex, option.label)}
													onKeyDown={event => onOptionKeyDown(event, questionIndex)}
													role={multi ? "checkbox" : "radio"}
													tabIndex={tabStop ? 0 : -1}
													type="button"
												>
													<span
														aria-hidden
														className={cx(
															"mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors duration-(--sc-duration-fast)",
															multi ? "rounded-(--sc-radius-xs)" : "rounded-(--sc-radius-full)",
															checked
																? multi
																	? "border-(--sc-accent) bg-(--sc-accent) text-(--sc-accent-fg)"
																	: "border-(--sc-accent) text-(--sc-accent)"
																: "border-(--sc-border-strong) text-transparent",
														)}
													>
														{multi ? (
															<Check size={12} strokeWidth={3} />
														) : (
															<span className="size-2 rounded-(--sc-radius-full) bg-current" />
														)}
													</span>
													<span className="min-w-0 flex-1">
														<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sc-md">
															<span className="min-w-0 break-keep break-words">{option.label}</span>
															{question.recommended === optionIndex && (
																<Badge variant="accent">{t("extDialog.ask.recommended")}</Badge>
															)}
														</span>
														{option.description && (
															<span className="mt-0.5 block text-sc-sm break-keep break-words text-(--sc-text-muted)">
																{option.description}
															</span>
														)}
													</span>
												</button>
											);
										})}
									</div>
									{question.options
										.filter(option => answer?.selected.has(option.label) && option.preview)
										.map(option => (
											<div
												className="rounded-(--sc-radius-md) border border-(--sc-divider) bg-(--sc-surface-1) px-3 py-2 text-sc-sm"
												key={`preview:${option.label}`}
											>
												<MarkdownRenderer content={option.preview!} />
											</div>
										))}
									<Input
										aria-label={t("extDialog.ask.customPlaceholder")}
										onChange={event => setCustom(questionIndex, event.target.value)}
										placeholder={t("extDialog.ask.customPlaceholder")}
										value={answer?.custom ?? ""}
									/>
									<Input
										aria-label={t("extDialog.ask.notePlaceholder")}
										controlSize="sm"
										onChange={event => setNote(questionIndex, event.target.value)}
										placeholder={t("extDialog.ask.notePlaceholder")}
										value={answer?.note ?? ""}
									/>
								</div>
							);
						})}
					</div>
					<div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-(--sc-divider) px-4 py-2.5">
						<div className="flex min-w-0 items-center gap-2">
							<TimeoutFooter remaining={remaining} />
							{unansweredCount > 0 && (
								<span className="text-sc-xs text-(--sc-text-muted)">
									{t("extDialog.ask.unanswered", { count: unansweredCount })}
								</span>
							)}
						</div>
						<div className="ml-auto flex gap-2">
							<Button onClick={onCancel} size="sm" type="button" variant="ghost">
								{t("common.cancel")}
							</Button>
							<Button onClick={() => onSubmit({ kind: "chat" })} size="sm" type="button" variant="secondary">
								{t("extDialog.ask.chat")}
							</Button>
							<Button size="sm" type="submit" variant="primary">
								{t("extDialog.submit")}
							</Button>
						</div>
					</div>
				</form>
			</section>
		</AskDock>
	);
}

function looksLikeJson(text: string): boolean {
	const trimmed = text.trim();
	return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function EditorDialog({
	request,
	onValue,
	onCancel,
}: {
	request: Extract<ExtensionUIRequest, { method: "editor" }>;
	onValue: (value: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const hostRef = useRef<HTMLDivElement>(null);
	const valueRef = useRef(request.prefill ?? "");
	const [editorReady, setEditorReady] = useState(false);

	// CodeMirror (~900 KB) is imported on the first editor request, not at app startup.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		// The editor view is rebuilt per request — resync the submit ref so text
		// left over from a previous request can't leak into this one's value.
		valueRef.current = request.prefill ?? "";
		let view: EditorView | null = null;
		let disposed = false;
		void Promise.all([import("@codemirror/lang-json"), import("@codemirror/view")]).then(
			([{ json }, { EditorView }]) => {
				if (disposed) return;
				view = new EditorView({
					doc: request.prefill ?? "",
					extensions: [
						EditorView.lineWrapping,
						...(looksLikeJson(request.prefill ?? "") ? [json()] : []),
						EditorView.theme({
							"&": {
								backgroundColor: "var(--omp-code-bg)",
								color: "var(--omp-text)",
								fontSize: "12px",
								height: "100%",
							},
							"&.cm-focused": { outline: "none" },
							".cm-content": { fontFamily: "var(--font-mono, monospace)", padding: "8px 0" },
							".cm-line": { padding: "0 10px" },
							".cm-cursor": { borderLeftColor: "var(--omp-accent)" },
							".cm-selectionBackground": { backgroundColor: "var(--omp-selected-bg) !important" },
							".cm-gutters": {
								backgroundColor: "transparent",
								borderRight: "1px solid var(--omp-border-muted)",
								color: "var(--omp-dim)",
							},
						}),
						EditorView.updateListener.of(update => {
							if (update.docChanged) valueRef.current = update.state.doc.toString();
						}),
					],
					parent: host,
				});
				setEditorReady(true);
				view.focus();
			},
		);
		return () => {
			disposed = true;
			view?.destroy();
		};
	}, [request.prefill]);

	return (
		<Modal bodyClassName="p-0" onClose={onCancel} open size="lg" title={request.title}>
			<div className="flex h-[55vh] flex-col">
				<div className="relative min-h-0 flex-1 overflow-hidden border-b border-(--omp-border-muted)">
					<div className="h-full" ref={hostRef} />
					{!editorReady && (
						<div className="absolute inset-0 flex items-center justify-center">
							<Spinner size="sm" />
						</div>
					)}
				</div>
				<div className="flex items-center justify-end gap-2 p-3">
					<Button onClick={onCancel} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button onClick={() => onValue(valueRef.current)} size="sm" variant="primary">
						{t("extDialog.submit")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function OpenUrlDialog({
	request,
	onDone,
	onCancel,
}: {
	request: Extract<ExtensionUIRequest, { method: "open_url" }>;
	onDone: () => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [opened, setOpened] = useState(false);
	const target = request.launchUrl ?? request.url;

	return (
		<Modal onClose={onCancel} open size="sm" title={t("extDialog.openUrl.title")}>
			<div className="space-y-3">
				{request.instructions && (
					<p className="text-xs leading-relaxed break-words whitespace-pre-wrap text-(--omp-muted)">
						{request.instructions}
					</p>
				)}
				<div className="rounded-md border border-(--omp-border-muted) bg-(--omp-code-bg) px-2.5 py-2 font-mono text-omp-xs break-all text-(--omp-md-link)">
					{target}
				</div>
				<div className="flex items-center justify-end gap-2">
					<Button onClick={onCancel} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						icon={<ExternalLink size={12} />}
						onClick={() => {
							void window.omp.system.openExternal(target);
							setOpened(true);
						}}
						size="sm"
						variant="secondary"
					>
						{opened ? t("extDialog.openUrl.openAgain") : t("extDialog.openUrl.open")}
					</Button>
					<Button autoFocus disabled={!opened} onClick={onDone} size="sm" variant="primary">
						{t("extDialog.openUrl.done")}
					</Button>
				</div>
				{!opened && <p className="text-right text-omp-xs text-(--omp-dim)">{t("extDialog.openUrl.hint")}</p>}
			</div>
		</Modal>
	);
}

function ActiveDialog({ request, remaining }: { request: ExtensionUIRequest; remaining: number | null }) {
	const removeRequest = useExtensionUiStore(state => state.removeRequest);

	const respond = (
		response:
			| { value: string }
			| { confirmed: boolean }
			| { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }
			| { cancelled: true },
	) => {
		window.omp.ui.respondExtensionUi({ type: "extension_ui_response", id: request.id, ...response });
		removeRequest(request.id);
	};
	const cancel = () => respond({ cancelled: true });

	switch (request.method) {
		case "select":
			return isApprovalRequest(request) ? (
				<ApprovalDialog onRespond={respond} request={request} />
			) : (
				<SelectDialog
					onCancel={cancel}
					onValue={value => respond({ value })}
					remaining={remaining}
					request={request}
				/>
			);
		case "confirm":
			return (
				<ConfirmDialog
					onCancel={cancel}
					onConfirm={confirmed => respond({ confirmed })}
					remaining={remaining}
					request={request}
				/>
			);
		case "input":
			return (
				// Keyed: consecutive input requests must not inherit the previous
				// request's typed draft.
				<InputDialog
					key={request.id}
					onCancel={cancel}
					onValue={value => respond({ value })}
					remaining={remaining}
					request={request}
				/>
			);
		case "ask":
			// Upstream's opt-in protocol (enabled via set_ask_dialog at session
			// start): same dialog, but the wire wants one `answers` entry per
			// question. "Chat instead" has no answers shape — report it as a cancel.
			return (
				<AskDialog
					key={request.id}
					onCancel={cancel}
					onSubmit={result =>
						respond(
							result.kind === "submit"
								? {
										answers: result.results.map(item => ({
											id: item.id,
											selectedOptions: item.selectedOptions,
											customInput: item.customInput,
										})),
									}
								: { cancelled: true },
						)
					}
					remaining={remaining}
					request={request}
				/>
			);
		case "editor":
			return (
				<EditorDialog key={request.id} onCancel={cancel} onValue={value => respond({ value })} request={request} />
			);
		case "open_url":
			// Keyed: `opened` state must reset per request, or Done enables before
			// the new URL was ever opened.
			return (
				<OpenUrlDialog
					key={request.id}
					onCancel={cancel}
					onDone={() => respond({ value: "done" })}
					request={request}
				/>
			);
		default:
			return null;
	}
}

export function ExtensionDialog() {
	const pending = useExtensionUiStore(state => state.pendingRequests);
	const removeRequest = useExtensionUiStore(state => state.removeRequest);
	const inlineLogin = useExtensionUiStore(state => state.inlineLogin);

	const request = useMemo(
		() =>
			pending.find(req => !NON_DIALOG_METHODS.has(req.method) && !(inlineLogin && isInlineLoginRequest(req))) ??
			null,
		[pending, inlineLogin],
	);
	const remaining = useCountdown(request);

	// Consume non-dialog requests in place. Editor/title mutations must target
	// real GUI surfaces directly; dispatching listenerless events drops them.
	useEffect(() => {
		for (const req of pending) {
			if (req.method === "notify") {
				// Suppress xdev mount notifications — they are startup-time
				// informational messages that don't need user attention.
				if (!req.message.startsWith("xd://: mounted")) {
					toast({
						variant: req.notifyType ?? "info",
						message: req.message,
						durationMs: 6000,
					});
				}
				removeRequest(req.id);
			} else if (req.method === "set_editor_text") {
				window.dispatchEvent(
					new CustomEvent("omp:fill-composer", {
						detail: { text: req.text, images: req.images, prepend: req.prepend },
					}),
				);
				removeRequest(req.id);
			} else if (req.method === "setTitle") {
				document.title = req.title;
				removeRequest(req.id);
			} else if (NON_DIALOG_METHODS.has(req.method)) {
				removeRequest(req.id);
			}
		}
	}, [pending, removeRequest]);

	// Timeout: auto-cancel with timedOut marker.
	useEffect(() => {
		if (!request || remaining === null || remaining > 0) return;
		window.omp.ui.respondExtensionUi({
			type: "extension_ui_response",
			id: request.id,
			cancelled: true,
			timedOut: true,
		});
		removeRequest(request.id);
	}, [request, remaining, removeRequest]);

	return (
		<>
			<ExtensionSurfaces />
			{request && <ActiveDialog remaining={remaining} request={request} />}
		</>
	);
}
