export const PREVIEW_COMMAND = "preview:command";
export const PREVIEW_SAVE_PDF = "preview:save-pdf";
export const PREVIEW_STATE = "preview:state";

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
}
export const PREVIEW_PROBLEM_LIMIT = 50;
export const EMPTY_PREVIEW: PreviewState = {
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
};
export type PreviewRequest =
	| { action: "layout"; bounds: PreviewBounds; visible: boolean }
	| { action: "load"; url: string }
	/** Let `tabId`'s agent drive the page through the relay its bridge started (`browser_relay_start`). */
	| { action: "agentStart"; tabId: string; url: string; token: string }
	/** Take the page back: the agent's connection closes and its debugger detaches. */
	| { action: "agentStop" }
	| { action: "zoom"; zoom: number }
	| { action: "viewport"; viewport: PreviewViewport }
	| { action: "clearProblems" | "dismissNotice" }
	| { action: "back" | "forward" | "reload" | "stop" | "dispose" };
export interface PreviewApi {
	command(request: PreviewRequest): Promise<PreviewState>;
	/** Ask where to save, then print the page to that PDF: the saved path, or `null` when the user cancelled. */
	savePdf(): Promise<string | null>;
	onState(callback: (state: PreviewState) => void): () => void;
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
