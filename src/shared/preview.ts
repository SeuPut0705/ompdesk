export const PREVIEW_COMMAND = "preview:command";
export const PREVIEW_SAVE_PDF = "preview:save-pdf";
export const PREVIEW_STATE = "preview:state";
/** Renderer → main: one page interaction on the shown preview page (element picker, pins, tweaks). */
export const PREVIEW_PAGE = "preview:page";
/** Renderer → main: every visual the agent showed, newest first (C141 "All visuals"). */
export const PREVIEW_VISUALS = "preview:visuals";
/** Main → renderer: the agent showed (or updated) a visual for a tab (`PreviewVisualEvent`). */
export const PREVIEW_VISUAL = "preview:visual";
/**
 * Web viewers only (a paired phone or tablet): its page is an offscreen page on this computer streamed as JPEG
 * frames over the socket (main/web/preview-stream.ts). `POLL` acknowledges the last frame and holds until the
 * next one (the pacer sends none before the ack); the rest carry the viewer's input, a JS dialog's answer, the
 * page's selected text and its PDF. An Electron window never calls them.
 */
export const PREVIEW_STREAM_POLL = "preview:stream-poll";
export const PREVIEW_STREAM_INPUT = "preview:stream-input";
export const PREVIEW_STREAM_DIALOG = "preview:stream-dialog";
export const PREVIEW_STREAM_COPY = "preview:stream-copy";
export const PREVIEW_STREAM_PDF = "preview:stream-pdf";
/** Pages the agent's `gui_visualize` tool shows load from this scheme (main/preview/visuals.ts). */
export const VISUAL_SCHEME = "omp-visual";

export interface PreviewBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
/** The agent driving the preview through stock's browser relay (main/preview/agent-relay.ts). */
export interface PreviewAgentState {
	/** Tab whose agent was let in. */
	tabId: string;
	/** The agent holds the page's debugger right now (between its browser calls it may not). */
	attached: boolean;
	/** Last CDP method the agent sent, e.g. `Page.navigate`; "" before the first. */
	lastAction: string;
}
/** A console error or warning the page logged (C144), newest last. */
export interface PreviewProblem {
	level: "error" | "warning";
	message: string;
	/** Script URL and line, "" when the page gave none. */
	source: string;
	line: number;
}
/** Something the page asked for that the preview does not do itself. */
export type PreviewNotice =
	/** A download the isolated preview refused; the system browser can fetch it. */
	| { kind: "download"; url: string; filename: string }
	/**
	 * A visual's page tried to leave for `url` (a link, `location`, a popup) right after the user's own click or
	 * key on it. Visuals never leave by themselves; the user may open the full address in a new web tab.
	 */
	| { kind: "link"; url: string }
	/** The page has stopped responding to input. */
	| { kind: "unresponsive" };
/** Responsive frame sizes (CSS px); `fill` uses the whole panel. */
export const PREVIEW_VIEWPORTS = {
	fill: null,
	phone: { width: 390, height: 844 },
	tablet: { width: 768, height: 1024 },
	laptop: { width: 1366, height: 768 },
} as const;
export type PreviewViewport = keyof typeof PREVIEW_VIEWPORTS;
export const PREVIEW_ZOOM_MIN = 0.5;
export const PREVIEW_ZOOM_MAX = 2;
/** Clamp to the zoom range on 10 % steps, so repeated steps never drift. */
export function clampPreviewZoom(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.round(Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, value)) * 10) / 10;
}
/** One page of the preview's tab strip (C119). */
export interface PreviewTab {
	id: string;
	title: string;
	url: string;
	loading: boolean;
	/** The agent's visual this tab shows (`gui_visualize`), if any. */
	visual?: string;
}
/** Tabs one window's preview may hold; a page's popups beyond it are dropped. */
export const PREVIEW_TAB_LIMIT = 10;
/** The shown tab's page, plus the strip (`tabs`, `activeTab`; empty before the first page exists). */
export interface PreviewState {
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	error: string | null;
	/** The page's renderer died; a reload restores it. */
	crashed: boolean;
	agent: PreviewAgentState | null;
	/** The user's zoom (1 = 100 %), on top of the scale a viewport frame needs to fit. */
	zoom: number;
	viewport: PreviewViewport;
	/** Console errors and warnings since the last full navigation (at most `PREVIEW_PROBLEM_LIMIT`). */
	problems: PreviewProblem[];
	notice: PreviewNotice | null;
	/** The visual this page shows, with its versions (C135/C141). */
	visual: PreviewVisualView | null;
	/**
	 * `visual`: the page lives in the window's visual session (only `omp-visual:` documents, no network, never the
	 * agent's browser); `web`: every other page.
	 */
	session: "web" | "visual";
	tabs: PreviewTab[];
	activeTab: string;
}
/** What one tab's page reports; the strip fields come from the window. */
export type PreviewPageState = Omit<PreviewState, "tabs" | "activeTab">;
export const PREVIEW_PROBLEM_LIMIT = 50;
/** The count a panel shows for `count` kept problems: at the cap older ones were dropped, so it reads "50+". */
export function previewProblemCount(count: number): string {
	return count >= PREVIEW_PROBLEM_LIMIT ? `${count}+` : String(count);
}
export const EMPTY_PREVIEW_PAGE: PreviewPageState = {
	url: "",
	title: "",
	loading: false,
	canGoBack: false,
	canGoForward: false,
	error: null,
	crashed: false,
	agent: null,
	zoom: 1,
	viewport: "fill",
	problems: [],
	notice: null,
	visual: null,
	session: "web",
};
export const EMPTY_PREVIEW: PreviewState = { ...EMPTY_PREVIEW_PAGE, tabs: [], activeTab: "" };
export type PreviewRequest =
	/** `dpr`: a web viewer's device pixel ratio (its frames are capped at 2); an Electron window never sends it. */
	| { action: "layout"; bounds: PreviewBounds; visible: boolean; dpr?: number }
	| { action: "load"; url: string }
	/** Let `tabId`'s agent drive the page through the relay its bridge started (`browser_relay_start`). */
	| { action: "agentStart"; tabId: string; url: string; token: string }
	/** Take the page back: the agent's connection closes and its debugger detaches. */
	| { action: "agentStop" }
	| { action: "zoom"; zoom: number }
	| { action: "viewport"; viewport: PreviewViewport }
	/** Open a tab (an empty one without `url`) and show it. */
	| { action: "newTab"; url?: string }
	/** Show or close one tab; closing the last one leaves a fresh empty tab. Either releases an agent on another page. */
	| { action: "selectTab" | "closeTab"; id: string }
	| { action: "clearProblems" | "dismissNotice" }
	/** Show `visualId` (one of `tabId`'s visuals) in its tab, opening one when none shows it; `version` default latest. */
	| { action: "showVisual"; tabId: string; visualId: string; version?: number }
	/** After a tab switch: open `tabId`'s visuals as tabs, showing the first when `show`. */
	| { action: "restoreVisuals"; tabId: string; show: boolean }
	/** Add a visual from "All visuals" to `tabId` and show it. */
	| { action: "openVisual"; tabId: string; visualId: string }
	| { action: "back" | "forward" | "reload" | "stop" | "dispose" };
export interface PreviewApi {
	command(request: PreviewRequest): Promise<PreviewState>;
	/** Ask where to save, then print the page to that PDF: the saved path, or `null` when the user cancelled. */
	savePdf(): Promise<string | null>;
	onState(callback: (state: PreviewState) => void): () => void;
	/** One interaction with the shown page (element picker, region, pins, CSS variables). */
	page<R extends PreviewPageRequest>(request: R): Promise<PreviewPageResults[R["action"]]>;
	/** "All visuals" (C141), newest first. */
	visuals(): Promise<PreviewVisualRecord[]>;
	/** The agent showed or updated a visual for a tab. */
	onVisual(callback: (event: PreviewVisualEvent) => void): () => void;
	/** A web viewer's streamed page (see `PREVIEW_STREAM_POLL`); a desktop window's calls are refused. */
	stream: PreviewStreamApi;
}

/** One JPEG frame of the viewer's offscreen page. */
export interface PreviewStreamFrame {
	/** Counts up from 1 for this page stream; the next poll's `ack` names it. */
	seq: number;
	/** The tab (`PreviewTab.id`) the frame shows: a frame of another tab is stale after a switch. */
	tab: string;
	/** The image's pixels. */
	width: number;
	height: number;
	/** Where the frame sits in the viewer's surface, in CSS px (a phone-sized frame is centred in a wide panel). */
	rect: PreviewBounds;
	/** JPEG, base64. */
	jpeg: string;
}

/** A JS dialog the page opened and is blocked on until `PREVIEW_STREAM_DIALOG` answers it. */
export interface PreviewStreamDialog {
	id: number;
	kind: "alert" | "confirm" | "prompt";
	message: string;
	/** A prompt's default text. */
	initial: string | null;
}

export interface PreviewStreamPollRequest {
	/** The last frame this viewer decoded; no frame follows before it. null after a reconnect or on the first poll. */
	ack: number | null;
	/** Longest hold in ms, default and cap 20 000: a still page answers `frame: null` and the viewer polls again. */
	wait?: number;
}

export interface PreviewStreamPoll {
	frame: PreviewStreamFrame | null;
	/** Dialogs opened since the last poll, oldest first. */
	dialogs: PreviewStreamDialog[];
}

/**
 * One phone gesture or key, already read by the viewer. `x`/`y` are fractions (0–1) of the frame, so no scale
 * crosses the wire; `dx`/`dy` are CSS px with the DOM's wheel sign (positive scrolls the content up).
 */
export type PreviewStreamInput =
	| { t: "tap"; x: number; y: number; count?: 1 | 2 | 3 }
	/** A long press without movement: the page's context menu. */
	| { t: "context"; x: number; y: number }
	/** A press, drag and release with the left button (text selection, sliders, drag and drop). */
	| { t: "drag"; phase: "start" | "move" | "end"; x: number; y: number }
	| { t: "hover"; x: number; y: number }
	| { t: "wheel"; x: number; y: number; dx: number; dy: number }
	/** A pinch's size change since the last event: the page's zoom is multiplied by it. */
	| { t: "pinch"; scale: number }
	/** A key press (down, char, up): a special key, a shortcut, or a hardware keyboard's key. */
	| { t: "key"; key: string; mods?: Array<"shift" | "control" | "alt" | "meta"> }
	/** Text the viewer committed (soft keyboard, IME composition result, paste): inserted at the caret. */
	| { t: "text"; text: string };

export interface PreviewStreamApi {
	poll(request: PreviewStreamPollRequest): Promise<PreviewStreamPoll>;
	/** Fire and forget; order is kept. */
	input(events: PreviewStreamInput[]): void;
	answerDialog(id: number, answer: { accept: boolean; text?: string }): Promise<void>;
	/** The page's selected text (for the viewer's own clipboard). */
	selectedText(): Promise<string>;
	/** The page printed to PDF as base64, for the viewer to keep. */
	pdf(): Promise<{ name: string; base64: string }>;
}

export interface PreviewVisualVersion {
	version: number;
	/** Epoch ms. */
	createdAt: number;
}
/** A visual as one page shows it. */
export interface PreviewVisualView {
	id: string;
	label: string;
	/** The version this page shows. */
	version: number;
	/** Oldest first; a web address visual has none (it always shows the live page). */
	versions: PreviewVisualVersion[];
}
/** "All visuals" (C141): every visual the agent showed on this computer, kept across launches. */
export interface PreviewVisualRecord {
	id: string;
	label: string;
	kind: "file" | "inline" | "url";
	/** The file path or web address it shows ("" for inline content). */
	target: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	versions: number;
}
export interface PreviewVisualEvent {
	tabId: string;
	visualId: string;
}
/** An element on the shown page, as the picker reports it. */
export interface PreviewElement {
	selector: string;
	tag: string;
	/** The element's text, collapsed and cut to 120 characters. */
	text: string;
}
export interface PreviewCssVariable {
	name: string;
	value: string;
}
export type PreviewPageRequest =
	/** Wait for the user to click an element (Escape cancels → null). */
	| { action: "pick" }
	/** Drag a rectangle; its screenshot (PNG base64) and the elements under it (Escape cancels → null). */
	| { action: "region" }
	| { action: "cancel" }
	| { action: "parent"; selector: string }
	/** Numbered markers over these elements (an empty list removes them). */
	| { action: "pins"; pins: Array<{ n: number; selector: string }> }
	| { action: "highlight"; selector: string }
	/** The page's CSS custom properties on :root. */
	| { action: "tweaks" }
	| { action: "setVariable"; name: string; value: string }
	| { action: "clearVariables" };
export interface PreviewPageResults {
	pick: PreviewElement | null;
	region: { image: string; elements: PreviewElement[] } | null;
	cancel: null;
	parent: PreviewElement | null;
	pins: null;
	highlight: null;
	tweaks: PreviewCssVariable[];
	setVariable: null;
	clearVariables: null;
}
export function previewUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
			? url.href
			: null;
	} catch {
		return null;
	}
}
/** Address-bar text → URL: a scheme passes through `previewUrl`, a host (`localhost:3000`, `example.com/a`, an IPv4)
 * gets http:// on loopback and https:// elsewhere, anything else becomes a web search. `null` = refused scheme. */
export function previewAddress(input: string): string | null {
	const text = input.trim();
	if (!text) return null;
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return previewUrl(text);
	const host = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[::1\]|[\w-]+(\.[\w-]+)*\.[a-z]{2,})(:\d+)?([/?#]\S*)?$/i.exec(
		text,
	);
	if (host) {
		const loopback = ["localhost", "[::1]"].includes(host[1].toLowerCase()) || host[1].startsWith("127.");
		return previewUrl(`${loopback ? "http" : "https"}://${text}`);
	}
	return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
export function isLoopbackUrl(value: string): boolean {
	try {
		return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
	} catch {
		return false;
	}
}
export function reducePreviewState(state: PreviewState, patch: Partial<PreviewState>): PreviewState {
	return { ...state, ...patch };
}
