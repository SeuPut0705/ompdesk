/**
 * OMPdesk control tools (src/shared/agent-control.ts, executed in main by src/main/agent-control/): the parts that
 * need the live session.
 * - A risky tool call (stopping, closing, deleting or merging for another session) is held in main until the person
 *   approves it on a confirmation card, and that card is stock's own extension-UI `confirm` raised by the calling
 *   tab's omp (`ctx.ui.confirm`, as /omfg asks where to save a rule), so it renders, survives a reload, is answered
 *   once across windows and reaches a paired device exactly like every other approval.
 * - When an agent answers another session's question, the answered session journals it (`ompdesk.agent-answer`
 *   custom entry, so the answer is auditable there) and says so (`ctx.ui.notify`, a toast in its window).
 * - A session another session's agent opened (`ompdesk_session_open`, Autopilot children included) journals
 *   `ompdesk.worker` before its first prompt; while that entry is on its branch its main agent gets the short worker
 *   contract (`WORKER_CONTRACT`) as a registered prompt section. The journal, not process state, carries it, so a
 *   relaunched child keeps it and a session the user opened never gets it.
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	ATTACHMENT_MAX_BYTES,
	type AttachmentWire,
	hasMailEntry,
	journaledMarks,
	MAIL_CUSTOM_TYPE,
	sniffImageType,
} from "./agent-control-contracts";
import { crossFamily, JUDGE_ROLES, modelFamily } from "./agent-control-judge-core";
import { completeOnSmol, type ModelLike, type NextPromptSession } from "./modes/next-prompt-engine";
import { type PromptSectionContext, type PromptSectionHost, registerPromptSection } from "./prompt-sections";

/**
 * The slice of `BridgeEnv` (types.ts) these methods touch. types.ts imports omp's own types, which the GUI's `tsc`
 * cannot resolve where omp is not installed, and a module the GUI's tests import must not pull it in.
 */
interface ControlSession {
	/** Stock `AgentSession.isStreaming`: a turn runs (or a prompt is being set up). */
	isStreaming: boolean;
	/** Stock `AgentSession.messages`: the live conversation, oldest first. */
	messages: readonly unknown[];
	sessionManager: {
		getCwd(): string;
		getBranch(): { customType?: unknown; data?: unknown }[];
		appendCustomEntry(customType: string, data: unknown): unknown;
	};
}
interface ControlEnv {
	session(): ControlSession;
	context(): {
		ui: { confirm(title: string, message: string): Promise<unknown>; notify(message: string, type: "info"): void };
	};
}
type BridgeMethods = Record<string, (params: unknown, env: ControlEnv) => Promise<unknown>>;

const TEXT_MAX = 2000;
/** The judge's evidence is bounded in main; this is the last guard. */
const JUDGE_INPUT_MAX = 120_000;
/** A judge reads a long evidence prompt and writes a verdict; main waits 180 s for the reply. */
const JUDGE_DEADLINE_MS = 170_000;
export const AGENT_ANSWER_ENTRY = "ompdesk.agent-answer";
export const WORKER_ENTRY = "ompdesk.worker";
/** What a session opened by another agent should know about its role; kept short and plain. */
export const WORKER_CONTRACT = `<ompdesk-worker>
Another agent opened this session and handed you its first message; the person sees this tab and may also write to you.
- Work only in this session's folder. When a message or a result names an absolute path in another checkout, do not read or write it; ask instead.
- Never use \`git stash\`: every worktree of a repository shares one stash, so another session's stash can land in yours. Commit work in progress to your branch instead.
- Stay inside the files and scope the message names. If the task needs more, say so in your answer rather than widening it.
- Done means the observable acceptance in the message holds, checked by you, and any requested commit is on your branch.
- Your final answer is what the other agent reads: what changed (files, commits), how you checked it with the actual result, and anything left undone.
- End your final answer with one last line: \`Result: ok\` when the acceptance holds and every check you ran passed, else \`Result: problem — <reason>\` (a failed or skipped check, work left undone). The other agent reads that line, not your prose. That final answer is delivered to it automatically as your done report: do not send a done report yourself.
- Use ompdesk_report only for question or blocked when you need its decision (then wait for its answer; never guess an approval), progress at real milestones, and kind note with to set to a sibling it opened. Pass the dispatch id its message names.
- Keep replying to the person in their language when they write to you.
</ompdesk-worker>`;

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`agent_control needs a ${field}`);
	return value.slice(0, TEXT_MAX);
}

/** True when this session was opened by another session's agent. */
export function isWorkerSession(ctx: PromptSectionContext): boolean {
	return ctx.sessionManager.getBranch().some(entry => entry.customType === WORKER_ENTRY);
}

/** What a report carries to its receiver: text, and the pictures sent along (stock's `(TextContent | ImageContent)[]`). */
type MailContent = string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];

interface MailMessage {
	customType: string;
	content: MailContent;
	display: boolean;
	details?: unknown;
}

/** Stock's `pi.sendMessage` (a custom message, journaled and shown per its delivery). */
interface MailHost {
	sendMessage(message: MailMessage, options?: { triggerTurn?: boolean; deliverAs?: "aside" }): void;
}

/** The main session's `pi` (the first install; a subagent's rebinding never replaces it). */
let mailHost: MailHost | undefined;

export function install(pi: PromptSectionHost & Partial<MailHost>): void {
	if (!mailHost && typeof pi.sendMessage === "function") mailHost = pi as MailHost;
	// The main agent only: its own subagents are briefed by it, not by this contract.
	registerPromptSection(pi, "ompdesk-worker", ctx =>
		ctx.agent.kind === "main" && isWorkerSession(ctx) ? WORKER_CONTRACT : undefined,
	);
}

const EXTENSION_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".csv": "text/csv",
	".html": "text/html",
	".zip": "application/zip",
	".log": "text/plain",
};
const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

function tooBig(bytes: number): Error {
	return new Error(`it is ${bytes} bytes; an attachment is at most ${ATTACHMENT_MAX_BYTES} bytes (10 MiB)`);
}

function wire(name: string, mimeType: string, bytes: Buffer): AttachmentWire {
	return {
		name,
		mimeType,
		dataBase64: bytes.toString("base64"),
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

/** A file on this computer: absolute, or relative to the session's folder. */
async function attachFile(requested: string, env: ControlEnv): Promise<AttachmentWire> {
	const file = path.resolve(env.session().sessionManager.getCwd(), requested);
	const info = await stat(file);
	if (!info.isFile()) throw new Error(`${file} is not a file`);
	if (info.size > ATTACHMENT_MAX_BYTES) throw tooBig(info.size);
	const bytes = await readFile(file);
	if (bytes.length > ATTACHMENT_MAX_BYTES) throw tooBig(bytes.length);
	const name = path.basename(file);
	const mimeType =
		sniffImageType(bytes) ?? EXTENSION_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
	return wire(name, mimeType, bytes);
}

/** Every picture of the live conversation (a person's, a tool result's, a message's), newest first. */
function conversationImages(messages: readonly unknown[]): { data: string; mimeType: string }[] {
	const found: { data: string; mimeType: string }[] = [];
	for (const message of messages) {
		const content = (message as { content?: unknown } | null)?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Record<string, unknown>[])
			if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
				found.push({ data: block.data, mimeType: block.mimeType });
	}
	return found.reverse();
}

const BLOBS_MODULE = "./agent-control-blobs";

/** The n-th newest picture (1 = newest) of this session's conversation; a blob reference is read from stock's store. */
async function attachImage(n: number, env: ControlEnv): Promise<AttachmentWire> {
	const images = conversationImages(env.session().messages);
	const image = images[n - 1];
	if (!image)
		throw new Error(
			`this conversation holds ${images.length} picture${images.length === 1 ? "" : "s"}, so there is no image ${n}`,
		);
	let bytes: Buffer;
	if (image.data.startsWith("blob:")) {
		// Stock's own store, as `read_image_blob` reads it. The specifier is a variable so the GUI's `tsc` (which has no
		// omp to resolve) does not follow it; it is loaded only here, so the module stands on a fake `pi`.
		const { readBlob } = (await import(BLOBS_MODULE)) as { readBlob(ref: string): Promise<Buffer | null> };
		const stored = await readBlob(image.data);
		if (!stored) throw new Error(`image ${n} is no longer in omp's picture store`);
		bytes = stored;
	} else {
		if (image.data.length > Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 + 4)
			throw tooBig(Math.floor((image.data.length * 3) / 4));
		bytes = Buffer.from(image.data, "base64");
	}
	if (bytes.length > ATTACHMENT_MAX_BYTES) throw tooBig(bytes.length);
	const extension = IMAGE_EXTENSIONS[image.mimeType] ?? "bin";
	return wire(`image-${n}.${extension}`, image.mimeType, bytes);
}

/** Report ids this process handed to stock (an aside is journaled only once the receiver's loop takes it). */
const queuedMail = new Set<string>();

/**
 * This omp process (pid and start time): the same across a reload of this module, new with every process, so main
 * tells "the omp I handed a message to, which still queues it" from "a new omp, whose predecessor's queue is gone".
 */
const OMP_INSTANCE = `${process.pid}-${Math.round(performance.timeOrigin)}`;

/** A report's content: text, or text blocks and picture blocks with some text in them; undefined when it holds none. */
function mailContent(value: unknown): MailContent | undefined {
	if (typeof value === "string") return value.trim() ? value : undefined;
	if (!Array.isArray(value)) return undefined;
	const blocks: Exclude<MailContent, string> = [];
	for (const block of value as Record<string, unknown>[]) {
		if (block?.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
		else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return blocks.some(block => block.type === "text" && block.text.trim()) ? blocks : undefined;
}

export const methods: BridgeMethods = {
	/**
	 * `{content, details, triggerTurn, deliverAs?}` → `{}`: a report from another session (`ompdesk_report`), as one
	 * stock custom message: journaled with the session (a relaunch neither loses nor repeats it), shown as a quiet line,
	 * and delivered by stock's own rules (`aside` at the next step boundary, an interruptible `wait` returning on it;
	 * `triggerTurn` wakes an idle session). A no-turn report (`triggerTurn: false`, no `deliverAs`) that finds a turn
	 * running goes as an `aside` too: stock's no-turn delivery into a running turn would steer (cutting the tool batch)
	 * and its `nextTurn` stays hidden until the person's next prompt.
	 */
	"agent_control.mail": async (params, env) => {
		const record = (params ?? {}) as Record<string, unknown>;
		const content = mailContent(record.content);
		if (!content) throw new Error("agent_control.mail needs content");
		if (!mailHost) throw new Error("This omp cannot receive reports (no extension sendMessage).");
		const details = (record.details ?? {}) as Record<string, unknown>;
		const id = typeof details.id === "string" ? details.id : undefined;
		// Idempotent across restarts of either side: the journal is the record of what arrived, and until stock's loop
		// takes a queued aside this process remembers it. `journaled` tells main which of the two it is: main keeps a
		// report until the receiver's journal holds it (a killed omp loses an aside it still queued).
		const branch = env.session().sessionManager.getBranch();
		const journaled = id !== undefined && hasMailEntry(branch, id);
		if (id && (journaled || queuedMail.has(id))) return { duplicate: true, journaled };
		if (id) queuedMail.add(id);
		const message = { customType: MAIL_CUSTOM_TYPE, content, display: true, details };
		// Idle, an aside starts a turn (stock), so a no-turn report keeps stock's plain idle delivery: shown at once.
		const deliverAs = record.deliverAs === "aside" || env.session().isStreaming ? "aside" : undefined;
		const triggerTurn = record.triggerTurn === true;
		mailHost.sendMessage(message, { triggerTurn, ...(deliverAs ? { deliverAs } : {}) });
		return {};
	},
	/**
	 * `{path}` or `{image}` → `{name, mimeType, dataBase64, sha256}`: one attachment of `ompdesk_session_send` /
	 * `ompdesk_report`, read where this omp runs, so a caller on a paired host hands over its own computer's file or
	 * its own conversation's picture (`image` n is the n-th newest, 1 = the newest). Refuses a folder, a missing
	 * file, one over `ATTACHMENT_MAX_BYTES` and a picture the conversation does not hold.
	 */
	"agent_control.attachment": async (params, env) => {
		const record = (params ?? {}) as Record<string, unknown>;
		if (typeof record.path === "string" && record.path.trim() && record.image === undefined)
			return attachFile(record.path, env);
		if (
			typeof record.image === "number" &&
			Number.isInteger(record.image) &&
			record.image >= 1 &&
			record.path === undefined
		)
			return attachImage(record.image, env);
		throw new Error("agent_control.attachment needs {path} or {image} (a whole number from 1), one of them");
	},
	/**
	 * `{marks}` → `{instance, journaled}`: which of the message markers main sent (`[ompdesk dispatch d2:`, `[ompdesk
	 * request <id>]`) this session's journal holds, and which omp process answers. Stock keeps a queued follow-up in
	 * memory only, so a message handed to an omp that has since ended is lost unless its journal holds it.
	 */
	"agent_control.sent": async (params, env) => {
		const marks = (params as { marks?: unknown } | null)?.marks;
		if (!Array.isArray(marks) || !marks.every(mark => typeof mark === "string" && mark.length > 0))
			throw new Error("agent_control.sent needs marks");
		return { instance: OMP_INSTANCE, journaled: journaledMarks(env.session().sessionManager.getBranch(), marks) };
	},
	/** `{title, message}` → `{approved}`: a dismissed or cancelled card is a refusal. */
	"agent_control.confirm": async (params, env) => {
		const record = (params ?? {}) as Record<string, unknown>;
		const approved = await env.context().ui.confirm(text(record.title, "title"), text(record.message, "message"));
		return { approved: approved === true };
	},
	/** `{text}` → `{}`: this session was answered by an agent. */
	"agent_control.note": async (params, env) => {
		const label = text((params as Record<string, unknown> | null)?.text, "text");
		env.session().sessionManager.appendCustomEntry(AGENT_ANSWER_ENTRY, { text: label, at: Date.now() });
		env.context().ui.notify(label, "info");
		return {};
	},
	/** `{from}` → `{}`: this session was opened by the agent of the session titled `from`; once per session. */
	"agent_control.worker": async (params, env) => {
		const from = text((params as Record<string, unknown> | null)?.from, "from").slice(0, 200);
		const manager = env.session().sessionManager;
		if (!manager.getBranch().some((entry: { customType?: unknown }) => entry.customType === WORKER_ENTRY))
			manager.appendCustomEntry(WORKER_ENTRY, { from, at: Date.now() });
		return {};
	},
	/**
	 * `{system, user}` → `{text, model, role, family, mainModel, mainFamily, crossFamily, usd?, tokens?}`: the control
	 * tools' judge (`ompdesk_compare` with criteria), one request on stock's `advisor` role, then `slow` (each with its
	 * fallbacks per `resolveRoleChain`), never the session's own model. A candidate whose family (`Model.identity.class`)
	 * differs from the session's model is preferred, so the judge does not grade its own lineage; when none does, or a
	 * family is unknown, the first credentialed candidate judges and `crossFamily` says so (false, or null when either
	 * family is unknown). Journaled in stock's usage ledger as `ompdesk-judge`. Main builds the prompt from the
	 * compared sessions' evidence and turns a rejection (no model, no credentials, a failed request) into `unavailable`.
	 */
	"agent_control.judge": async (params, env) => {
		const record = (params ?? {}) as Record<string, unknown>;
		const system = typeof record.system === "string" ? record.system : "";
		const user = typeof record.user === "string" ? record.user : "";
		if (!system.trim() || !user.trim()) throw new Error("agent_control.judge needs {system, user}");
		const session = env.session() as unknown as NextPromptSession & { model?: ModelLike };
		const main = session.model ?? null;
		const judged = await completeOnSmol(session, {
			system,
			user: user.slice(0, JUDGE_INPUT_MAX),
			maxTokens: 2_000,
			temperature: 0,
			purpose: "ompdesk-judge",
			roles: JUDGE_ROLES,
			prefer: model => crossFamily(model, main) !== false,
			deadlineMs: JUDGE_DEADLINE_MS,
		});
		return {
			text: judged.text,
			model: judged.model,
			role: judged.role,
			family: modelFamily(judged.modelRef),
			mainModel: main ? `${main.provider}/${main.id}` : null,
			mainFamily: modelFamily(main),
			crossFamily: crossFamily(judged.modelRef, main),
			...(judged.usd === undefined ? {} : { usd: judged.usd }),
			...(judged.tokens === undefined ? {} : { tokens: judged.tokens }),
		};
	},
};
