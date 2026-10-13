export const PREVIEW_COMMAND = "preview:command";
export const PREVIEW_STATE = "preview:state";

export interface PreviewBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface PreviewState {
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	error: string | null;
}
export const EMPTY_PREVIEW: PreviewState = {
	url: "",
	title: "",
	loading: false,
	canGoBack: false,
	canGoForward: false,
	error: null,
};
export type PreviewRequest =
	| { action: "layout"; bounds: PreviewBounds; visible: boolean }
	| { action: "load"; url: string }
	| { action: "back" | "forward" | "reload" | "stop" | "dispose" };
export interface PreviewApi {
	command(request: PreviewRequest): Promise<PreviewState>;
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
