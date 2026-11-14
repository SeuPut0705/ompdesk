/** One visible session view, bound to the host and lifetime that owns its tab. */
export interface SessionViewHandle {
	viewHost: string;
	window: string;
	tabId: string;
	session: string;
	incarnation: string;
}
