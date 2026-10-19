/**
 * Dedicated cards for custom/extension message types (TUI parity:
 * packages/coding-agent/src/modes/components/chat-transcript-builder.ts
 * `#appendCustomMessage` + modes/utils/transcript-render-helpers.ts).
 *
 * The TUI renders each of these customTypes as a purpose-built transcript
 * block; the GUI used to flatten them to a bare label. Each card here reads
 * the message `details`/content through the shared unwrappers
 * (`resultDetails`/`resultText`) so live and persisted payloads render alike.
 * `display: false` filtering stays in MessageBubble (same as the TUI).
 */
import {
	AlertTriangle,
	ArrowRightLeft,
	CheckCircle2,
	ChevronRight,
	History,
	Lightbulb,
	MessagesSquare,
	XCircle,
	Zap,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import type { AgentMessage } from "../../../shared/rpc-types";
import { cx, formatAgo, formatClock, formatDuration, headLines, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { asArray } from "../../lib/wire-value";
import { Badge, type BadgeVariant } from "../common/Badge";
import {
	asFileDiagnostics,
	DiagnosticsList,
	diagnosticsCount,
	type FileDiagnostics,
} from "../tools/renderers/Diagnostics";
import {
	asyncJobResults,
	asyncResultJobs,
	completionNoticeText,
	exitCodeOf,
	launchCompletionDaemons,
} from "./completion-events";
import { agentResultSummary } from "./work/work-view";

/** customTypes with a dedicated card (the TUI dispatch set). */
const CARD_TYPES: Record<string, true> = {
	advisor: true,
	"async-result": true,
	"launch-completion": true,
	"lsp-late-diagnostic": true,
	"skill-prompt": true,
	"collab-prompt": true,
	"irc:incoming": true,
	"irc:autoreply": true,
	"irc:relay": true,
	handoff: true,
};

/** Whether this customType renders as a dedicated card instead of the generic bubble. */
export function isCustomMessageCardType(customType: string | undefined): boolean {
	return customType != null && CARD_TYPES[customType] === true;
}

const EmbeddedCard = createContext(false);

/** The same type marks and metadata are used by standalone cards and the work feed. */
export function workNoteSummary(message: AgentMessage) {
	const details = resultDetails(message);
	const notes = Array.isArray(details?.notes) ? details.notes : [];
	const advisorNotes = notes.filter(
		(note): note is Record<string, unknown> => typeof note === "object" && note !== null,
	);
	const severity = advisorNotes.some(note => note.severity === "blocker")
		? "blocker"
		: advisorNotes.some(note => note.severity === "concern")
			? "concern"
			: str(advisorNotes[0]?.severity);
	const type = message.customType;
	const jobs = asyncResultJobs(message);
	const job = jobs[0];
	const daemon = launchCompletionDaemons(message)[0];
	// A completion's mark states how the job ended: stock's own failed verdict or a non-zero exit.
	const failed =
		jobs.some(item => item.status === "failed") ||
		launchCompletionDaemons(message).some(
			item => item.state === "failed" || (item.exitCode !== undefined && item.exitCode !== 0),
		);
	const Icon =
		type === "advisor"
			? Lightbulb
			: type?.startsWith("irc:") || type === "collab-prompt"
				? MessagesSquare
				: type === "async-result" || type === "launch-completion"
					? failed
						? XCircle
						: CheckCircle2
					: type === "lsp-late-diagnostic"
						? AlertTriangle
						: type === "skill-prompt"
							? Zap
							: ArrowRightLeft;
	const source = type?.startsWith("irc:")
		? (str(type === "irc:autoreply" ? details?.to : details?.from) ?? str(details?.to))
		: type === "advisor"
			? advisorNotes[0]?.advisor === "default"
				? undefined
				: str(advisorNotes[0]?.advisor)
			: (job?.label ??
				job?.jobId ??
				daemon?.name ??
				str(details?.jobId) ??
				str(details?.job) ??
				str(details?.from) ??
				str(details?.name));
	const rawBody = resultText(message);
	let body = str(advisorNotes[0]?.note) ?? str(details?.message) ?? str(details?.body) ?? rawBody;
	if (type === "async-result") {
		const delivered =
			(job?.jobId ? asyncJobResults(rawBody, jobs).get(job.jobId) : undefined) ?? completionNoticeText(rawBody);
		// Stock task/result-summary.ts emits this envelope; only its output is
		// preview text. The renderer cannot import the stock runtime formatter.
		const output = delivered.match(/<output>([\s\S]*?)<\/output>/)?.[1] ?? delivered;
		body = agentResultSummary({ output }) ?? completionNoticeText(rawBody);
	} else if (type === "launch-completion") {
		body = completionNoticeText(rawBody);
	}
	return { Icon, source, body, severity, variant: advisorVariant(severity), failed };
}

export function CustomMessageCard({ message, inProcess = false }: { message: AgentMessage; inProcess?: boolean }) {
	return (
		<EmbeddedCard.Provider value={inProcess}>
			<CustomMessageBody message={message} inProcess={inProcess} />
		</EmbeddedCard.Provider>
	);
}

function CustomMessageBody({ message, inProcess }: { message: AgentMessage; inProcess: boolean }) {
	switch (message.customType) {
		case "advisor":
			return <AdvisorCard message={message} />;
		case "async-result":
			return <AsyncResultCard inProcess={inProcess} message={message} />;
		case "launch-completion":
			return <LaunchCompletionCard inProcess={inProcess} message={message} />;
		case "lsp-late-diagnostic":
			return <LateDiagnosticsCard message={message} />;
		case "skill-prompt":
			return <SkillCard message={message} />;
		case "collab-prompt":
			return <CollabCard message={message} />;
		case "irc:incoming":
		case "irc:autoreply":
		case "irc:relay":
			return <IrcCard message={message} />;
		case "handoff":
			return <HandoffCard message={message} />;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Card header: a neutral sentence-case label like the context cards'; color stays on state marks. */
const HEADER_CLASS = "mb-2 flex min-w-0 items-center gap-1.5 text-sc-sm font-medium text-(--sc-text-muted)";
const HEADER_ICON_CLASS = "size-(--sc-icon-sm) shrink-0";
const HEADER_META_CLASS = "min-w-0 truncate font-normal text-(--sc-text-subtle)";

/** Colorless hairline card, the same frame as the context and execution cards (MessageBubble). */
function CardFrame({ children }: { children: ReactNode }) {
	const embedded = useContext(EmbeddedCard);
	if (embedded) return <div className="omp-work-notes-body">{children}</div>;
	return (
		<div className="omp-custom-turn omp-fade-up ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-3">
			<div className="omp-transcript-content min-w-0 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) px-3.5 py-3">
				{children}
			</div>
		</div>
	);
}

/** Body text capped at `lines` with a "+N more lines" / "Show less" toggle. */
function CollapsibleText({ text, lines, className }: { text: string; lines: number; className?: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { head, omitted } = headLines(text, lines);
	return (
		<div>
			<pre
				className={cx(
					"font-mono text-omp-sm leading-[1.55] break-words whitespace-pre-wrap text-[var(--omp-tool-output)]",
					!open && "max-h-60 overflow-hidden",
					open && "max-h-80 overflow-auto",
					className,
				)}
			>
				{open ? text : head}
			</pre>
			{omitted > 0 && (
				<button
					type="button"
					onClick={() => setOpen(v => !v)}
					className="omp-pressable mt-0.5 text-omp-xs font-medium text-[var(--omp-dim)] hover:text-[var(--omp-text)]"
				>
					{open
						? t("chat.custom.showLess")
						: t("chat.custom.moreLines", { count: omitted, plural: omitted === 1 ? "" : "s" })}
				</button>
			)}
		</div>
	);
}

function CompletionRows({ children, inProcess }: { children: ReactNode; inProcess: boolean }) {
	return (
		<div
			className={
				inProcess
					? "py-0.5"
					: "omp-custom-turn omp-fade-up ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-2"
			}
		>
			<div className={cx("space-y-0.5", !inProcess && "omp-transcript-content")}>{children}</div>
		</div>
	);
}

function CompletionRow({
	failed,
	label,
	meta,
	output,
}: {
	failed?: boolean;
	label: string;
	meta?: string;
	output?: string;
}) {
	const Icon = failed === undefined ? Zap : failed ? XCircle : CheckCircle2;
	const content = (
		<>
			<Icon
				aria-hidden="true"
				className={cx(
					"shrink-0",
					failed === undefined
						? "text-(--sc-text-muted)"
						: failed
							? "text-[var(--omp-error)]"
							: "text-[var(--omp-success)]",
				)}
				size={13}
			/>
			<span className="min-w-0 truncate text-omp-md font-medium text-[var(--omp-text)]">{label}</span>
			{meta && <span className="min-w-0 truncate text-omp-xs text-[var(--omp-dim)] tabular-nums">{meta}</span>}
		</>
	);
	const rowClass = "flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left";
	if (!output) return <div className={rowClass}>{content}</div>;
	return (
		<details className="group">
			<summary className={cx("omp-pressable cursor-pointer list-none", rowClass)}>
				{content}
				<ChevronRight
					aria-hidden="true"
					className="omp-disclosure-chevron ml-auto shrink-0 text-[var(--omp-dim)] group-open:rotate-90"
					size={13}
				/>
			</summary>
			<div className="pb-2 pl-6">
				<CollapsibleText className="mt-0.5" lines={3} text={output} />
			</div>
		</details>
	);
}

// ---------------------------------------------------------------------------
// advisor — batch of advisor notes injected into the session
// ---------------------------------------------------------------------------

interface AdvisorNote {
	note: string;
	severity?: string;
	advisor?: string;
}

const COLLAPSED_NOTES = 3;

function advisorVariant(severity: string | undefined): BadgeVariant {
	switch (severity) {
		case "blocker":
			return "error";
		case "concern":
			return "warning";
		default:
			return "muted";
	}
}

const ADVISOR_SEVERITY_KEYS: Record<string, string> = {
	nit: "chat.custom.severity.nit",
	concern: "chat.custom.severity.concern",
	blocker: "chat.custom.severity.blocker",
};

/** Stock's advisor severity (`nit` | `concern` | `blocker`) in the UI language; anything else as sent. */
export function advisorSeverityLabel(severity: string, t: (key: string) => string): string {
	const key = ADVISOR_SEVERITY_KEYS[severity];
	return key ? t(key) : severity;
}

function AdvisorCard({ message }: { message: AgentMessage }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const details = resultDetails(message);
	const notesValue = details?.notes;
	const notes: AdvisorNote[] = (Array.isArray(notesValue) ? notesValue : [])
		.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
		.map(entry => ({ note: str(entry.note) ?? "", severity: str(entry.severity), advisor: str(entry.advisor) }))
		.filter(entry => entry.note);

	const blockers = notes.filter(note => note.severity === "blocker").length;
	const shown = expanded ? notes : notes.slice(0, COLLAPSED_NOTES);
	const hidden = notes.length - shown.length;

	return (
		<CardFrame>
			<div className={HEADER_CLASS}>
				<Lightbulb aria-hidden className={HEADER_ICON_CLASS} />
				<span className="shrink-0">{t("chat.custom.advisor")}</span>
				<span className={HEADER_META_CLASS}>
					· {t("chat.custom.advisorNotes", { count: notes.length, plural: notes.length === 1 ? "" : "s" })}
					{blockers > 0 && (
						<span className="text-(--sc-danger)">
							{" "}
							· {t("chat.custom.blockers", { count: blockers, plural: blockers === 1 ? "" : "s" })}
						</span>
					)}
				</span>
			</div>
			<div className="space-y-2">
				{shown.map((note, i) => (
					<div key={i} className="flex items-start gap-2">
						{note.severity && (
							<Badge variant={advisorVariant(note.severity)} className="mt-0.5">
								{advisorSeverityLabel(note.severity, t)}
							</Badge>
						)}
						<div className="min-w-0 flex-1 text-sc-md text-(--sc-text)">
							{note.advisor && note.advisor !== "default" && (
								<span className="me-1.5 font-mono text-sc-xs text-(--sc-text-muted)">[{note.advisor}]</span>
							)}
							<MarkdownRenderer content={note.note} />
						</div>
					</div>
				))}
				{hidden > 0 && (
					<button
						type="button"
						onClick={() => setExpanded(true)}
						className="omp-pressable rounded-(--sc-radius-sm) text-sc-sm font-medium text-(--sc-text-muted) hover:text-(--sc-text)"
					>
						{t("chat.custom.moreNotes", { count: hidden, plural: hidden === 1 ? "" : "s" })}
					</button>
				)}
			</div>
		</CardFrame>
	);
}

// ---------------------------------------------------------------------------
// async-result — completed background bash/task job rows
// ---------------------------------------------------------------------------

/** Stock's background job kinds (pi-tui `JobSnapshot["type"]`), named like the tool that started them. */
const JOB_KIND_LABELS: Record<string, string> = {
	bash: "tools.label.bash",
	task: "tools.label.task",
	eval: "tools.label.eval",
};

function AsyncResultCard({ message, inProcess }: { message: AgentMessage; inProcess: boolean }) {
	const t = useT();
	const jobs = asyncResultJobs(message);
	const results = asyncJobResults(resultText(message.content), jobs);

	// A batch without job rows must not invent one: the delivery text is the
	// only truthful summary left.
	if (jobs.length === 0) {
		return (
			<CompletionRows inProcess={inProcess}>
				<CompletionRow label={resultText(message.content) || t("chat.exec.finished")} />
			</CompletionRows>
		);
	}

	return (
		<CompletionRows inProcess={inProcess}>
			{jobs.map((job, index) => {
				const id = job.jobId ?? "unknown";
				const output = job.jobId ? results.get(job.jobId) : undefined;
				const failed = job.status === "failed";
				const exitCode = exitCodeOf(output);
				// Stock's TUI writes the kind as a "[task]" token; here it reads as the tool's own name.
				const kind = job.type ? JOB_KIND_LABELS[job.type] : undefined;
				const meta = [
					t(failed ? "chat.custom.asyncFailed" : "chat.custom.asyncDone"),
					exitCode !== undefined && exitCode !== 0 ? t("chat.exec.exit", { code: exitCode }) : undefined,
					kind ? t(kind) : undefined,
					job.label && job.label !== id ? id : undefined,
					job.durationMs != null ? formatDuration(job.durationMs) : undefined,
				]
					.filter(Boolean)
					.join(" · ");
				return (
					<CompletionRow
						failed={failed}
						key={job.jobId ?? index}
						label={job.label ?? id}
						meta={meta}
						output={output}
					/>
				);
			})}
		</CompletionRows>
	);
}

function LaunchCompletionCard({ message, inProcess }: { message: AgentMessage; inProcess: boolean }) {
	const t = useT();
	const daemons = launchCompletionDaemons(message);
	if (daemons.length === 0) {
		return (
			<CompletionRows inProcess={inProcess}>
				<CompletionRow label={resultText(message.content) || t("chat.exec.finished")} />
			</CompletionRows>
		);
	}
	return (
		<CompletionRows inProcess={inProcess}>
			{daemons.map(daemon => {
				const failed = daemon.state === "failed" || (daemon.exitCode !== undefined && daemon.exitCode !== 0);
				const duration =
					daemon.startedAt !== undefined && daemon.exitedAt !== undefined
						? formatDuration(daemon.exitedAt - daemon.startedAt)
						: undefined;
				const meta = [
					daemon.exitCode !== undefined ? t("chat.exec.exit", { code: daemon.exitCode }) : undefined,
					duration,
				]
					.filter(Boolean)
					.join(" · ");
				return <CompletionRow failed={failed} key={daemon.name} label={daemon.name} meta={meta} />;
			})}
		</CompletionRows>
	);
}

// ---------------------------------------------------------------------------
// lsp-late-diagnostic — diagnostics that arrived after edit/write returned
// ---------------------------------------------------------------------------

function LateDiagnosticsCard({ message }: { message: AgentMessage }) {
	const t = useT();
	const files = asArray(resultDetails(message)?.files)
		.map(file => asFileDiagnostics(file))
		.filter((file): file is FileDiagnostics => file !== undefined);
	const errored = files.some(file => file.errored);
	const summary = files
		.map(file => file.summary)
		.filter(Boolean)
		.join(", ");
	// TUI renders nothing when no diagnostics survived; keep that.
	if (diagnosticsCount(files) === 0) return null;
	return (
		<CardFrame>
			<div className={HEADER_CLASS}>
				{errored ? (
					<XCircle aria-hidden className={cx(HEADER_ICON_CLASS, "text-(--sc-danger)")} />
				) : (
					<AlertTriangle aria-hidden className={cx(HEADER_ICON_CLASS, "text-(--sc-warning)")} />
				)}
				<span className="shrink-0">{t("chat.custom.lateDiagnostics")}</span>
				{summary && <span className={HEADER_META_CLASS}>({summary})</span>}
			</div>
			<DiagnosticsList files={files} showPaths />
		</CardFrame>
	);
}

// ---------------------------------------------------------------------------
// skill-prompt — a skill invocation rendered as a distinct card
// ---------------------------------------------------------------------------

function SkillCard({ message }: { message: AgentMessage }) {
	const t = useT();
	const embedded = useContext(EmbeddedCard);
	const [open, setOpen] = useState(embedded);
	const details = resultDetails(message);
	const name = str(details?.name);
	// Collapse args to one line: a stray newline/tab would split the header.
	const args = str(details?.args)?.replace(/\s+/g, " ");
	const path = str(details?.path);
	const lineCount = num(details?.lineCount);
	const text = resultText(message.content).trim();

	const head = (
		<>
			<Zap aria-hidden className={HEADER_ICON_CLASS} />
			<span className="shrink-0">{t("chat.custom.skill")}</span>
			{name && <span className="shrink-0 font-medium text-(--sc-text)">{name}</span>}
			{args && <span className="min-w-0 flex-1 truncate font-mono text-sc-xs text-(--sc-text-subtle)">{args}</span>}
			{text && (
				<ChevronRight
					aria-hidden
					className={cx(
						"omp-disclosure-chevron ms-auto size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)",
						open && "rotate-90",
					)}
				/>
			)}
		</>
	);
	const headClass = "flex w-full min-w-0 items-center gap-1.5 text-left text-sc-sm font-medium text-(--sc-text-muted)";

	return (
		<CardFrame>
			{text ? (
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(v => !v)}
					className={cx(
						headClass,
						"-mx-1.5 -my-0.5 w-[calc(100%+0.75rem)] rounded-(--sc-radius-sm) px-1.5 py-0.5 transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover) hover:text-(--sc-text-secondary)",
					)}
				>
					{head}
				</button>
			) : (
				<div className={headClass}>{head}</div>
			)}
			{(path || lineCount != null) && (
				<div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-sc-xs text-(--sc-text-subtle)">
					{path && <span className="min-w-0 truncate text-(--sc-text-muted)">{path}</span>}
					{path && lineCount != null && <span aria-hidden>·</span>}
					{lineCount != null && (
						<span className="shrink-0">
							{t("chat.custom.skillLines", { count: lineCount, plural: lineCount === 1 ? "" : "s" })}
						</span>
					)}
				</div>
			)}
			{open && text && (
				<div className="omp-fade-in mt-2 border-t border-(--sc-divider) pt-2">
					<div className="mb-1 text-sc-xs font-medium text-(--sc-text-muted)">{t("chat.custom.prompt")}</div>
					<MarkdownRenderer content={text} />
				</div>
			)}
		</CardFrame>
	);
}

// ---------------------------------------------------------------------------
// collab-prompt — guest prompt shown on every participant's transcript
// ---------------------------------------------------------------------------

function CollabCard({ message }: { message: AgentMessage }) {
	const embedded = useContext(EmbeddedCard);
	const from = str(resultDetails(message)?.from) ?? "guest";
	const text = resultText(message.content).trim();
	return (
		<div
			className={
				embedded ? "omp-work-notes-body" : "omp-fade-up ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-3"
			}
		>
			<div
				className={
					embedded
						? ""
						: "omp-transcript-content rounded-xl border border-[var(--omp-user-msg-border)] bg-[var(--omp-user-msg-bg)] px-3.5 py-3 shadow-[var(--omp-shadow-sm)]"
				}
			>
				<div
					className={cx(
						"mb-1.5 text-omp-md font-bold",
						embedded ? "text-(--sc-text-muted)" : "text-[var(--omp-accent)]",
					)}
				>
					«{from}» ›
				</div>
				{text && <MarkdownRenderer content={text} userText />}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// irc:incoming / irc:autoreply / irc:relay — live IRC traffic cards
// ---------------------------------------------------------------------------

function IrcCard({ message }: { message: AgentMessage }) {
	const t = useT();
	const embedded = useContext(EmbeddedCard);
	const details = resultDetails(message);
	const kind =
		message.customType === "irc:incoming"
			? "incoming"
			: message.customType === "irc:autoreply"
				? "autoreply"
				: "relay";
	const from = str(details?.from) ?? "?";
	const to = str(details?.to) ?? "?";
	const body = str(kind === "incoming" ? details?.message : details?.body) ?? "";
	const title = kind === "incoming" ? `IRC ← ${from}` : kind === "autoreply" ? `IRC → ${to}` : `IRC ${from} → ${to}`;
	// Relative age ("8m ago"), the absolute time on hover; timestamp arrives as epoch ms or ISO.
	const age = formatAgo(message.timestamp);

	return (
		<CardFrame>
			<div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-sc-sm font-medium text-(--sc-text-secondary)">
				<MessagesSquare aria-hidden className={HEADER_ICON_CLASS} />
				<span className="min-w-0 truncate">{title}</span>
				{kind === "autoreply" && <Badge variant="muted">{t("chat.custom.ircAuto")}</Badge>}
				{str(details?.replyTo) && <Badge variant="muted">{t("chat.custom.ircReply")}</Badge>}
				{/* Inside a work note the note's own line already carries the time. */}
				{age && !embedded && (
					<time
						className="ml-auto shrink-0 font-mono text-omp-xs font-normal text-[var(--omp-dim)]"
						title={formatClock(message.timestamp)}
					>
						{age}
					</time>
				)}
			</div>
			{body && <MarkdownRenderer content={body} />}
		</CardFrame>
	);
}

// ---------------------------------------------------------------------------
// handoff — handoff context extracted from <handoff-context> tags
// ---------------------------------------------------------------------------

/** Pull the `<handoff-context>` document out of the raw message content. */
function extractHandoffDocument(text: string): string {
	const openTag = "<handoff-context>";
	const closeTag = "</handoff-context>";
	const openIndex = text.indexOf(openTag);
	if (openIndex === -1) return text.trim();
	const start = openIndex + openTag.length;
	const closeIndex = text.indexOf(closeTag, start);
	return (closeIndex === -1 ? text.slice(start) : text.slice(start, closeIndex)).trim();
}

function HandoffCard({ message }: { message: AgentMessage }) {
	const t = useT();
	const doc = extractHandoffDocument(resultText(message.content));
	return (
		<CardFrame>
			<div className={HEADER_CLASS}>
				<ArrowRightLeft aria-hidden className={HEADER_ICON_CLASS} />
				<span>{t("chat.custom.handoff")}</span>
			</div>
			<MarkdownRenderer content={doc || t("chat.custom.handoffEmpty")} />
		</CardFrame>
	);
}

/**
 * The idle recap (bridge `session-recap.ts`): one quiet muted line, not a bordered card, since it
 * only restates where things stand. Never part of a work run.
 */
export function RecapCard({ message }: { message: AgentMessage }) {
	const t = useT();
	const text = resultText(message).trim();
	if (!text) return null;
	return (
		<div className="omp-custom-turn omp-fade-up ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-2">
			<p
				className="omp-transcript-content flex min-w-0 items-start gap-1.5 text-sc-sm text-(--sc-text-muted)"
				data-recap
			>
				<History aria-hidden className={`${HEADER_ICON_CLASS} mt-0.5`} />
				<span className="min-w-0">
					<span className="font-medium">{t("chat.custom.recap")}</span> {text}
				</span>
			</p>
		</div>
	);
}

/**
 * A report another session sent this one (`ompdesk_report`, custom type `ompdesk.mail`): one quiet muted line, the
 * sender, the kind and the text; files and checks in the tooltip. Never a card: the work board carries the state.
 */
export function MailNote({ message }: { message: AgentMessage }) {
	const t = useT();
	const details = resultDetails(message);
	const text = str(details?.text) ?? "";
	if (!text) return null;
	const kind = str(details?.kind) ?? "note";
	const from = str(details?.fromTitle) || str(details?.from) || "?";
	const files = Array.isArray(details?.files) ? details.files.filter(item => typeof item === "string") : [];
	const checks = Array.isArray(details?.checks)
		? details.checks.flatMap(item =>
				item && typeof item === "object" && typeof item.command === "string"
					? [`${item.command} ${item.passed === true ? "✓" : "✕"}`]
					: [],
			)
		: [];
	const extra = [...files, ...checks].join("\n");
	return (
		<div className="omp-custom-turn omp-fade-up ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-1.5">
			<p
				className="omp-transcript-content flex min-w-0 items-start gap-1.5 text-sc-sm text-(--sc-text-muted)"
				data-agent-mail={kind}
				title={extra || undefined}
			>
				<span className="min-w-0">
					<span className="font-medium">{t("chat.custom.mail", { from })}</span>{" "}
					<span className={kind === "question" || kind === "blocked" ? "text-(--sc-warning)" : undefined}>
						{t(`chat.custom.mail.kind.${kind}`)}
					</span>
					: {text}
				</span>
			</p>
		</div>
	);
}
