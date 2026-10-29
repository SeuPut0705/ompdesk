/**
 * What the control socket asks of the app: the same agent-control service the `ompdesk_*` host tools use
 * (`AgentControlRuntime`), called as an outside caller, and the pool's tab activity for waits and events. The socket
 * never decides a tool's rules itself.
 */

import type { SessionState } from "../../../resources/cli/protocol";
import type { AgentControlRuntime, OutsideCaller } from "../agent-control/host";
import { type ControlTab, type ToolOutcome, waits } from "../agent-control/service";
import type { SidecarPool, TabActivity } from "../sidecar-pool";

export type { OutsideCaller };

/** One open session the waits and the event stream see. */
export interface SessionView {
	session: string;
	title: string;
	state: SessionState;
}

export interface ControlBackend {
	/** One control tool call, exactly as an agent in a session makes it (`AgentControlRuntime.runOutside`). */
	run(caller: OutsideCaller, tool: string, args: unknown): Promise<ToolOutcome>;
	/**
	 * The open session `name` names, by the tools' own rules (tab id, saved id, prefix, title); a session hidden from
	 * agents is refused. Rejects with the tools' own message when nothing open matches.
	 */
	resolve(caller: OutsideCaller, name: string): Promise<SessionView>;
	/** The session now, or null once its tab is gone or it was hidden from agents. */
	view(session: string): SessionView | null;
	/** Every open session agents may see, now. */
	views(): SessionView[];
	/** The pool's tab activity (a turn starting or ending, an ask, a close), as it happens. */
	observe(listener: (activity: TabActivity) => void): () => void;
	/** Reports addressed to an outside caller (a session it opened called `ompdesk_report`). */
	onOutsideMail(listener: (callerId: string, text: string) => void): () => void;
	/** The caller's connection closed: it no longer acts or hears reports. */
	release(caller: OutsideCaller): void;
}

/** The one state rule: waiting on the person (the work board's and the tools' `waits`) wins over a running turn. */
export function sessionState(tab: ControlTab): SessionState {
	if (waits(tab)) return "blocked";
	switch (tab.status) {
		case "starting":
		case "restarting":
		case "waiting":
			return "starting";
		case "error":
		case "exited":
			return "stopped";
	}
	return tab.busy || tab.resuming === true ? "working" : "idle";
}

export function sessionView(tab: ControlTab): SessionView {
	return { session: tab.tabId, title: tab.title || tab.task || "", state: sessionState(tab) };
}

/** The backend over the app's control runtime and pool. A session hidden from agents is never seen. */
export function createControlBackend(
	runtime: Pick<
		AgentControlRuntime,
		"runOutside" | "resolveOutside" | "controlTabs" | "onOutsideMail" | "releaseOutside"
	>,
	pool: Pick<SidecarPool, "observeTabs">,
): ControlBackend {
	const visible = () => runtime.controlTabs().filter(tab => !tab.hidden);
	return {
		run: (caller, tool, args) => runtime.runOutside(caller, tool, args),
		resolve: async (caller, name) => sessionView(await runtime.resolveOutside(caller, name)),
		view: session => {
			const tab = visible().find(entry => entry.tabId === session);
			return tab ? sessionView(tab) : null;
		},
		views: () => visible().map(sessionView),
		observe: listener => pool.observeTabs(listener),
		onOutsideMail: listener => runtime.onOutsideMail(listener),
		release: caller => runtime.releaseOutside(caller),
	};
}
