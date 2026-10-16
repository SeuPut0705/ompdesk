/**
 * A dev server's URL in a bash result opens the Preview (`autoPreviewDevServer`, default on) for
 * the FOCUSED tab only, yielding to whatever the user is doing.
 *
 * The rules (`devServerUrl`, `panelYields`) are pure; the rest is the little state they need
 * (which URLs were offered). Nothing here moves focus, and everything it does is one `ui` store
 * write the user can undo by closing the panel.
 */
import { AUTO_PREVIEW_DEV_SERVER_PREF } from "../../shared/desktop-prefs";
import type { AgentSessionEvent } from "../../shared/rpc-types";
import type { SessionStore } from "../stores/session";
import { sessionRuntimeStore } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { type PanelView, useUiStore } from "../stores/ui";
import { resultText } from "./format";
import { detectLocalPreviewUrls } from "./preview-browser";

/** How long an open passive view must have gone untouched before a dev server may take its place. */
export const PANEL_IDLE_MS = 30_000;

/** Views a person works in: never replaced, however long they sit. */
const WORKING_VIEWS: Record<string, true> = { terminal: true, files: true, preview: true, subagent: true };

/** A command that starts something that serves. */
const SERVER_COMMAND =
	/\b(?:dev|start|serve|server|watch|preview|vite|next|nuxt|astro|remix|svelte-kit|webpack|parcel|storybook|uvicorn|gunicorn|flask|rails|php\s+-S|http\.server|live-server|hugo|jekyll|mkdocs|docusaurus|expo)\b/i;
/** What a server prints beside its address. */
const SERVER_BANNER =
	/\b(?:listening|ready\s+(?:in|on|at)|local:|network:|serving\s+http|running\s+(?:on|at)|started\s+server|available\s+(?:on|at)|server\s+(?:is\s+)?(?:running|started|listening)|dev\s+server)\b/i;
/** A client that only talks to a server: its output names an address without starting anything. */
const CLIENT_COMMAND = /\b(?:curl|wget|httpie|xh|ping|nc|telnet|lsof)\b/i;

/**
 * The address a bash result says a server listens on, or null. It needs an explicit port (a dev
 * server always has one) and either a server-looking command or a server's own banner; a client
 * such as `curl` never counts.
 */
export function devServerUrl(input: { toolName: string; command: string | undefined; text: string }): string | null {
	if (input.toolName !== "bash" || !input.text) return null;
	if (input.command && CLIENT_COMMAND.test(input.command)) return null;
	if (!(input.command && SERVER_COMMAND.test(input.command)) && !SERVER_BANNER.test(input.text)) return null;
	for (const url of detectLocalPreviewUrls(input.text)) if (new URL(url).port) return url;
	return null;
}

export interface PanelGate {
	visible: boolean;
	tab: PanelView;
	/** The Files editor holds unsaved edits. */
	dirty: boolean;
	/** A view switch already waits on the editor's discard confirm. */
	pendingSwitch: boolean;
	/** Milliseconds since the user last touched the panel. */
	idleMs: number;
}

/** Whether the panel may be taken over without costing the user anything. */
export function panelYields(panel: PanelGate): boolean {
	if (panel.dirty || panel.pendingSwitch) return false;
	if (!panel.visible) return true;
	if (WORKING_VIEWS[panel.tab]) return false;
	return panel.idleMs >= PANEL_IDLE_MS;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/** Preview URLs already offered, by session. */
const offeredPreviews = new Map<string, Set<string>>();
/** Set while this module writes the store, so its own writes are not read as the user's. */
let writing = false;
let panelTouchedAt = Date.now();
let installed = false;

/** Per tab: the commands of running bash calls, which the end event does not repeat. */
const commands = new Map<string, Map<string, string>>();

function sessionKey(tabId: string): string {
	return sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId || tabId;
}

function focusedTab(tabId: string): boolean {
	return useTabsStore.getState().activeTabId === tabId && useUiStore.getState().destination === "session";
}

function gate(): PanelGate {
	const ui = useUiStore.getState();
	return {
		visible: ui.panelVisible,
		tab: ui.panelTab,
		dirty: ui.fileEditDirty,
		pendingSwitch: ui.pendingFileSwitch !== null,
		idleMs: Date.now() - panelTouchedAt,
	};
}

async function prefOn(key: string): Promise<boolean> {
	try {
		return (await window.omp.prefs.get(key)) !== false;
	} catch {
		return false;
	}
}

function install(): void {
	if (installed) return;
	installed = true;
	useUiStore.subscribe((next, previous) => {
		if (writing) return;
		if (next.panelVisible === previous.panelVisible && next.panelTab === previous.panelTab) return;
		panelTouchedAt = Date.now();
	});
	if (typeof document === "undefined" || typeof Element === "undefined") return;
	const touch = (event: Event) => {
		const target = event.target;
		if (target instanceof Element && target.closest(".omp-inspector")) panelTouchedAt = Date.now();
	};
	for (const type of ["pointerdown", "keydown", "wheel", "focusin"]) document.addEventListener(type, touch, true);
}

/** Write the store without moving the composer's focus; the write is the module's own. */
function openPanel(write: () => void): void {
	const dom = typeof document !== "undefined" && typeof HTMLElement !== "undefined";
	const active = dom ? document.activeElement : null;
	writing = true;
	try {
		write();
	} finally {
		writing = false;
	}
	panelTouchedAt = Date.now();
	if (dom && active instanceof HTMLElement && typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => {
			if (active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
		});
	}
}

// ---------------------------------------------------------------------------------------------
// Dev server → Preview
// ---------------------------------------------------------------------------------------------

function offerPreview(tabId: string, url: string): void {
	if (!focusedTab(tabId)) return;
	// A paired host's loopback is not this computer's: the Preview blocks it, so it never opens for one.
	if (useTabsStore.getState().tabs.find(tab => tab.id === tabId)?.device) return;
	const key = sessionKey(tabId);
	const offered = offeredPreviews.get(key) ?? new Set<string>();
	if (offered.has(url)) return;
	offered.add(url);
	offeredPreviews.set(key, offered);
	if (useUiStore.getState().previewUrl === url || !panelYields(gate())) return;
	void prefOn(AUTO_PREVIEW_DEV_SERVER_PREF).then(on => {
		if (!on || !focusedTab(tabId) || !panelYields(gate())) return;
		openPanel(() => useUiStore.getState().openPreview(url));
	});
}

/** Feed one tab's event batch: the focused tab's dev servers and edits may open the side panel. */
export function handleAutoOpenEvents(tabId: string, events: readonly AgentSessionEvent[]): void {
	install();
	for (const event of events) {
		switch (event.type) {
			case "tool_execution_start":
			case "tool_execution_update": {
				if (event.toolName !== "bash") break;
				const command = typeof event.args?.command === "string" ? event.args.command : undefined;
				if (command) {
					const running = commands.get(tabId) ?? new Map<string, string>();
					running.set(event.toolCallId, command);
					commands.set(tabId, running);
				}
				if (event.type === "tool_execution_update") {
					const url = devServerUrl({ toolName: "bash", command, text: resultText(event.partialResult) });
					if (url) offerPreview(tabId, url);
				}
				break;
			}
			case "tool_execution_end": {
				const command = commands.get(tabId)?.get(event.toolCallId);
				commands.get(tabId)?.delete(event.toolCallId);
				if (event.toolName === "bash" && !event.isError) {
					const url = devServerUrl({ toolName: "bash", command, text: resultText(event.result) });
					if (url) offerPreview(tabId, url);
				}
				break;
			}
			case "agent_end":
				if (event.isTerminal !== false) commands.delete(tabId);
				break;
			default:
				break;
		}
	}
}

/** Forget everything (tests). */
export function resetPanelAutoOpen(): void {
	offeredPreviews.clear();
	commands.clear();
	writing = false;
	panelTouchedAt = 0;
}
