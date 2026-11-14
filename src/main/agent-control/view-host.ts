import { randomUUID } from "node:crypto";
import { AGENT_CONTROL_VIEW, type AgentControlViewEvent } from "../../shared/agent-control";
import type { SessionViewHandle } from "../../shared/session-view";
import type { ClientWindow } from "../web/client-window";
import type { ViewCloseFacts } from "./service";

export interface LocalViewSurface {
	win: ClientWindow;
	facts: ViewCloseFacts;
}

interface PendingClose {
	surface: LocalViewSurface;
	resolve(): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
	started: boolean;
	beforeCommit(): Promise<() => boolean>;
}

export interface LocalViewHostDeps {
	surfaces(): LocalViewSurface[];
	close(
		surface: LocalViewSurface,
		stillClosable: () => boolean,
		beforeCommit: () => Promise<() => boolean>,
	): Promise<boolean>;
	isWeb(win: ClientWindow): boolean;
	timeoutMs: number;
}

/** The window acknowledges an exact, single-use close; absence in an execution summary is never an acknowledgement. */
export class LocalViewHost {
	readonly #deps: LocalViewHostDeps;
	readonly #pending = new Map<string, PendingClose>();

	constructor(deps: LocalViewHostDeps) {
		this.#deps = deps;
	}

	list(): ViewCloseFacts[] {
		return this.#deps.surfaces().map(surface => surface.facts);
	}

	#find(handle: SessionViewHandle): LocalViewSurface | undefined {
		return this.#deps.surfaces().find(({ facts }) => sameView(facts.handle, handle));
	}

	#permitted(initial: ViewCloseFacts): boolean {
		const current = this.#find(initial.handle)?.facts;
		if (!current?.enabled || current.tab.hidden || current.tab.busy || current.tab.resuming) return false;
		if (["running", "starting", "restarting", "waiting"].includes(current.tab.status)) return false;
		if (current.tab.asks.length > 0 || current.tab.plan || current.tab.webEdits === "dirty") return false;
		if (current.manageEnabled !== initial.manageEnabled || current.fullEnabled !== initial.fullEnabled) return false;
		if (!initial.tab.drafting && current.tab.drafting) return false;
		if ((!initial.tab.looked && current.tab.looked) || (!initial.tab.userTouched && current.tab.userTouched))
			return false;
		return current.tab.sessionPath === initial.tab.sessionPath;
	}

	async close(
		handle: SessionViewHandle,
		authorized: ViewCloseFacts,
		beforeCommit: () => Promise<() => boolean>,
	): Promise<void> {
		const surface = this.#find(handle);
		if (!surface || !sameView(authorized.handle, handle) || !this.#permitted(authorized))
			throw new Error("That view changed or is no longer safe to close. List its views again.");
		if (this.#deps.isWeb(surface.win)) {
			await this.#release(surface, authorized, beforeCommit);
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const token = randomUUID();
		const timer = setTimeout(() => {
			this.#pending.delete(token);
			reject(new Error("The selected window did not confirm closing that view."));
		}, this.#deps.timeoutMs);
		this.#pending.set(token, {
			surface: { ...surface, facts: authorized },
			resolve,
			reject,
			timer,
			started: false,
			beforeCommit,
		});
		try {
			surface.win.webContents.send(AGENT_CONTROL_VIEW, {
				tabId: handle.tabId,
				how: "close",
				closeRequest: token,
			} satisfies AgentControlViewEvent);
		} catch (error) {
			clearTimeout(timer);
			this.#pending.delete(token);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		await promise;
	}

	async #release(
		surface: LocalViewSurface,
		authorized: ViewCloseFacts,
		beforeCommit: () => Promise<() => boolean>,
	): Promise<void> {
		if (!this.#permitted(authorized)) throw new Error("That view changed before it could close.");
		const released = await this.#deps.close(surface, () => this.#permitted(authorized), beforeCommit);
		if (!released || this.#find(authorized.handle)) throw new Error("The selected view was not closed.");
	}

	/** The IPC caller supplies its real window; a renderer cannot acknowledge a different window's request. */
	async complete(win: ClientWindow, tabId: string, token: string, rejected: boolean): Promise<boolean> {
		const pending = this.#pending.get(token);
		if (!pending || pending.started || pending.surface.win !== win || pending.surface.facts.handle.tabId !== tabId)
			return false;
		pending.started = true;
		clearTimeout(pending.timer);
		if (rejected) {
			this.#pending.delete(token);
			pending.reject(new Error("The selected window refused to close that view."));
			return false;
		}
		try {
			await this.#release(pending.surface, pending.surface.facts, pending.beforeCommit);
			pending.resolve();
			return true;
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
			return false;
		} finally {
			this.#pending.delete(token);
		}
	}
}

function sameView(a: SessionViewHandle, b: SessionViewHandle): boolean {
	return (
		a.viewHost === b.viewHost &&
		a.window === b.window &&
		a.tabId === b.tabId &&
		a.session === b.session &&
		a.incarnation === b.incarnation
	);
}
