import {
	ImageOff,
	Info,
	Lightbulb,
	type LucideIcon,
	MessageSquareWarning,
	OctagonAlert,
	TriangleAlert,
} from "lucide-react";
import {
	type ComponentPropsWithoutRef,
	createContext,
	isValidElement,
	type MouseEvent,
	memo,
	type ReactElement,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import ReactMarkdown, { type Components, defaultUrlTransform, type Options } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeBlock as SharedCodeBlock } from "../components/chat/CodeBlock";
import { MermaidBlock } from "../components/chat/MermaidBlock";
import { SvgBlock } from "../components/chat/SvgBlock";
import { ZoomableImage } from "../components/common/ZoomableImage";
import { chatMediaKind, chatReferenceKind, fileUrlPath, localFilePath } from "../components/tools/media/chat-media";
import { FileCard } from "../components/tools/media/FileCard";
import { ChatMedia } from "../components/tools/media/ToolMedia";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { toastError } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { saveGuiPreference } from "./display-preferences";
import { cx } from "./format";
import { useT } from "./i18n";
import { useLinkMenu } from "./link-menu";
import { openLocalPath, PathMentionLink, pathLocation, verifyPath } from "./markdown-path-link";
import { rehypeLocalPaths } from "./markdown-paths";
import {
	isMarkdownAlertKind,
	MARKDOWN_ID_PREFIX,
	type MarkdownAlertKind,
	rehypeAlerts,
	rehypeHeadingIds,
} from "./markdown-rehype";
import { openExternal } from "./open-external";
import { PREVIEW_HEIGHT_LG, PREVIEW_SCROLL_CODE } from "./preview";
import { remarkCjkAutolink, remarkCjkStrong } from "./remark-cjk";
import { remarkHtmlAsText } from "./remark-html-text";
import { remarkLatexMath } from "./remark-latex-math";
import { remarkSoftBreaks } from "./remark-soft-breaks";
import { useTabRpc } from "./tab-rpc";

interface MarkdownRendererProps {
	content: string;
	/**
	 * Text a person typed (a prompt) rather than model output: single-dollar
	 * inline math stays literal, so SQL JSONPath expressions such as
	 * `$.field ... $.other` remain text (display math `$$...$$` still works),
	 * and HTML tags show as typed instead of being rendered.
	 */
	userText?: boolean;
	/**
	 * Force the codeLineNumbers pref on/off. When undefined, code blocks follow
	 * the GUI pref (hydrated from prefs IPC, flips live on Settings changes).
	 * SSR/tests pass this — the pref store's server snapshot is always off.
	 */
	codeLineNumbers?: boolean;
	/**
	 * Source still streaming (the live tail): fences stay plain code — no
	 * highlighting, no diagram or figure — until the block is complete, and
	 * the render skips the shared cache it would only churn.
	 */
	streaming?: boolean;
}

// Hoisted to module scope: stable plugin arrays and component maps keep
// ReactMarkdown from treating the pipeline as changed on every render.
// remark-math must precede rehype-katex: it parses $...$/$$...$$ into math
// nodes that rehype-katex (rehype chain below) then renders. The CJK passes
// bold `**0.1%**이며` and cut bare URLs at glued Korean text.
const REMARK_PLUGINS: Options["remarkPlugins"] = [
	remarkGfm,
	remarkMath,
	remarkLatexMath,
	remarkCjkStrong,
	remarkCjkAutolink,
];
const REMARK_PLUGINS_USER_TEXT: Options["remarkPlugins"] = [
	remarkGfm,
	[remarkMath, { singleDollarTextMath: false }],
	remarkLatexMath,
	remarkCjkStrong,
	remarkCjkAutolink,
	remarkHtmlAsText,
	remarkSoftBreaks,
];

type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

// Model output is untrusted: allow only a formatting-oriented HTML subset.
// No script/iframe/object/embed/form/input, no on* handlers, no style — every
// attribute not listed here is dropped. hast-util-sanitize shallow-merges over
// the GitHub default schema, so every field that must differ from the default
// is set explicitly.
const SANITIZE_SCHEMA: SanitizeSchema = {
	tagNames: [
		// Raw-HTML subset (also covers inline markdown output).
		"a",
		"abbr",
		"b",
		"blockquote",
		"br",
		"code",
		"del",
		"details",
		"em",
		"hr",
		"i",
		"ins",
		"kbd",
		"li",
		"mark",
		"ol",
		"p",
		"pre",
		"s",
		"small",
		"span",
		"strong",
		"sub",
		"summary",
		"sup",
		"u",
		"ul",
		// GFM footnotes: `<section data-footnotes class="footnotes">`.
		"section",
		// Markdown/GFM block structure that must survive sanitation.
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"img",
		// GFM task-list checkboxes. rehype-raw runs BEFORE sanitize, so a raw
		// `<input>` in model output also survives — the attribute value pin below
		// is what keeps `type="password"/"file"/"text"` from becoming interactive.
		"input",
		"table",
		"thead",
		"tbody",
		"tr",
		"th",
		"td",
		// A raw `<video src>`/`<audio src>` renders as the chat's own player
		// (MarkdownMedia): only `src` survives, so no autoplay, loop, poster
		// fetch or handler ever reaches the DOM.
		"video",
		"audio",
	],
	attributes: {
		// `id` everywhere it is allowed is clobber-prefixed below. Footnote refs
		// and backrefs carry their GFM markers, an aria label and the reference
		// to the (prefixed) footnote heading.
		a: [
			"href",
			"id",
			"ariaDescribedBy",
			"ariaLabel",
			"dataFootnoteRef",
			"dataFootnoteBackref",
			["className", "data-footnote-backref"],
		],
		abbr: ["title"],
		// `language-*` on code carries the fence's language tag for the Pre swap.
		// Value-checked: raw HTML must not smuggle arbitrary classes (compiled
		// Tailwind utilities like `fixed inset-0` would let model text overlay
		// the whole app). Spans get no className at all — nothing consumes one.
		// The other class pins below are the GFM markers, styled in components.css.
		code: [["className", /^language-[a-zA-Z0-9_-]+$/]],
		h1: ["id"],
		h2: ["id"],
		h3: ["id"],
		h4: ["id"],
		h5: ["id"],
		h6: ["id"],
		img: ["src", "alt", "title"],
		// Value-pinned: only type="checkbox" survives; any other type value is
		// dropped with the attribute. checked/disabled carry the GFM state.
		input: [["type", "checkbox"], "checked", "disabled"],
		li: ["id", ["className", "task-list-item"]],
		ol: ["start", ["className", "contains-task-list"]],
		section: ["dataFootnotes", ["className", "footnotes"]],
		td: ["align"],
		th: ["align"],
		ul: [["className", "contains-task-list"]],
		video: ["src"],
		audio: ["src"],
	},
	// Every id (and the aria references to one) gets this prefix, so model
	// output can never shadow an app element or a `window` global; in-page
	// links resolve it (MarkdownLink), as GitHub's do.
	clobber: ["id", "ariaDescribedBy", "ariaLabelledBy", "name"],
	clobberPrefix: MARKDOWN_ID_PREFIX,
	protocols: {
		// local: is the session's local:// store, resolved by stock through the bridge.
		href: ["http", "https", "mailto", "file", "local"],
		// data: keeps inline base64 images; file: is resolved to a workspace /
		// absolute read by the MarkdownImage component (protocol stripped).
		src: ["http", "https", "data", "file"],
	},
	// Unknown tags are replaced by their children; these hold code/resources,
	// not prose, so drop their contents too.
	strip: ["script", "style", "iframe", "object", "embed", "title", "textarea"],
};

// Order matters: rehype-raw parses embedded HTML into the tree, headings get
// their ids, rehype-sanitize then filters the whole tree against the strict
// schema (prefixing every id), alerts are marked on the safe tree, and katex
// runs last so its generated MathML is not sanitized away. Fenced code is NOT
// highlighted in this pipeline: the `pre` component swaps every fence for the
// shared CodeBlock (same lazy hljs path as the tool cards), which also owns the
// language badge, copy button, wrap toggle and line-number gutter — one code
// chrome across the whole GUI. Code `language-*` classes survive sanitize for
// that detection.
type RehypePlugin = NonNullable<Options["rehypePlugins"]>[number];

const SANITIZE_STEP: RehypePlugin = [rehypeSanitize, SANITIZE_SCHEMA];

// Footnote ids leave remark-rehype bare (`fn-1`, href `#fn-1`) so sanitize's
// clobber prefix is the only one, as on GitHub: `id="user-content-fn-1"`.
const REMARK_REHYPE_OPTIONS: Options["remarkRehypeOptions"] = { clobberPrefix: "" };

/**
 * Pipeline steps too heavy for startup (rehype-raw pulls parse5; KaTeX is
 * ~500 KB plus its stylesheet): fetched the first time some content looks like
 * it needs them. Until the chunk arrives that content renders without the step
 * — sanitize drops the raw HTML, math shows as its TeX source — and re-renders
 * once it lands. `hint` may over-match (a stray `$` just loads KaTeX early) but
 * must never under-match.
 */
interface LazyRehypeStep {
	hint: RegExp;
	load: () => Promise<RehypePlugin>;
	plugin?: RehypePlugin;
	pending?: Promise<RehypePlugin>;
}

const RAW_HTML_STEP: LazyRehypeStep = {
	hint: /<[A-Za-z!/?]/,
	load: () => import("rehype-raw").then(mod => mod.default),
};
// `$`/`$$` (remark-math), `\(`/`\[` (remarkLatexMath), ```math fences (rehype-katex).
const KATEX_STEP: LazyRehypeStep = {
	hint: /\$|\\[([]|(?:`{3,}|~{3,})[ \t]*math/,
	load: () => import("./markdown-katex").then(mod => mod.default),
};

function loadRehypeStep(step: LazyRehypeStep): Promise<RehypePlugin> {
	step.pending ??= step.load().then(
		plugin => {
			step.plugin = plugin;
			return plugin;
		},
		(error: unknown) => {
			step.pending = undefined; // let the next renderer that needs it retry
			throw error;
		},
	);
	return step.pending;
}

/** The step's plugin once loaded; starts the load when `content` needs it. */
function useLazyRehypeStep(step: LazyRehypeStep, content: string): RehypePlugin | undefined {
	const needed = step.plugin === undefined && step.hint.test(content);
	const [, setLoaded] = useState(false);
	useEffect(() => {
		if (!needed) return;
		let live = true;
		loadRehypeStep(step).then(
			() => live && setLoaded(true),
			// A failed chunk load keeps the readable fallback (TeX source / no HTML).
			() => {},
		);
		return () => {
			live = false;
		};
	}, [needed, step]);
	return step.plugin;
}

/** Load every lazy pipeline step now — for callers that render synchronously (SSR/tests). */
export function preloadMarkdownPipeline(): Promise<unknown> {
	return Promise.all([loadRehypeStep(RAW_HTML_STEP), loadRehypeStep(KATEX_STEP)]);
}

// react-markdown's defaultUrlTransform blanks data:/file: URLs even when the
// sanitize schema allows them. Images need both (inline base64, local files
// resolved via IPC), so let image-bearing protocols through for <img src> and
// defer to the default everywhere else.
const URL_TRANSFORM: NonNullable<Options["urlTransform"]> = (url, key, node) => {
	const tag = node?.tagName;
	if (key === "src" && tag === "img" && /^(data|blob|file):/i.test(url)) return url;
	if (key === "src" && (tag === "video" || tag === "audio") && /^file:/i.test(url)) return url;
	if (key === "href" && tag === "a" && /^(file|local):/i.test(url)) return url;
	return defaultUrlTransform(url);
};

/**
 * The element an in-page `#fragment` names: the prefixed id (sanitize's
 * clobber prefix), looked up in the same message first, then the turn, then
 * the session pane — every reply numbers its own footnotes from 1.
 */
function fragmentTarget(from: Element, fragment: string): HTMLElement | null {
	let id = fragment;
	try {
		id = decodeURIComponent(fragment);
	} catch {
		// A stray `%` stays literal.
	}
	if (!id) return null;
	const prefixed = id.startsWith(MARKDOWN_ID_PREFIX) ? id : `${MARKDOWN_ID_PREFIX}${id}`;
	const selector = `[id="${prefixed.replace(/["\\]/g, "\\$&")}"]`;
	for (const scope of [
		from.closest(".markdown-body"),
		from.closest(".omp-assistant-turn"),
		from.closest(".omp-session-pane"),
		from.ownerDocument,
	]) {
		const target = scope?.querySelector<HTMLElement>(selector);
		if (target) return target;
	}
	return null;
}

function scrollToFragment(from: Element, fragment: string): void {
	const target = fragmentTarget(from, fragment);
	if (!target) return;
	const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
	target.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
	// Keyboard and screen-reader users land where the eye does.
	if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
	target.focus({ preventScroll: true });
}

/**
 * Every markdown link: `#fragment` scrolls within the transcript, `local://`
 * opens the session file stock resolves, a file path opens the preview, and
 * web and mail links go to the system (main admits only http(s) and mailto).
 */
function MarkdownLink({ href, children, node: _node, ...props }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
	const t = useT();
	const rpc = useTabRpc();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const linkMenu = useLinkMenu(tabId);
	const mentionedPath = (props as Record<string, unknown>)["data-path"];
	if (typeof mentionedPath === "string" && !href)
		return (
			<PathMentionLink
				className="text-[var(--omp-md-link)] underline decoration-[var(--omp-md-link-url)] hover:decoration-[var(--omp-md-link)]"
				line={Number((props as Record<string, unknown>)["data-line"]) || undefined}
				path={mentionedPath}
			>
				{children}
			</PathMentionLink>
		);
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (!href) return;
		event.preventDefault();
		if (href.startsWith("#")) {
			scrollToFragment(event.currentTarget, href.slice(1));
			return;
		}
		if (/^local:/i.test(href)) {
			const failed = (error: unknown) => toastError({ title: t("markdown.localLinkFailed", { url: href }), error });
			rpc.resolveLocalUrl(href).then(response => {
				const path = response.success ? (response.data as { path?: unknown } | undefined)?.path : undefined;
				if (typeof path === "string") useUiStore.getState().openFilePreview(path);
				else failed(new Error(response.success ? "no path" : response.error));
			}, failed);
			return;
		}
		const filePath = localFilePath(href);
		if (filePath) {
			const location = pathLocation(filePath, href);
			void openLocalPath(location.path, tabId, location.line);
			return;
		}
		// Settings › General › "Open links in Preview": a web link reuses the side
		// panel's Preview (the next link replaces the page); ⌘/Ctrl-click still
		// goes to the browser.
		const ui = useUiStore.getState();
		if (ui.linkPreview && /^https?:\/\//i.test(href) && !event.metaKey && !event.ctrlKey) ui.openPreview(href);
		else openExternal(href);
	};
	// Web, mail and local-file links get the link menu; `#fragment` and `local://` keep none.
	const onContextMenu = (event: MouseEvent<HTMLAnchorElement>) => {
		if (!href || href.startsWith("#") || /^local:/i.test(href)) return;
		const filePath = localFilePath(href);
		if (!filePath) {
			linkMenu.onContextMenu(event, { kind: "web", url: href });
			return;
		}
		const location = pathLocation(filePath, href);
		linkMenu.onContextMenu(
			event,
			verifyPath(location.path, tabId).then(kind =>
				kind === "missing" ? null : { kind: "path", ...location, dir: kind === "dir" },
			),
		);
	};
	return (
		<>
			<a
				{...props}
				href={href}
				onClick={onClick}
				onContextMenu={onContextMenu}
				className="text-[var(--omp-md-link)] underline decoration-[var(--omp-md-link-url)] hover:decoration-[var(--omp-md-link)]"
			>
				{children}
			</a>
			{linkMenu.menu}
		</>
	);
}

function StyledTable({ children, ...props }: ComponentPropsWithoutRef<"table">) {
	return (
		<div className="overflow-x-auto my-2">
			<table {...props} className="w-full border-collapse text-sm">
				{children}
			</table>
		</div>
	);
}

// ── codeLineNumbers pref (GUI prefs file, NOT zustand) ─────────────────────
// Module snapshot hydrated lazily from window.omp.prefs when the first code
// block mounts; Settings writes go through setCodeLineNumbersPref, which
// flips every mounted block live without re-parsing markdown. SSR never runs
// subscriptions, so tests drive rendering via the MarkdownRenderer
// `codeLineNumbers` prop (the server snapshot below is always off).
let codeLineNumbersSnapshot = false;
let codeLineNumbersHydrated = false;
let codeLineNumbersVersion = 0;
const codeLineNumbersListeners = new Set<() => void>();

function setCodeLineNumbersSnapshot(next: boolean): void {
	if (codeLineNumbersSnapshot === next) return;
	codeLineNumbersSnapshot = next;
	for (const listener of codeLineNumbersListeners) listener();
}

function subscribeCodeLineNumbers(listener: () => void): () => void {
	codeLineNumbersListeners.add(listener);
	if (!codeLineNumbersHydrated) {
		codeLineNumbersHydrated = true;
		const version = codeLineNumbersVersion;
		try {
			void window.omp.prefs
				.get("codeLineNumbers")
				.then(value => {
					if (version === codeLineNumbersVersion) setCodeLineNumbersSnapshot(value === true);
				})
				.catch(() => {});
		} catch {
			// prefs IPC unavailable (tests, storybook) — default off.
		}
	}
	return () => {
		codeLineNumbersListeners.delete(listener);
	};
}

/** Settings GUI-tab write path: flip every mounted code block live + persist. */
export async function setCodeLineNumbersPref(next: boolean): Promise<boolean> {
	return saveGuiPreference("codeLineNumbers", next, () => {
		codeLineNumbersVersion++;
		codeLineNumbersHydrated = true;
		setCodeLineNumbersSnapshot(next);
	});
}

/** MarkdownRenderer prop → Pre, threading around the static components map. */
const CodeLineNumbersOverride = createContext<boolean | undefined>(undefined);

/** The MarkdownRenderer `streaming` prop → Pre: fences stay plain until complete. */
const MarkdownStreaming = createContext(false);

function useCodeLineNumbers(): boolean {
	const override = useContext(CodeLineNumbersOverride);
	const pref = useSyncExternalStore(
		subscribeCodeLineNumbers,
		() => codeLineNumbersSnapshot,
		() => false,
	);
	return override ?? pref;
}

const MERMAID_CLASS = /(?:^|\s)language-mermaid(?:\s|$)/;

/** Plain-text content of a rendered node (fences reach Pre unhighlighted). */
function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}

function CodeBlock({
	className,
	children,
	node: _node,
	...props
}: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
	// Fenced (className-carrying) code reaches here only as Pre's child — Pre
	// swaps the wrapper for the shared CodeBlock chrome and reads the language
	// off this className, so keep it intact and unstyled.
	if (className) {
		return (
			<code {...props} className={className}>
				{children}
			</code>
		);
	}
	return (
		<code
			{...props}
			className="px-1 py-0.5 rounded bg-[var(--omp-code-bg)] text-[var(--omp-md-code)] font-mono text-[0.9em]"
		>
			{children}
		</code>
	);
}

function H1({ children, ...props }: ComponentPropsWithoutRef<"h1">) {
	return (
		<h1 {...props} className="text-xl font-bold mt-4 mb-2 text-[var(--omp-md-heading)]">
			{children}
		</h1>
	);
}

function H2({ children, ...props }: ComponentPropsWithoutRef<"h2">) {
	return (
		<h2 {...props} className="text-lg font-bold mt-3 mb-2 text-[var(--omp-md-heading)]">
			{children}
		</h2>
	);
}

function H3({ children, ...props }: ComponentPropsWithoutRef<"h3">) {
	return (
		<h3 {...props} className="text-base font-semibold mt-3 mb-1 text-[var(--omp-md-heading)]">
			{children}
		</h3>
	);
}

const ALERT_ICONS: Record<MarkdownAlertKind, LucideIcon> = {
	note: Info,
	tip: Lightbulb,
	important: MessageSquareWarning,
	warning: TriangleAlert,
	caution: OctagonAlert,
};

/**
 * A quote, or a GitHub alert (`> [!NOTE]`, marked by rehypeAlerts): the
 * state color sits only on its rule and label; the body reads as prose.
 */
function Blockquote({ children, node: _node, ...props }: ComponentPropsWithoutRef<"blockquote"> & { node?: unknown }) {
	const t = useT();
	const alert = (props as Record<string, unknown>)["data-alert"];
	if (isMarkdownAlertKind(alert)) {
		const Icon = ALERT_ICONS[alert];
		return (
			<blockquote {...props} className="omp-md-alert">
				<p className="omp-md-alert-title" data-alert-title>
					<Icon aria-hidden className="size-[1.05em] shrink-0" />
					{t(`markdown.alert.${alert}`)}
				</p>
				{children}
			</blockquote>
		);
	}
	return (
		<blockquote {...props} className="border-l-2 border-[var(--omp-md-quote-border)] pl-3 text-[var(--omp-md-quote)]">
			{children}
		</blockquote>
	);
}

function Hr(props: ComponentPropsWithoutRef<"hr">) {
	return <hr {...props} className="border-[var(--omp-md-hr)] my-4" />;
}

function Li({ children, className, node: _node, ...props }: ComponentPropsWithoutRef<"li"> & { node?: unknown }) {
	// `task-list-item` (GFM, sanitize-pinned) trades the bullet for its checkbox in components.css.
	return (
		<li {...props} className={cx("ml-4 [&::marker]:text-[var(--omp-md-list-bullet)]", className)}>
			{children}
		</li>
	);
}

/** A ```mermaid fence: the diagram (zoomable), with its source one switch away. */
function MermaidFence({ code, showLineNumbers }: { code: string; showLineNumbers: boolean }) {
	return (
		<MermaidBlock
			className="my-2"
			code={code}
			maxHeightClass={PREVIEW_SCROLL_CODE}
			showLineNumbers={showLineNumbers}
		/>
	);
}

const FENCE_LANGUAGE_RE = /(?:^|\s)language-(\S+)/;

function Pre({ children }: ComponentPropsWithoutRef<"pre">) {
	const showLineNumbers = useCodeLineNumbers();
	const streaming = useContext(MarkdownStreaming);
	// Every fence renders through the shared CodeBlock: same language badge,
	// copy button, gutter, and lazy highlighting as the tool cards. The fence's
	// trailing newline never paints a visible line — strip it.
	const codeClass =
		isValidElement<{ className?: unknown }>(children) && typeof children.props.className === "string"
			? children.props.className
			: "";
	const language = FENCE_LANGUAGE_RE.exec(codeClass)?.[1] ?? "plaintext";
	const code = textOf(children).replace(/\n$/, "");
	if (!streaming) {
		// A mermaid fence draws its diagram with its own chrome, not boxed like code.
		if (MERMAID_CLASS.test(codeClass)) return <MermaidFence code={code} showLineNumbers={showLineNumbers} />;
		// ```svg (any case, as stock's TUI matches it) draws the figure; source
		// that does not parse yet stays code until it does.
		if (language.toLowerCase() === "svg") {
			return (
				<SvgBlock
					code={code}
					showLineNumbers={showLineNumbers}
					maxHeightClass={PREVIEW_SCROLL_CODE}
					className="my-2"
				/>
			);
		}
	}
	return (
		<SharedCodeBlock
			code={code}
			language={language}
			showLineNumbers={showLineNumbers}
			maxHeightClass={PREVIEW_SCROLL_CODE}
			className="my-2"
			// An unlabeled fence is plain text, as in stock's TUI: no hljs guess.
			guessLanguage={false}
			highlight={!streaming}
			showWrap
			showRun={!streaming}
		/>
	);
}

function TaskCheckbox(props: ComponentPropsWithoutRef<"input">) {
	// The checkbox state comes from model output — there is nowhere a click
	// could be stored. Force the readonly form regardless of what the input
	// carried (second layer on top of the sanitize value pin).
	return <input {...props} type="checkbox" disabled readOnly tabIndex={-1} />;
}

// ── Markdown images ─────────────────────────────────────────────────────────
// Model output references images three ways: remote URLs, inline data: URLs,
// and local paths (screenshots, generated images) that the browser cannot
// resolve from the bundle origin. Local paths go through the fs:read-image IPC
// (sniffed mime + size cap) and come back as data URLs. Remote URLs are never
// fetched automatically: an `<img>` is a silent outbound request that leaks the
// viewer's IP and reading to whoever the model named, and CSP blocks it anyway,
// so they render as an explicit link the user chooses to open.

export type MarkdownImageSrc =
	| { kind: "direct"; src: string }
	| { kind: "remote"; src: string }
	| { kind: "local"; path: string }
	| { kind: "none" };

/** Classifies an <img> src after sanitize: inline image, remote URL, local path, or unusable. */
export function classifyImageSrc(src: string | undefined): MarkdownImageSrc {
	if (!src) return { kind: "none" };
	if (src.startsWith("data:") || src.startsWith("blob:")) return { kind: "direct", src };
	if (/^https?:\/\//i.test(src)) return { kind: "remote", src };
	if (src.startsWith("//")) return { kind: "remote", src: `https:${src}` };
	if (/^file:\/\//i.test(src)) return { kind: "local", path: fileUrlPath(src) };
	// Bare paths — absolute (/…, ~\…, C:\…), relative (./…, ../…), or plain
	// filenames — all resolve through the workspace/absolute read.
	return { kind: "local", path: src };
}

const MARKDOWN_IMAGE_CLASS = `my-1 ${PREVIEW_HEIGHT_LG} max-w-full rounded-md border border-[var(--omp-border-muted)] object-contain`;

function MarkdownImageFallback({ alt, path }: { alt: string; path?: string }) {
	return (
		<span
			title={path}
			className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--omp-border-muted)] px-2 py-1 text-omp-md text-[var(--omp-dim)]"
		>
			<span className="truncate">{alt || path || "image"}</span>
			{alt && path && <span className="shrink-0 truncate font-mono text-omp-xs opacity-70">{path}</span>}
		</span>
	);
}

/**
 * A remote image or media file is never fetched: the request would leak this
 * viewer's IP and reading to the host the model named. The source stays one
 * explicit click away.
 */
function RemoteMarkdownImage({ src, alt, media }: { src: string; alt: string; media?: boolean }) {
	const t = useT();
	return (
		<span
			title={src}
			className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--omp-border-muted)] px-2 py-1 text-omp-md text-[var(--omp-dim)]"
		>
			<ImageOff size={13} className="shrink-0" aria-hidden />
			<span className="truncate">{alt || t(media ? "markdown.remoteMedia" : "markdown.remoteImage")}</span>
			<a
				href={src}
				onClick={event => {
					event.preventDefault();
					openExternal(src);
				}}
				className="shrink-0 truncate font-mono text-omp-xs text-[var(--omp-md-link)] underline decoration-[var(--omp-md-link-url)] hover:decoration-[var(--omp-md-link)]"
			>
				{t("markdown.remoteImageOpen")}
			</a>
		</span>
	);
}

function LocalMarkdownImage({ path, alt, title }: { path: string; alt: string; title?: string }) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const [resolved, setResolved] = useState<{ url: string } | { error: true } | null>(null);
	useEffect(() => {
		let cancelled = false;
		window.omp.fs
			.readImage(path, tabId ?? undefined)
			.then(result => {
				if (!cancelled) setResolved(result.ok && result.dataUrl ? { url: result.dataUrl } : { error: true });
			})
			.catch(() => {
				if (!cancelled) setResolved({ error: true });
			});
		return () => {
			cancelled = true;
		};
	}, [path, tabId]);
	if (!resolved) return <MarkdownImageFallback alt={alt} path={path} />;
	if ("error" in resolved) {
		return (
			<span title={t("markdown.imageFailed")}>
				<MarkdownImageFallback alt={alt} path={path} />
			</span>
		);
	}
	return <ZoomableImage src={resolved.url} alt={alt} title={title ?? alt} className={MARKDOWN_IMAGE_CLASS} />;
}

function MarkdownImage({ src, alt, title, ...props }: ComponentPropsWithoutRef<"img">) {
	const classified = classifyImageSrc(typeof src === "string" ? src : undefined);
	const altText = typeof alt === "string" ? alt : "";
	if (classified.kind === "none") return <MarkdownImageFallback alt={altText} />;
	if (classified.kind === "local") {
		// `![demo](out/demo.mp4)` asks for the file in place: a player, or a
		// document's chip — never an image read that can only fail.
		const media = chatMediaKind(classified.path);
		if (media) return <ChatMedia kind={media} label={altText || undefined} path={classified.path} />;
		const fileKind = chatReferenceKind(classified.path);
		if (fileKind && fileKind !== "image") return <FileCard label={altText || undefined} path={classified.path} />;
		return (
			<LocalMarkdownImage
				path={classified.path}
				alt={altText}
				title={typeof title === "string" ? title : undefined}
			/>
		);
	}
	if (classified.kind === "remote") return <RemoteMarkdownImage src={classified.src} alt={altText} />;
	return (
		<ZoomableImage {...props} src={classified.src} alt={altText} title={title} className={MARKDOWN_IMAGE_CLASS} />
	);
}

/**
 * Raw `<video src>`/`<audio src>` in model output (only `src` survives
 * sanitize): a local file plays in the chat's own player; a remote one stays a
 * link; inline data has no safe player (CSP `media-src` takes blobs only).
 */
function MarkdownMedia({ src, kind }: { src: unknown; kind: "video" | "audio" }) {
	const classified = classifyImageSrc(typeof src === "string" ? src : undefined);
	if (classified.kind === "local") return <ChatMedia kind={kind} path={classified.path} />;
	if (classified.kind === "remote") return <RemoteMarkdownImage media src={classified.src} alt="" />;
	return null;
}

const COMPONENTS: Components = {
	a: MarkdownLink,
	table: StyledTable,
	code: CodeBlock,
	h1: H1,
	h2: H2,
	h3: H3,
	blockquote: Blockquote,
	hr: Hr,
	li: Li,
	pre: Pre,
	input: TaskCheckbox,
	img: MarkdownImage,
	video: ({ src }) => <MarkdownMedia kind="video" src={src} />,
	audio: ({ src }) => <MarkdownMedia kind="audio" src={src} />,
};

/**
 * Rendered markdown by pipeline and source, most recent last. A history page
 * mounts its replies in the commit that shows it; `prewarmMarkdown` renders the
 * ones that commit will need in an earlier, idle task, so the commit reuses them.
 */
const rendered = new Map<string, ReactElement>();
const RENDERED_LIMIT = 64;

function buildMarkdown(
	content: string,
	userText: boolean,
	rawHtml: RehypePlugin | undefined,
	katex: RehypePlugin | undefined,
): ReactElement {
	// react-markdown's component is a plain function of its props: calling it keeps the
	// element tree it returns, which every later mount of the same source reuses.
	return ReactMarkdown({
		children: content,
		remarkPlugins: userText ? REMARK_PLUGINS_USER_TEXT : REMARK_PLUGINS,
		remarkRehypeOptions: REMARK_REHYPE_OPTIONS,
		rehypePlugins: [
			...(rawHtml ? [rawHtml] : []),
			rehypeHeadingIds,
			SANITIZE_STEP,
			rehypeAlerts,
			rehypeLocalPaths,
			...(katex ? [katex] : []),
		],
		components: COMPONENTS,
		urlTransform: URL_TRANSFORM,
	});
}

function renderMarkdown(
	content: string,
	userText: boolean,
	rawHtml: RehypePlugin | undefined,
	katex: RehypePlugin | undefined,
): ReactElement {
	const key = `${userText ? "u" : "-"}${rawHtml ? "h" : "-"}${katex ? "k" : "-"}${content}`;
	const cached = rendered.get(key);
	if (cached) {
		rendered.delete(key);
		rendered.set(key, cached);
		return cached;
	}
	const element = buildMarkdown(content, userText, rawHtml, katex);
	rendered.set(key, element);
	if (rendered.size > RENDERED_LIMIT) rendered.delete(rendered.keys().next().value ?? "");
	return element;
}

/** Render `content` now, with the pipeline steps loaded so far, for a `MarkdownRenderer` about to mount. */
export function prewarmMarkdown(content: string): void {
	renderMarkdown(content, false, RAW_HTML_STEP.plugin, KATEX_STEP.plugin);
}

/**
 * Renders markdown content with GFM, a sanitized raw-HTML subset, KaTeX math,
 * and syntax highlighting. Memoized: re-parses only when `content` changes
 * (or a lazy pipeline step it needs finishes loading).
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
	content,
	codeLineNumbers,
	userText = false,
	streaming = false,
}: MarkdownRendererProps) {
	// A prompt's tags are shown as typed: the raw-HTML parser never loads for it.
	const rawHtml = useLazyRehypeStep(RAW_HTML_STEP, userText ? "" : content);
	const katex = useLazyRehypeStep(KATEX_STEP, content);
	// A streaming tail changes every frame: its renders would only evict the
	// cached history replies, so it builds outside the cache.
	const element = useMemo(
		() => (streaming ? buildMarkdown : renderMarkdown)(content, userText, userText ? undefined : rawHtml, katex),
		[content, userText, rawHtml, katex, streaming],
	);
	return (
		<div className="markdown-body text-[1em] leading-[1.5]">
			<MarkdownStreaming.Provider value={streaming}>
				<CodeLineNumbersOverride.Provider value={codeLineNumbers}>{element}</CodeLineNumbersOverride.Provider>
			</MarkdownStreaming.Provider>
		</div>
	);
});
