/**
 * Extension UI dispatcher: renders the oldest pending extension_ui_request
 * as a non-modal card docked above the composer (select / confirm / input /
 * editor / open_url / ask), routes tool-approval selects to ApprovalDialog,
 * turns `notify` into a toast, and enforces request timeouts with a visible
 * countdown. Stock answers one dialog at a time; the rest wait in the queue
 * and the card says how many follow.
 *
 * `setStatus` / `setWidget` / `setTitle` are captured by the extension-ui
 * store: widgets render above or under the input box by their placement,
 * status texts as one line under it (where stock's TUI status line sits), and
 * the title per tab through the window title. `set_editor_text` / `cancel`
 * are consumed here or by the store and never render.
 */

import {
	Check,
	ChevronLeft,
	ExternalLink,
	ListChecks,
	MessageCircleQuestion,
	ShieldQuestion,
	SquarePen,
	TextCursorInput,
} from "lucide-react";
import { Fragment, type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OAUTH_PASTE_PROMPT } from "../../../../resources/gui-bridge/oauth-contracts";
import type {
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionUIRequest,
} from "../../../shared/rpc-types";
import { useExtensionUiResponder } from "../../hooks/use-extension-ui";
import { AnsiText } from "../../lib/ansi";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { MarkdownRenderer } from "../../lib/markdown";
import { NEXT_PROMPT_WIDGET } from "../../lib/next-prompt";
import { isApprovalRequest, openUrlTarget, useExtensionUiStore } from "../../stores/extension-ui";
import { useFocusedTabDevice } from "../../stores/remote";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { Badge, Button, Input, Kbd, TextArea } from "../common";
import { ApprovalDialog } from "./ApprovalDialog";
import { useAskDock, useBelowEditorDock } from "./ask-dock";
import { ChoiceList, PromptCard, PromptQueueContext, TimeoutFooter } from "./PromptCard";

/** Requests handled elsewhere (store/router) — never rendered as dialogs. */
const NON_DIALOG_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "cancel"]);

function WidgetPanel({ name, lines }: { name: string; lines: string[] }) {
	return (
		<div
			aria-label={name}
			className="pointer-events-auto rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) px-3 py-2 shadow-(--sc-shadow-md)"
			role="region"
		>
			<div className="mb-1 text-sc-xs font-medium text-(--sc-text-muted)">{name}</div>
			{lines.map((line, index) => (
				<div
					className="font-mono text-sc-xs leading-snug break-words whitespace-pre-wrap text-(--sc-text)"
					key={index}
				>
					{line === "" ? "\u00A0" : <AnsiText text={line} />}
				</div>
			))}
		</div>
	);
}

/**
 * Stock's status line (pi-tui status-line `hookStatuses`): every `setStatus`
 * text, ordered by key, on one row joined by dots, with runs of whitespace
 * collapsed like stock's `sanitizeStatusText`. SGR colors stay (AnsiText).
 */
function ExtensionStatusLine({ statuses }: { statuses: Record<string, string> }) {
	const t = useT();
	const texts = Object.keys(statuses)
		.sort((a, b) => a.localeCompare(b))
		.map(key => (statuses[key] ?? "").replace(/\s+/g, " ").trim())
		.filter(text => text !== "");
	if (texts.length === 0) return null;
	return (
		<div
			aria-label={t("extDialog.status")}
			className="flex min-w-0 items-center gap-1.5 overflow-hidden px-3 pt-1.5 text-sc-xs whitespace-nowrap text-(--sc-text-muted)"
			data-extension-status
			role="group"
		>
			{texts.map((text, index) => (
				<Fragment key={index}>
					{index > 0 && (
						<span aria-hidden className="text-(--sc-text-subtle)">
							·
						</span>
					)}
					<span className="min-w-0 truncate">
						<AnsiText text={text} />
					</span>
				</Fragment>
			))}
		</div>
	);
}

/**
 * Extension-pushed widgets and status texts, where stock's TUI draws them:
 * above-editor widgets in the dock above the composer, below-editor widgets
 * and the status line under the input box. The `next-prompt` widget is the
 * composer's placeholder (InputArea), not a panel. Without a mounted composer
 * (Settings open) widgets float at the bottom and the status line waits.
 */
function ExtensionSurfaces() {
	const above = useAskDock();
	const below = useBelowEditorDock();
	const widgetPanels = useExtensionUiStore(state => state.widgetPanels);
	const placements = useExtensionUiStore(state => state.widgetPlacements);
	const statuses = useExtensionUiStore(state => state.statusWidgets);
	const widgets = Object.entries(widgetPanels).filter(([key]) => key !== NEXT_PROMPT_WIDGET);
	const belowWidgets = below ? widgets.filter(([key]) => placements[key] === "belowEditor") : [];
	const aboveWidgets = below ? widgets.filter(([key]) => placements[key] !== "belowEditor") : widgets;
	const aboveSurface =
		aboveWidgets.length === 0 ? null : (
			<div
				className={cx(
					"pointer-events-none flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto",
					above ? "mb-2" : "fixed bottom-9 left-1/2 z-40 w-[min(560px,92vw)] -translate-x-1/2",
				)}
			>
				{aboveWidgets.map(([key, lines]) => (
					<WidgetPanel key={key} lines={lines} name={key} />
				))}
			</div>
		);
	const belowSurface = below
		? createPortal(
				<>
					{belowWidgets.length > 0 && (
						<div className="mt-2 flex max-h-[30vh] flex-col gap-1.5 overflow-y-auto">
							{belowWidgets.map(([key, lines]) => (
								<WidgetPanel key={key} lines={lines} name={key} />
							))}
						</div>
					)}
					<ExtensionStatusLine statuses={statuses} />
				</>,
				below,
			)
		: null;
	return (
		<>
			{aboveSurface && above ? createPortal(aboveSurface, above) : aboveSurface}
			{belowSurface}
		</>
	);
}

/**
 * Milliseconds left before stock gives up on the request. Stock starts the
 * timer when it sends the request, so the countdown runs from its arrival,
 * not from when the card got its turn on screen.
 */
function useCountdown(request: ExtensionUIRequest | null, arrivedAt: number | undefined): number | null {
	const timeout =
		request &&
		(request.method === "select" ||
			request.method === "confirm" ||
			request.method === "input" ||
			request.method === "ask")
			? request.timeout
			: undefined;
	const [, setTick] = useState(0);
	useEffect(() => {
		if (timeout === undefined) return;
		const timer = setInterval(() => setTick(v => v + 1), 200);
		return () => clearInterval(timer);
	}, [timeout]);
	// Derived per request at render: a state-held countdown leaked the previous
	// request's last value (0 ms) into the next commit, whose auto-cancel effect
	// then answered the new request as timed out.
	if (timeout === undefined) return null;
	return Math.max(0, timeout - (Date.now() - (arrivedAt ?? Date.now())));
}

/** First line names the prompt; any following lines are its body. */
function splitTitle(title: string): { label: string; body: string } {
	const [first = "", ...rest] = title.split("\n");
	return { label: first.trim(), body: rest.join("\n").trim() };
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
	const { label, body } = splitTitle(request.title);
	return (
		<PromptCard
			footer={
				<>
					<TimeoutFooter remaining={remaining} />
					<Button className="ml-auto" onClick={onCancel} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
				</>
			}
			icon={ListChecks}
			label={label}
			onCancel={onCancel}
			onDigit={n => {
				const option = request.options[n - 1];
				if (option !== undefined) onValue(option);
			}}
		>
			{body && <p className="mb-2 text-sc-sm break-words whitespace-pre-wrap text-(--sc-text-muted)">{body}</p>}
			<ChoiceList
				choices={request.options.map((option, index) => ({
					key: option,
					label: option,
					description: request.optionDetails?.[index]?.description,
				}))}
				onChoose={onValue}
			/>
		</PromptCard>
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
		<PromptCard
			footer={
				<>
					<TimeoutFooter remaining={remaining} />
					<Button className="ml-auto" onClick={onCancel} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
				</>
			}
			icon={ShieldQuestion}
			label={request.title}
			onCancel={onCancel}
			onDigit={n => {
				if (n === 1) onConfirm(true);
				else if (n === 2) onConfirm(false);
			}}
		>
			{request.message && (
				<p className="mb-2 text-sc-sm leading-(--sc-leading-normal) break-words whitespace-pre-wrap text-(--sc-text-secondary)">
					{request.message}
				</p>
			)}
			<ChoiceList
				choices={[
					{ key: "approve", label: t("approval.approve") },
					{ key: "deny", label: t("approval.deny"), tone: "danger" },
				]}
				onChoose={key => onConfirm(key === "approve")}
			/>
		</PromptCard>
	);
}

/** Single-line answer: Enter submits, Escape cancels. Focus starts in the field. */
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
	const tabId = useRuntimeTabId();
	const signInHost = useExtensionUiStore(state => state.lastOpenUrlHost);
	const fieldRef = useRef<HTMLInputElement>(null);
	// Stock's code paste beside an OAuth callback, outside the login panel (an
	// MCP server's sign-in passes it as the placeholder): a sign-in step in the
	// UI language, an optional fallback for when the browser cannot reach omp,
	// so no countdown.
	const oauthPaste = request.title === OAUTH_PASTE_PROMPT || request.placeholder === OAUTH_PASTE_PROMPT;
	const { label, body } = oauthPaste
		? {
				label: signInHost
					? t("extDialog.oauthPaste.title", { host: signInHost })
					: t("extDialog.oauthPaste.titleUnknown"),
				body: t("extDialog.oauthPaste.hint"),
			}
		: splitTitle(request.title);
	useEffect(() => {
		if (tabId && useTabsStore.getState().activeTabId !== tabId) return;
		fieldRef.current?.focus();
	}, [tabId]);
	const submit = () => onValue(fieldRef.current?.value ?? "");
	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key !== "Enter" || isImeKeyEvent(event.nativeEvent)) return;
		event.preventDefault();
		submit();
	};
	return (
		<PromptCard
			footer={
				<>
					{!oauthPaste && <TimeoutFooter remaining={remaining} />}
					<div className="ml-auto flex gap-2">
						<Button onClick={onCancel} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button onClick={submit} size="sm" variant="primary">
							{t("extDialog.submit")}
						</Button>
					</div>
				</>
			}
			icon={TextCursorInput}
			label={label}
			onCancel={onCancel}
		>
			{body && <p className="mb-2 text-sc-sm break-words whitespace-pre-wrap text-(--sc-text-muted)">{body}</p>}
			<Input
				aria-label={oauthPaste ? t("extDialog.oauthPaste.field") : label}
				onKeyDown={onKeyDown}
				placeholder={oauthPaste ? undefined : request.placeholder}
				ref={fieldRef}
			/>
		</PromptCard>
	);
}

interface AskAnswerState {
	selected: Set<string>;
	custom: string;
	note: string;
}

/**
 * The ask card, one question at a time like the Claude app: a step strip on
 * top (✓ once answered, click to revisit), numbered options (1–9 pick), a
 * free-text "other" answer and an optional note under each question. Picking
 * a single-select option moves straight to the next question; the last step
 * submits. Single-select mirrors the TUI: picking an option replaces the
 * custom answer, typing one clears the option selection. Non-modal: docked
 * above the composer; Escape inside the card cancels.
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
	const tabId = useRuntimeTabId();
	const formId = useId();
	const bodyRef = useRef<HTMLDivElement>(null);
	const questions = request.questions;
	const total = questions.length;
	const [step, setStep] = useState(0);
	const [answers, setAnswers] = useState<AskAnswerState[]>(() =>
		questions.map(() => ({ selected: new Set<string>(), custom: "", note: "" })),
	);
	const [noteOpen, setNoteOpen] = useState<ReadonlySet<number>>(() => new Set());
	const question = questions[step];
	const answer = answers[step];
	const multi = question?.multi ?? false;
	const last = step === total - 1;
	const isAnswered = (index: number) => {
		const entry = answers[index];
		return entry !== undefined && (entry.selected.size > 0 || entry.custom.trim() !== "");
	};
	const unansweredCount = questions.filter((_question, index) => !isAnswered(index)).length;

	// Each step opens on its first option, so 1–9 and ↑/↓ work right away.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a step change moves focus.
	useEffect(() => {
		if (tabId && useTabsStore.getState().activeTabId !== tabId) return;
		bodyRef.current?.querySelector<HTMLElement>("[data-choice]")?.focus();
	}, [step, tabId]);

	const update = (index: number, change: (entry: AskAnswerState) => AskAnswerState) =>
		setAnswers(prev => prev.map((entry, at) => (at === index ? change(entry) : entry)));

	const choose = (label: string) => {
		if (multi) {
			update(step, entry => {
				const selected = new Set(entry.selected);
				if (selected.has(label)) selected.delete(label);
				else selected.add(label);
				return { ...entry, selected };
			});
			return;
		}
		// Single-select: picking an option replaces any custom answer, then moves on.
		update(step, entry => ({ ...entry, selected: new Set([label]), custom: "" }));
		if (!last) setStep(step + 1);
	};

	const setCustom = (custom: string) =>
		update(step, entry =>
			!multi && custom.trim() !== "" ? { ...entry, custom, selected: new Set<string>() } : { ...entry, custom },
		);

	const submit = () => {
		onSubmit({
			kind: "submit",
			results: questions.map((item, index) => {
				const entry = answers[index];
				const custom = entry?.custom.trim() ?? "";
				const note = entry?.note.trim() ?? "";
				return {
					id: item.id,
					question: item.question,
					options: item.options.map(option => option.label),
					multi: item.multi ?? false,
					selectedOptions: item.options.map(option => option.label).filter(label => entry?.selected.has(label)),
					...(custom !== "" ? { customInput: entry?.custom ?? "" } : {}),
					...(note !== "" ? { note: entry?.note ?? "" } : {}),
				};
			}),
		});
	};

	if (!question || !answer) return null;
	const questionId = `${request.id}-q${step}`;
	const showNote = noteOpen.has(step) || answer.note !== "";

	return (
		<PromptCard
			footer={
				<>
					<div className="flex min-w-0 items-center gap-2">
						<TimeoutFooter remaining={remaining} />
						{last && unansweredCount > 0 && (
							<span className="text-sc-xs text-(--sc-text-muted)">
								{t("extDialog.ask.unanswered", { count: unansweredCount })}
							</span>
						)}
					</div>
					<div className="ml-auto flex flex-wrap gap-2">
						<Button onClick={() => onSubmit({ kind: "chat" })} size="sm" type="button" variant="ghost">
							{t("extDialog.ask.chat")}
						</Button>
						{step > 0 && (
							<Button icon={<ChevronLeft />} onClick={() => setStep(step - 1)} size="sm" variant="secondary">
								{t("extDialog.ask.back")}
							</Button>
						)}
						<Button form={formId} size="sm" type="submit" variant="primary">
							{last ? t("extDialog.submit") : t("extDialog.ask.next")}
						</Button>
					</div>
				</>
			}
			headerAside={
				total > 1 ? (
					<span className="shrink-0 text-sc-xs text-(--sc-text-muted) tabular-nums">
						{t("extDialog.ask.step", { current: step + 1, total })}
					</span>
				) : undefined
			}
			icon={MessageCircleQuestion}
			label={t("extDialog.ask.title")}
			onCancel={onCancel}
			onDigit={n => {
				const option = question.options[n - 1];
				if (option) choose(option.label);
			}}
		>
			<form
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					if (last) submit();
					else setStep(step + 1);
				}}
			>
				{total > 1 && (
					<div className="mb-3 flex gap-1 overflow-x-auto" data-ask-steps role="tablist">
						{questions.map((item, index) => (
							<button
								aria-selected={index === step}
								className={cx(
									"flex shrink-0 items-center gap-1 rounded-(--sc-radius-full) border px-2.5 py-0.5 text-sc-xs transition-colors duration-(--sc-duration-fast)",
									index === step
										? "border-(--sc-accent-border) bg-(--sc-accent-soft) text-(--sc-text)"
										: "border-(--sc-border-subtle) text-(--sc-text-muted) hover:bg-(--sc-hover)",
								)}
								data-ask-step={index}
								key={item.id}
								onClick={() => setStep(index)}
								role="tab"
								tabIndex={-1}
								type="button"
							>
								{isAnswered(index) && <Check aria-hidden className="size-3 text-(--sc-success)" />}
								<span className="max-w-32 truncate">{item.header || index + 1}</span>
							</button>
						))}
					</div>
				)}
				<div className="space-y-2.5" key={question.id} ref={bodyRef}>
					<div className="space-y-1">
						{question.header && total === 1 && (
							<div className="text-sc-xs font-medium text-(--sc-text-muted)">{question.header}</div>
						)}
						<p
							className="text-sc-md leading-(--sc-leading-normal) font-medium break-keep break-words whitespace-pre-wrap"
							id={questionId}
						>
							{question.question}
						</p>
						{multi && <p className="text-sc-xs text-(--sc-text-muted)">{t("extDialog.ask.multiHint")}</p>}
					</div>
					<ChoiceList
						choices={question.options.map((option, index) => ({
							key: option.label,
							label: option.label,
							description: option.description,
							aside:
								question.recommended === index ? (
									<Badge variant="accent">{t("extDialog.ask.recommended")}</Badge>
								) : undefined,
						}))}
						labelledBy={questionId}
						mode={multi ? "multi" : "single"}
						onChoose={choose}
						selected={answer.selected}
					/>
					{question.options
						.filter(option => answer.selected.has(option.label) && option.preview)
						.map(option => (
							<div
								className="rounded-(--sc-radius-md) border border-(--sc-divider) bg-(--sc-surface-1) px-3 py-2 text-sc-sm"
								key={`preview:${option.label}`}
							>
								<MarkdownRenderer content={option.preview ?? ""} />
							</div>
						))}
					<Input
						aria-label={t("extDialog.ask.customPlaceholder")}
						onChange={event => setCustom(event.target.value)}
						placeholder={t("extDialog.ask.customPlaceholder")}
						value={answer.custom}
					/>
					{showNote ? (
						<Input
							aria-label={t("extDialog.ask.notePlaceholder")}
							autoFocus={answer.note === "" && (!tabId || useTabsStore.getState().activeTabId === tabId)}
							controlSize="sm"
							onChange={event => update(step, entry => ({ ...entry, note: event.target.value }))}
							placeholder={t("extDialog.ask.notePlaceholder")}
							value={answer.note}
						/>
					) : (
						<button
							className="text-sc-xs text-(--sc-text-muted) underline-offset-2 hover:text-(--sc-text) hover:underline"
							onClick={() => setNoteOpen(prev => new Set(prev).add(step))}
							type="button"
						>
							{t("extDialog.ask.addNote")}
						</button>
					)}
				</div>
			</form>
		</PromptCard>
	);
}

function looksLikeJson(text: string): boolean {
	const trimmed = text.trim();
	return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

/**
 * Multi-line answer: Cmd/Ctrl+Enter submits, Enter adds a newline, Escape
 * cancels. With `promptStyle` (stock's one-line prompt editor, pi-tui
 * hook-editor) Enter submits and Shift+Enter adds the newline; Cmd/Ctrl+Enter
 * still submits.
 */
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
	const tabId = useRuntimeTabId();
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const prefill = request.prefill ?? "";
	const promptStyle = request.promptStyle === true;
	const { label, body } = splitTitle(request.title);
	useEffect(() => {
		if (tabId && useTabsStore.getState().activeTabId !== tabId) return;
		fieldRef.current?.focus();
	}, [tabId]);
	const submit = () => onValue(fieldRef.current?.value ?? "");
	const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || isImeKeyEvent(event.nativeEvent)) return;
		const submits = event.metaKey || event.ctrlKey || (promptStyle && !event.shiftKey);
		if (!submits) return;
		event.preventDefault();
		submit();
	};
	return (
		<PromptCard
			footer={
				<>
					<span className="flex items-center gap-3 text-sc-xs text-(--sc-text-muted)">
						<span className="flex items-center gap-1.5">
							<Kbd shortcut={promptStyle ? "↵" : "⌘↵"} />
							{t("extDialog.editor.hintSubmit")}
						</span>
						<span className="flex items-center gap-1.5">
							<Kbd shortcut={promptStyle ? "⇧↵" : "↵"} />
							{t("extDialog.editor.hintNewline")}
						</span>
					</span>
					<div className="ml-auto flex gap-2">
						<Button onClick={onCancel} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button onClick={submit} size="sm" variant="primary">
							{t("extDialog.submit")}
						</Button>
					</div>
				</>
			}
			icon={SquarePen}
			label={label}
			onCancel={onCancel}
		>
			{body && <p className="mb-2 text-sc-sm break-words whitespace-pre-wrap text-(--sc-text-muted)">{body}</p>}
			<TextArea
				aria-label={label}
				autoGrow
				className="max-h-[min(40vh,24rem)] overflow-y-auto"
				defaultValue={prefill}
				mono={looksLikeJson(prefill)}
				onKeyDown={onKeyDown}
				ref={fieldRef}
				rows={promptStyle ? 1 : 4}
				spellCheck={false}
			/>
		</PromptCard>
	);
}

/** A link the extension wants opened: 1 opens it in the browser and answers "done", 2 cancels. */
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
	const device = useFocusedTabDevice();
	const target = openUrlTarget(request, device !== undefined);
	const choose = (key: string) => {
		if (key !== "open") {
			onCancel();
			return;
		}
		void window.omp.system.openExternal(target);
		onDone();
	};
	return (
		<PromptCard
			icon={ExternalLink}
			label={t("extDialog.openUrl.title")}
			onCancel={onCancel}
			onDigit={n => {
				if (n === 1) choose("open");
				else if (n === 2) choose("cancel");
			}}
		>
			{request.instructions && (
				<p className="mb-2 text-sc-sm break-words whitespace-pre-wrap text-(--sc-text-muted)">
					{request.instructions}
				</p>
			)}
			<p className="mb-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-2) px-3 py-2 font-mono text-sc-sm break-all text-(--sc-text-secondary) select-text">
				{target}
			</p>
			<ChoiceList
				choices={[
					{ key: "open", label: t("extDialog.openUrl.open") },
					{ key: "cancel", label: t("common.cancel") },
				]}
				onChoose={choose}
			/>
		</PromptCard>
	);
}

/**
 * One `ask` answer as the rpc wire carries it. The wire has only
 * `selectedOptions` and `customInput` (stock rpc-mode `parseAskDialogResponse`),
 * so a note rides in `customInput`, worded like stock's own ask result
 * (`formatQuestionResult`'s ` (note: …)` suffix). Stock rejects a
 * single-select answer that carries both an option and text, so there the
 * picked option moves into the text with the note.
 */
function askWireAnswer(item: ExtensionAskDialogResultItem): {
	id: string;
	selectedOptions: string[];
	customInput?: string;
} {
	const note = item.note?.trim() ?? "";
	if (note === "") return { id: item.id, selectedOptions: item.selectedOptions, customInput: item.customInput };
	const custom = item.customInput?.trim() ?? "";
	const foldOption = !item.multi && custom === "" && item.selectedOptions.length > 0;
	const base = foldOption ? (item.selectedOptions[0] ?? "") : custom;
	return {
		id: item.id,
		selectedOptions: foldOption ? [] : item.selectedOptions,
		customInput: base === "" ? `(note: ${note})` : `${base} (note: ${note})`,
	};
}

function ActiveDialog({
	request,
	remaining,
	arrivedAt,
}: {
	request: ExtensionUIRequest;
	remaining: number | null;
	arrivedAt: number | undefined;
}) {
	const sendResponse = useExtensionUiResponder();
	const removeRequest = useExtensionUiStore(state => state.removeRequest);

	const respond = (
		response:
			| { value: string }
			| { confirmed: boolean }
			| { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }
			| { cancelled: true },
	) => {
		sendResponse({ type: "extension_ui_response", id: request.id, ...response });
		removeRequest(request.id);
	};
	const cancel = () => respond({ cancelled: true });

	switch (request.method) {
		case "select":
			return isApprovalRequest(request) ? (
				<ApprovalDialog arrivedAt={arrivedAt} onRespond={respond} remaining={remaining} request={request} />
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
							result.kind === "submit" ? { answers: result.results.map(askWireAnswer) } : { cancelled: true },
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
			// Keyed: each link gets a fresh card, so focus lands on it again.
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
	const sendResponse = useExtensionUiResponder();
	const tabId = useRuntimeTabId();
	const pending = useExtensionUiStore(state => state.pendingRequests);
	const arrivals = useExtensionUiStore(state => state.arrivedAt);
	const removeRequest = useExtensionUiStore(state => state.removeRequest);
	const loginRequestIds = useExtensionUiStore(state => state.loginRequestIds);

	// A sign-in's own requests render in its login panel, never as a card here.
	const dialogs = useMemo(
		() => pending.filter(req => !NON_DIALOG_METHODS.has(req.method) && !Object.hasOwn(loginRequestIds, req.id)),
		[pending, loginRequestIds],
	);
	const request = dialogs[0] ?? null;
	const arrivedAt = request ? arrivals[request.id] : undefined;
	const remaining = useCountdown(request, arrivedAt);

	// Consume non-dialog requests in place. Editor mutations must target real
	// GUI surfaces directly; dispatching listenerless events drops them.
	useEffect(() => {
		for (const req of pending) {
			// The inline sign-in panel shows its own progress notices.
			if (Object.hasOwn(loginRequestIds, req.id)) continue;
			if (req.method === "notify") {
				// Suppress xdev mount notifications — they are startup-time
				// informational messages that don't need user attention.
				if (!req.message.startsWith("xd://: mounted")) {
					const variant = req.notifyType ?? "info";
					// Stock's TUI keeps an error in the transcript; here it stays until dismissed.
					toast({
						variant,
						message: req.message,
						durationMs: variant === "error" ? Number.POSITIVE_INFINITY : 6000,
					});
				}
				removeRequest(req.id);
			} else if (req.method === "set_editor_text") {
				window.dispatchEvent(
					new CustomEvent("omp:fill-composer", {
						detail: { text: req.text, images: req.images, prepend: req.prepend, tabId },
					}),
				);
				removeRequest(req.id);
			} else if (NON_DIALOG_METHODS.has(req.method)) {
				removeRequest(req.id);
			}
		}
	}, [pending, removeRequest, tabId, loginRequestIds]);

	// Timeout: auto-cancel with timedOut marker.
	useEffect(() => {
		if (!request || remaining === null || remaining > 0) return;
		sendResponse({
			type: "extension_ui_response",
			id: request.id,
			cancelled: true,
			timedOut: true,
		});
		removeRequest(request.id);
	}, [request, remaining, removeRequest, sendResponse]);

	return (
		<>
			<ExtensionSurfaces />
			{request && (
				<PromptQueueContext.Provider value={dialogs.length - 1}>
					<ActiveDialog arrivedAt={arrivedAt} remaining={remaining} request={request} />
				</PromptQueueContext.Provider>
			)}
		</>
	);
}
