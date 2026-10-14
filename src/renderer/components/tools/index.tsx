import {
	AppWindow,
	Ban,
	BookMarked,
	Bot,
	Braces,
	Bug,
	CheckCheck,
	Code2,
	FileCode2,
	FilePlus2,
	FileSearch,
	FileText,
	Flag,
	FolderSearch,
	GitPullRequest,
	Globe,
	History,
	Hourglass,
	ImagePlus,
	ListTodo,
	type LucideIcon,
	MessageCircleQuestion,
	MousePointer2,
	Network,
	Pencil,
	Search,
	SearchCode,
	ShieldCheck,
	Sparkles,
	StickyNote,
	Target,
	Terminal,
	Volume2,
	Wrench,
} from "lucide-react";
import type { ComponentType } from "react";
import { sanitizeToolText } from "../../lib/format";
import { translate } from "../../lib/i18n";
import { decodeXdevPayload, xdevDispatch, xdevInnerResult, xdevWriteTarget } from "../../lib/xdev";
import { AskRenderer } from "./AskRenderer";
import { AstEditRenderer } from "./AstEditRenderer";
import { AstGrepRenderer } from "./AstGrepRenderer";
import { BashRenderer } from "./BashRenderer";
import { BrowserRenderer } from "./BrowserRenderer";
import { ComputerRenderer } from "./ComputerRenderer";
import { WaitRenderer } from "./CoordinationRenderer";
import { DebugRenderer } from "./DebugRenderer";
import { EditRenderer } from "./EditRenderer";
import { EvalRenderer } from "./EvalRenderer";
import { editArgumentPaths, editArgumentSummary } from "./edit-args";
import { FindRenderer } from "./FindRenderer";
import { GenericRenderer } from "./GenericRenderer";
import { GithubRenderer } from "./GithubRenderer";
import { GlobRenderer } from "./GlobRenderer";
import { GoalRenderer } from "./GoalRenderer";
import { GrepRenderer } from "./GrepRenderer";
import { HubRenderer } from "./HubRenderer";
import { ImageRenderer } from "./ImageRenderer";
import { LspRenderer } from "./LspRenderer";
import { MemoryRenderer } from "./MemoryRenderer";
import { ReadRenderer } from "./ReadRenderer";
import { ResolveRenderer } from "./ResolveRenderer";
import { TaskRenderer } from "./TaskRenderer";
import { TodoRenderer } from "./TodoRenderer";
import type { ToolRendererProps } from "./ToolCard";
import {
	VibeKillRenderer,
	VibeListRenderer,
	VibeSendRenderer,
	VibeSpawnRenderer,
	VibeWaitRenderer,
} from "./VibeRenderer";
import { WebSearchRenderer } from "./WebSearchRenderer";
import { WriteRenderer } from "./WriteRenderer";

export type { ToolRendererProps };

/** Clipped by CSS, but a megabyte of pasted text must not enter the DOM. */
const CARD_TEXT_MAX_CHARS = 160;

function clipCardText(text: string): string {
	return text.length > CARD_TEXT_MAX_CHARS ? `${text.slice(0, CARD_TEXT_MAX_CHARS)}…` : text;
}

/**
 * `write` carries two different things: a file write, and the device call the
 * sidecar routes through it (`write xd://<tool>`, see `lib/xdev`). A device call
 * must render as the tool that ran — otherwise a plan resolution, a security
 * scan or an MCP call shows up as a file write with a line count and the
 * outcome disappears entirely.
 */
function WriteRendererOrDevice(props: ToolRendererProps) {
	const { args, result, isError, isPartial, partialResult, interrupted } = props;
	const device = xdevWriteTarget(args);
	if (!device) return <WriteRenderer {...props} />;

	const envelope = isPartial ? partialResult : result;
	const dispatch = xdevDispatch(envelope);
	// No dispatch metadata: the payload is still streaming, or the write failed
	// before reaching a device. Show the request as key/value rows rather than a
	// file-write card — the wrapped tool has produced no verdict to render.
	if (!dispatch) {
		const raw = typeof args.content === "string" ? args.content : "";
		const decoded = decodeXdevPayload(raw);
		return (
			<GenericRenderer
				args={Object.keys(decoded).length > 0 ? decoded : { content: clipCardText(raw) }}
				isPartial={isPartial}
				result={envelope}
			/>
		);
	}
	if (dispatch.mode === "help") return <GenericRenderer args={{}} result={envelope} />;

	const name = dispatch.tool || device;
	// `xd://write` dispatches the write tool itself; delegating would recurse.
	const Renderer = name === "write" ? GenericRenderer : getToolRenderer(name);
	const inner = xdevInnerResult(envelope, dispatch);
	return (
		<Renderer
			args={dispatch.args ?? decodeXdevPayload(args.content)}
			interrupted={interrupted}
			isError={isError}
			isPartial={isPartial}
			partialResult={inner}
			result={inner}
		/>
	);
}

/**
 * Tool name → renderer. Every name the sidecar can emit for a top-level call
 * belongs here or in `GENERIC_TOOL_NAMES` below; `xd://` device names resolve
 * through this table too (see `WriteRendererOrDevice`). Anything unmapped falls
 * back to GenericRenderer, which is a lossy view, not a broken one.
 */
const REGISTRY: Record<string, ComponentType<ToolRendererProps>> = {
	read: ReadRenderer,
	edit: EditRenderer,
	ast_edit: AstEditRenderer,
	apply_patch: EditRenderer,
	goal: GoalRenderer,
	write: WriteRendererOrDevice,
	bash: BashRenderer,
	grep: GrepRenderer,
	find: FindRenderer,
	glob: GlobRenderer,
	task: TaskRenderer,
	todo: TodoRenderer,
	todowrite: TodoRenderer,
	todo_write: TodoRenderer,
	set_todos: TodoRenderer,
	eval: EvalRenderer,
	browser: BrowserRenderer,
	debug: DebugRenderer,
	lsp: LspRenderer,
	github: GithubRenderer,
	gh: GithubRenderer,
	hub: HubRenderer,
	wait: WaitRenderer,
	ask: AskRenderer,
	computer: ComputerRenderer,
	generate_image: ImageRenderer,
	ast_grep: AstGrepRenderer,
	web_search: WebSearchRenderer,
	vibe_spawn: VibeSpawnRenderer,
	vibe_send: VibeSendRenderer,
	vibe_wait: VibeWaitRenderer,
	vibe_kill: VibeKillRenderer,
	vibe_list: VibeListRenderer,
	retain: MemoryRenderer,
	recall: (props: ToolRendererProps) => <MemoryRenderer {...props} operation="recall" />,
	reflect: (props: ToolRendererProps) => <MemoryRenderer {...props} operation="reflect" />,
	memory_edit: MemoryRenderer,
	resolve: ResolveRenderer,
	// A pending reject carries only a reason — the wrapper pins the operation
	// so the card never renders as "Resolving".
	reject: (props: ToolRendererProps) => <ResolveRenderer {...props} operation="reject" />,
};

export function getToolRenderer(name: string): ComponentType<ToolRendererProps> {
	return REGISTRY[name] ?? GenericRenderer;
}

/** Keys tried in order for a device call's header: the verb, then its object. */
const DEVICE_VERB_KEYS = ["action", "op", "command"] as const;
const DEVICE_OBJECT_KEYS = ["query", "symbol", "path", "file", "pattern", "url", "name"] as const;

function argLine(args: Record<string, unknown>, keys: readonly string[]): string {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return sanitizeToolText(value.split("\n", 1)[0] ?? "");
	}
	return "";
}

/**
 * `LSP · references foo` instead of `xd://lsp`, so a collapsed device call
 * reads as the tool that ran (parity with the TUI's activity summary).
 */
function xdevSummary(device: string, content: unknown): string {
	const args = decodeXdevPayload(content);
	const detail = [argLine(args, DEVICE_VERB_KEYS), argLine(args, DEVICE_OBJECT_KEYS)].filter(Boolean).join(" ");
	return detail ? `${device} · ${detail}` : device;
}

/** Batch tools name their payload `items`; the first entry is the header. */
function firstItemContent(args: Record<string, unknown>): string {
	if (!Array.isArray(args.items)) return "";
	const first = args.items[0];
	if (first != null && typeof first === "object")
		return argLine(first as Record<string, unknown>, ["content", "text"]);
	return typeof first === "string" ? first : "";
}

/**
 * One-line header for a collapsed card, computed from call arguments only —
 * the result may not exist yet. Lives next to the renderer table because the
 * header and the body describe the same call; a `switch` in the transcript
 * layer is what let `find`, `checkpoint` and every device call show nothing.
 */
const SUMMARIES: Record<string, (args: Record<string, unknown>) => string> = {
	read: args => argLine(args, ["path", "file"]),
	write: args => {
		const device = xdevWriteTarget(args);
		return device ? xdevSummary(device, args.content) : argLine(args, ["path", "file"]);
	},
	edit: editArgumentSummary,
	apply_patch: editArgumentSummary,
	bash: args => argLine(args, ["command", "cmd"]),
	grep: args => argLine(args, ["pattern"]),
	find: args => argLine(args, ["query"]),
	glob: args => argLine(args, ["path", "pattern"]),
	ast_grep: args => argLine(args, ["pat", "pattern", "query"]),
	ast_edit: args => argLine(args, ["pat", "pattern"]),
	lsp: args => [argLine(args, ["action"]), argLine(args, ["symbol", "file", "path"])].filter(Boolean).join(" "),
	task: args => argLine(args, ["i", "name", "description"]),
	todo: args => [argLine(args, ["op"]), argLine(args, ["task", "reason"])].filter(Boolean).join(" "),
	eval: args => argLine(args, ["title", "language"]),
	debug: args => [argLine(args, ["action"]), argLine(args, ["program", "file", "symbol"])].filter(Boolean).join(" "),
	github: args => argLine(args, ["action", "repo", "url"]),
	hub: args => argLine(args, ["op", "agent"]),
	// Stock's wait takes no arguments: the model's intent, else what every wait is for, in the UI
	// language (a fixed English phrase read "대기 background activity" in a Korean card).
	wait: args => argLine(args, ["i"]) || translate("tools.wait.target"),
	ask: args => argLine(args, ["question", "i"]),
	goal: args => argLine(args, ["objective", "op"]),
	checkpoint: args => argLine(args, ["goal"]),
	rewind: args => argLine(args, ["report"]),
	security_scan: args => argLine(args, ["action", "target_kind"]),
	context_notes: args => argLine(args, ["text"]),
	learn: args => argLine(args, ["memory"]),
	manage_skill: args => [argLine(args, ["action"]), argLine(args, ["name"])].filter(Boolean).join(" "),
	memory_edit: args => [argLine(args, ["op"]), argLine(args, ["id"])].filter(Boolean).join(" "),
	retain: args => firstItemContent(args) || argLine(args, ["text", "memory"]),
	recall: args => argLine(args, ["query", "text"]),
	reflect: args => argLine(args, ["topic", "query"]),
	web_search: args => argLine(args, ["query", "i"]),
	generate_image: args => argLine(args, ["subject", "prompt"]),
	tts: args => argLine(args, ["text"]),
	resolve: args => argLine(args, ["reason", "label"]),
	reject: args => argLine(args, ["reason"]),
};

const FALLBACK_ARG_KEYS = ["path", "file", "name", "pattern", "query", "command", "action", "i", "text"] as const;

/** Header text for any tool call; unknown tools fall back to their first scalar argument. */
export function getToolSummary(name: string, args: Record<string, unknown>): string {
	const summary = SUMMARIES[name];
	return clipCardText(summary ? summary(args) : argLine(args, FALLBACK_ARG_KEYS));
}

/** What a step did, for the work group's "Read 2 files · Ran 1 command" summary. */
export type ToolActivity = "read" | "edit" | "run" | "search" | "other";

interface ToolMeta {
	/** `tools.label.<label>` i18n suffix; aliases share one label. */
	label: string;
	icon: LucideIcon;
	activity: ToolActivity;
}

const MEMORY: Omit<ToolMeta, "label"> = { icon: BookMarked, activity: "other" };
const TODO: ToolMeta = { label: "todo", icon: ListTodo, activity: "other" };
const GITHUB: ToolMeta = { label: "github", icon: GitPullRequest, activity: "other" };
const VIBE: ToolMeta = { label: "vibe", icon: Sparkles, activity: "other" };

/** Human label + kind icon per tool name; unknown tools keep their raw name and a wrench. */
const TOOL_META: Record<string, ToolMeta> = {
	read: { label: "read", icon: FileText, activity: "read" },
	write: { label: "write", icon: FilePlus2, activity: "edit" },
	edit: { label: "edit", icon: Pencil, activity: "edit" },
	apply_patch: { label: "apply_patch", icon: Pencil, activity: "edit" },
	ast_edit: { label: "ast_edit", icon: FileCode2, activity: "edit" },
	bash: { label: "bash", icon: Terminal, activity: "run" },
	eval: { label: "eval", icon: Code2, activity: "run" },
	grep: { label: "grep", icon: Search, activity: "search" },
	find: { label: "find", icon: FileSearch, activity: "search" },
	glob: { label: "glob", icon: FolderSearch, activity: "search" },
	ast_grep: { label: "ast_grep", icon: SearchCode, activity: "search" },
	web_search: { label: "web_search", icon: Globe, activity: "search" },
	lsp: { label: "lsp", icon: Braces, activity: "other" },
	task: { label: "task", icon: Bot, activity: "other" },
	todo: TODO,
	todowrite: TODO,
	todo_write: TODO,
	set_todos: TODO,
	browser: { label: "browser", icon: AppWindow, activity: "other" },
	computer: { label: "computer", icon: MousePointer2, activity: "other" },
	github: GITHUB,
	gh: GITHUB,
	debug: { label: "debug", icon: Bug, activity: "other" },
	ask: { label: "ask", icon: MessageCircleQuestion, activity: "other" },
	wait: { label: "wait", icon: Hourglass, activity: "other" },
	goal: { label: "goal", icon: Target, activity: "other" },
	hub: { label: "hub", icon: Network, activity: "other" },
	retain: { label: "retain", ...MEMORY },
	recall: { label: "recall", ...MEMORY },
	reflect: { label: "reflect", ...MEMORY },
	memory_edit: { label: "memory_edit", ...MEMORY },
	learn: { label: "learn", ...MEMORY },
	context_notes: { label: "context_notes", icon: StickyNote, activity: "other" },
	manage_skill: { label: "manage_skill", icon: Wrench, activity: "other" },
	generate_image: { label: "generate_image", icon: ImagePlus, activity: "other" },
	tts: { label: "tts", icon: Volume2, activity: "other" },
	resolve: { label: "resolve", icon: CheckCheck, activity: "other" },
	reject: { label: "reject", icon: Ban, activity: "other" },
	checkpoint: { label: "checkpoint", icon: Flag, activity: "other" },
	rewind: { label: "rewind", icon: History, activity: "other" },
	security_scan: { label: "security_scan", icon: ShieldCheck, activity: "other" },
	vibe_spawn: VIBE,
	vibe_send: VIBE,
	vibe_wait: VIBE,
	vibe_kill: VIBE,
	vibe_list: VIBE,
};

/** Stock eval's language tokens (`py`, `js` and their long forms) as people name them. */
const EVAL_LANGUAGES: Record<string, string> = {
	py: "Python",
	python: "Python",
	js: "JavaScript",
	javascript: "JavaScript",
};

export interface ToolHeader {
	/** Tool the row is labelled as — the device for an `xd://` call routed through write. */
	tool: string;
	/** Label key (`tools.label.*`, or a parameterized one with `labelParams`), or null for an unknown tool (show `tool` itself). */
	labelKey: string | null;
	labelParams?: Record<string, string>;
	icon: LucideIcon;
	activity: ToolActivity;
	/** Visible target text (command, pattern, query…); for file tools, the full path. */
	target: string;
	/** Set when the target is a file path: the row shows the file name first, its folder muted. */
	path?: string;
	/** Further files of a multi-file edit. */
	moreFiles?: number;
}

const FILE_TARGET_TOOLS: Record<string, true> = { read: true, write: true, edit: true, apply_patch: true };

/**
 * Everything the collapsed row needs to read as a human step: label key, kind
 * icon, and the target — a file (name-first), a command, a pattern. Device
 * calls (`write xd://lsp`) read as the device that ran.
 */
export function getToolHeader(name: string, args: Record<string, unknown>): ToolHeader {
	const device = name === "write" ? xdevWriteTarget(args) : undefined;
	const tool = device || name;
	const meta = TOOL_META[tool];
	const header: ToolHeader = {
		tool,
		labelKey: meta ? `tools.label.${meta.label}` : null,
		icon: meta?.icon ?? Wrench,
		activity: meta?.activity ?? "other",
		target: "",
	};
	if (device) {
		const payload = decodeXdevPayload(args.content);
		header.target = clipCardText(
			[argLine(payload, DEVICE_VERB_KEYS), argLine(payload, DEVICE_OBJECT_KEYS)].filter(Boolean).join(" "),
		);
		return header;
	}
	if (FILE_TARGET_TOOLS[name]) {
		const paths = name === "edit" || name === "apply_patch" ? editArgumentPaths(args) : [];
		const path = paths[0] ?? argLine(args, ["path", "file", "file_path"]);
		if (path && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
			header.path = clipCardText(path);
			header.target = header.path;
			if (paths.length > 1) header.moreFiles = paths.length - 1;
			return header;
		}
	}
	if (name === "eval") {
		// A code cell is named by the language it runs ("Run JavaScript"), never the wire token
		// ("Run code js"); its target is its title alone.
		const language = typeof args.language === "string" ? args.language : "js";
		header.labelKey = "chat.work.runLanguage";
		header.labelParams = { language: EVAL_LANGUAGES[language] ?? language };
		header.target = clipCardText(argLine(args, ["title"]));
		return header;
	}
	header.target = getToolSummary(name, args);
	return header;
}

/**
 * What a call did and how many files it touched, for the work group summary
 * ("Read 2 files · Edited 1 file"). Cheap enough for a store selector: no
 * summary strings are built.
 */
export function getToolActivity(
	name: string,
	args: Record<string, unknown>,
): { activity: ToolActivity; files: number } {
	const device = name === "write" ? xdevWriteTarget(args) : undefined;
	const activity = TOOL_META[device || name]?.activity ?? "other";
	if (device || activity !== "edit") return { activity, files: 1 };
	return { activity, files: Math.max(1, editArgumentPaths(args).length) };
}
