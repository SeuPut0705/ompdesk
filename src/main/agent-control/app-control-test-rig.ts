/**
 * The parity rig of `ompdesk_app_list` and `ompdesk_app` (`app-control.test.ts`, `app-catalog.test.ts`): the checks,
 * the actions and their texts live in the Rust core (`native/ompdesk/crates/core/src/agentctl/app/`), where the
 * agent-control service runs them with its own ports. This opens one instance of them over a `CorePort` with ports a
 * test provides: the core asks main for what main alone holds (preferences, the omp's commands, the windows' channels,
 * the cards) through `AppPorts`, and reads the few switches the checks lean on from the snapshot (`manage`, `full`,
 * the language, what the sidebar holds).
 *
 * A refusal the core makes (code `app_refusal`) is thrown here as an `AppRefusal` with the core's message.
 */
import type { AgentAppEvent, PrivacyPane, SidebarView } from "../../shared/agent-control";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { CorePort } from "../core/ports";
import { CoreError, core } from "../core/process";
import type { AppPorts } from "./service";

/** The longest a call may wait: an action can wait on a confirmation card for as long as the person takes. */
const NO_TIMEOUT_MS = 2 ** 31 - 1;

/** A refusal the agent reads: not a failure of the app. Its `code` is how the core's refusal reaches it and back. */
export class AppRefusal extends Error {
	readonly code = "app_refusal";
}

/** One primitive of a test action: what the action does through its context. */
export type ScriptStep =
	| { op: "getPref"; key: string }
	| { op: "setPref"; key: string; value: unknown }
	| { op: "rpc"; command: unknown; device?: string }
	| { op: "invoke"; channel: string; args?: unknown[] };

/** An action a test defines in place of the shipped catalog, to prove what the context refuses. */
export interface ScriptedAction {
	tier: "read" | "change" | "sensitive";
	steps: ScriptStep[];
}

/** Main's synchronous reads the core's checks lean on (`AppState` in the core). */
interface AppSnapshot {
	manage: boolean;
	full: boolean;
	korean: boolean;
	sidebar: SidebarView;
}

export class AppControl {
	readonly #port: CorePort<AppSnapshot>;
	readonly #scripts: { id: string; tier: ScriptedAction["tier"]; steps: ScriptStep[] }[] | undefined;
	#opened: Promise<void> | null = null;

	/** `registry` is for tests: its actions replace the shipped catalog. */
	constructor(ports: AppPorts, registry?: Readonly<Record<string, ScriptedAction>>) {
		this.#scripts = registry
			? Object.entries(registry).map(([id, action]) => ({ id, tier: action.tier, steps: action.steps }))
			: undefined;
		this.#port = new CorePort<AppSnapshot>(
			{
				getPref: ({ key }: { key: string }) => {
					const value = ports.getPref(key);
					return { found: value !== undefined, value: value ?? null };
				},
				device: ({ caller }: { caller: string }) => ports.device(caller) ?? null,
				setPref: ({ caller, key, value }: { caller: string; key: string; value: unknown }) =>
					ports.setPref(caller, key, value),
				rpc: ({ caller, command }: { caller: string; command: RpcCommand }) => ports.rpc(caller, command),
				rpcOn: ({ caller, device, command }: { caller: string; device: string; command: RpcCommand }) =>
					ports.rpcOn(caller, device, command),
				invoke: ({ caller, channel, args }: { caller: string; channel: string; args: unknown[] }) =>
					ports.invoke(caller, channel, args),
				fire: ({ caller, channel, args }: { caller: string; channel: string; args: unknown[] }) =>
					ports.fire(caller, channel, args),
				send: ({ caller, event }: { caller: string; event: AgentAppEvent }) => ports.send(caller, event),
				confirm: ({ caller, title, message }: { caller: string; title: string; message: string }) =>
					ports.confirm(caller, title, message),
				note: ({ caller, text }: { caller: string; text: string }) => ports.note(caller, text),
				text: ({
					key,
					params,
				}: {
					key: "appTitle" | "appMessage" | "appChanged";
					params: Record<string, string>;
				}) => ports.text(key, params),
				openPrivacyPane: ({ pane }: { pane: PrivacyPane }) => ports.openPrivacyPane(pane),
				callerTitle: ({ caller }: { caller: string }) => ports.callerTitle(caller),
				autopilot: ({ caller, args }: { caller: string; args: unknown }) => ports.autopilot(caller, args),
			},
			() => ({
				manage: ports.manageEnabled(),
				full: ports.fullEnabled(),
				korean: ports.localize("en", "ko") === "ko",
				sidebar: ports.sidebarView(),
			}),
		);
	}

	/** `ompdesk_app_list`: the actions, filtered by `area` and `query` of `raw`. */
	list(raw: unknown): Promise<string> {
		return this.#call("app.list", { args: raw });
	}

	/** `ompdesk_app`: runs one action for the caller's session; an `AppRefusal` says why it did not. */
	run(callerTabId: string, actionId: unknown, raw: unknown): Promise<string> {
		return this.#call("app.run", { caller: callerTabId, action: actionId, args: raw });
	}

	/** A session closed: its undo is gone. */
	released(callerTabId: string): void {
		if (!this.#opened) return;
		void this.#call("app.released", { caller: callerTabId }).catch(() => {});
	}

	#open(): Promise<void> {
		this.#opened ??= core()
			.call("app.open", {
				port: this.#port.id,
				...this.#port.first(),
				...(this.#scripts ? { scripts: this.#scripts } : {}),
			})
			.then(
				() => undefined,
				error => {
					this.#opened = null;
					throw error;
				},
			);
		return this.#opened;
	}

	async #call(method: string, params: Record<string, unknown>, retry = true): Promise<string> {
		await this.#open();
		try {
			return (await core().call<string>(method, { port: this.#port.id, ...params }, { timeoutMs: NO_TIMEOUT_MS }))
				.result;
		} catch (error) {
			if (!(error instanceof CoreError)) throw error;
			if (error.code === "app_refusal") throw new AppRefusal(error.message);
			// A core that started again holds no instance of this port: open it again, once.
			if (error.code === "no_app" && retry) {
				this.#opened = null;
				return this.#call(method, params, false);
			}
			throw error;
		}
	}
}
