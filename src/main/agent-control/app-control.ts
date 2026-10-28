/**
 * `ompdesk_app_list` and `ompdesk_app`: the one place an agent's call to change OMPdesk is checked and run.
 *
 *   1. the action must be in the registry (`app-catalog.ts`); anything else is unknown, nothing falls through;
 *   2. `never` refuses; arguments are validated against the action's schema;
 *   3. `sensitive` raises the `[OMPdesk]` confirmation card unless the person gave agents full control
 *      (`agentControlFull`, default on: no card at all) or turned `agentControlManage` on (default on); with only
 *      the latter, an action whose `manage` rule is `always` (erases data, runs code, credentials, network exposure,
 *      ends running work) still asks; an action marked `fullOnly` runs only under full control;
 *   4. the action runs with an `ActionContext` whose every primitive re-checks the tier the preference, setting,
 *      command or channel needs (`app-guard.ts`, `app-channels.ts`), so a nested route is refused like a direct one;
 *   5. a change is journaled in the caller's session, shown as a quiet toast and, with a previous value, undoable.
 */
import type { AgentAppEvent, AppUndo, PrivacyPane, SidebarView } from "../../shared/agent-control";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";
import type { IpcChannel } from "../web/ipc-policy";
import { ACTION_BY_ID, type ActionContext, type ActionResult, type AppAction, type AppChange } from "./app-catalog";
import { AGENT_CHANNELS } from "./app-channels";
import { AppRefusal, covers, type GrantedTier, prefTier, rpcTier, settingTier, type Tier } from "./app-guard";
import { validateArgs } from "./app-schema";
import { HOST_PREFS, SETTING_BY_ID, SETTINGS, settingActionId } from "./app-settings";

export { AppRefusal };

/** What `ompdesk_app` needs from the app; `host.ts` builds it. */
export interface AppPorts {
	getPref(key: string): unknown;
	/** The paired host the calling session's tab runs on (its `device`); undefined = this computer. */
	device(callerTabId: string): string | undefined;
	/** Write a preference through `PREFS_SET` (its validation and side effects included). */
	setPref(callerTabId: string, key: string, value: unknown): Promise<void>;
	rpc(callerTabId: string, command: RpcCommand): Promise<RpcResponse>;
	invoke(callerTabId: string, channel: string, args: readonly unknown[]): Promise<unknown>;
	fire(callerTabId: string, channel: string, args: readonly unknown[]): void;
	send(callerTabId: string, event: AgentAppEvent): void;
	confirm(callerTabId: string, title: string, message: string): Promise<boolean>;
	manageEnabled(): boolean;
	/** `agentControlFull`: no card at all, and the agent-power switches become writable. */
	fullEnabled(): boolean;
	/** Journal a line in the caller's session. Best effort. */
	note(callerTabId: string, text: string): Promise<void>;
	text(key: "appTitle" | "appMessage" | "appChanged", params: Record<string, string>): string;
	/** The English or the Korean text, by the app's language. */
	localize(en: string, ko: string): string;
	/** What the person's sidebar holds of pins, aliases and project order (never the agent-hidden list). */
	sidebarView(): SidebarView;
	/** Open a macOS Privacy & Security pane (this computer's System Settings); rejects off macOS. */
	openPrivacyPane(pane: PrivacyPane): Promise<void>;
	callerTitle(callerTabId: string): string;
	/** `ompdesk_autopilot` itself (its card and folder rules); the app actions go through it, never around it. */
	autopilot(callerTabId: string, args: unknown): Promise<string>;
}

/** Past this many matches `ompdesk_app_list` lists names only; narrow with `area` or `query` for schemas. */
const SCHEMA_LIST_MAX = 12;

interface LastChange {
	undo: AppUndo;
	tier: GrantedTier;
	en: string;
	ko: string;
}

function refuse(what: string, tier: Tier): never {
	throw new AppRefusal(
		tier === "never"
			? `${what} is never available to an agent. Tell the person to do it in Settings.`
			: `${what} needs the ${tier} level, which this action does not have.`,
	);
}

export class AppControl {
	readonly #ports: AppPorts;
	readonly #last = new Map<string, LastChange>();
	readonly #signIns = new Set<string>();

	readonly #registry: Readonly<Record<string, AppAction>>;

	/** `registry` is the shipped catalog; a test passes its own actions to prove what the context refuses. */
	constructor(ports: AppPorts, registry: Readonly<Record<string, AppAction>> = ACTION_BY_ID) {
		this.#ports = ports;
		this.#registry = registry;
	}

	list(raw: unknown): string {
		const fields: Record<string, unknown> = raw && typeof raw === "object" ? { ...raw } : {};
		const filter = (key: "area" | "query"): string => {
			const value = fields[key];
			return typeof value === "string" ? value.toLowerCase() : "";
		};
		const area = filter("area");
		const query = filter("query");
		const found = Object.values(this.#registry).filter(action => {
			if (area && !(action.area.toLowerCase() === area || action.area.toLowerCase().startsWith(`${area}/`)))
				return false;
			return !query || `${action.id} ${action.area} ${action.description}`.toLowerCase().includes(query);
		});
		if (found.length === 0) return "No action matches. Call ompdesk_app_list with no filter to see every area.";
		const withSchema = found.length <= SCHEMA_LIST_MAX;
		const full = this.#ports.fullEnabled();
		const rows = found.map(action => {
			const rule = action.manage;
			const card =
				rule === undefined || full
					? ""
					: "lifts" in rule
						? ", card unless the user lets agents manage"
						: rule.when
							? ", always a card for some arguments"
							: ", always a card";
			const head = `- ${action.id} [${action.tier}${card}] ${action.description}`;
			if (action.tier === "never") return `${head} Refused: ${action.neverReason}`;
			if (action.fullOnly && !full) return `${head} Refused: ${action.fullOnly}`;
			return withSchema ? `${head}\n  args: ${JSON.stringify(action.args)}` : head;
		});
		const note = withSchema ? "" : `\n(${found.length} actions; narrow with area or query to see argument schemas.)`;
		return `${rows.join("\n")}${note}`;
	}

	async run(callerTabId: string, actionId: unknown, raw: unknown): Promise<string> {
		const action =
			typeof actionId === "string" && Object.hasOwn(this.#registry, actionId) ? this.#registry[actionId] : undefined;
		if (!action)
			throw new AppRefusal(`Unknown action ${JSON.stringify(actionId)}. Call ompdesk_app_list to see the actions.`);
		if (action.tier === "never" || !action.run) refuse(`"${action.id}"`, "never");
		if (action.fullOnly && !this.#ports.fullEnabled())
			throw new AppRefusal(`"${action.id}" is never available to an agent: ${action.fullOnly}`);
		const checked = validateArgs(action.args, raw);
		if (!checked.ok) throw new AppRefusal(`Invalid args for ${action.id}: ${checked.error}`);
		await this.#confirmed(callerTabId, action.tier, action, checked.value);
		const result = await action.run(this.#context(callerTabId, action.id, action.tier), checked.value);
		if (result.change) await this.#record(callerTabId, result.change, action.tier);
		return result.text;
	}

	async #confirmed(
		callerTabId: string,
		tier: Tier,
		action: AppAction | null,
		args: Record<string, unknown> | null,
		what?: string,
	): Promise<void> {
		const rule = action?.manage;
		const forced = rule !== undefined && "always" in rule && (rule.when?.(args ?? {}) ?? true);
		if (tier !== "sensitive" || this.#ports.fullEnabled() || (this.#ports.manageEnabled() && !forced)) return;
		const summary = what ?? this.#summary(action, args);
		const approved = await this.#ports.confirm(
			callerTabId,
			this.#ports.text("appTitle", {}),
			this.#ports.text("appMessage", { caller: this.#ports.callerTitle(callerTabId), what: summary }),
		);
		if (!approved)
			throw new AppRefusal(
				"The user declined. Do not try again or look for another route; tell them what you wanted and why.",
			);
	}

	#summary(action: AppAction | null, args: Record<string, unknown> | null): string {
		if (!action) return "";
		if (action.describe && args) return action.describe(args);
		const row = action.id.startsWith("settings.") ? SETTING_BY_ID[action.id.slice("settings.".length)] : undefined;
		const masked = row?.kind === "pref" && row.redact ? { ...args, value: "…" } : args;
		const shownArgs = masked && Object.keys(masked).length > 0 ? ` ${JSON.stringify(masked)}` : "";
		return `${action.description.split(". ")[0]}${shownArgs}`.slice(0, 400);
	}

	/** The primitives one call may use; each checks the tier it needs against `granted`. */
	#context(callerTabId: string, actionId: string, granted: GrantedTier): ActionContext {
		const ports = this.#ports;
		const device = ports.device(callerTabId);
		/** A row the Settings control sends to the host while the caller's tab runs on one (`HOST_PREFS`). */
		const hostPref = (key: string) => (device && Object.hasOwn(HOST_PREFS, key) ? HOST_PREFS[key] : undefined);
		const ctx: ActionContext = {
			callerTabId,
			device,
			getPref: async key => {
				if (prefTier(key, ports.fullEnabled()) === "never") refuse(`Reading "${key}"`, "never");
				const route = hostPref(key);
				if (!device || !route) return ports.getPref(key);
				return route.read(await ports.invoke(callerTabId, this.#channel(route.get, actionId, granted), [device]));
			},
			setPref: async (key, value) => {
				const needed = prefTier(key, ports.fullEnabled());
				if (!covers(granted, needed)) refuse(`Writing the preference "${key}"`, needed);
				const route = hostPref(key);
				if (device && route) {
					await ports.invoke(callerTabId, this.#channel(route.set, actionId, granted), [value, device]);
					return;
				}
				await ports.setPref(callerTabId, key, value);
				ports.send(callerTabId, { kind: "pref", key, value });
			},
			rpc: async command => {
				const needed = rpcTier(command, ports.fullEnabled());
				if (!covers(granted, needed)) refuse(`The command "${command.type}"`, needed);
				const response = await ports.rpc(callerTabId, command);
				if (!response.success) throw new AppRefusal(response.error ?? `${command.type} failed.`);
				return response.data;
			},
			startProviderLogin: providerId => {
				const needed = rpcTier({ type: "login", providerId }, ports.fullEnabled());
				if (!covers(granted, needed)) refuse("Provider sign-in", needed);
				ports.send(callerTabId, { kind: "provider-sign-in", tabId: callerTabId, providerId });
				if (this.#signIns.has(callerTabId)) return;
				this.#signIns.add(callerTabId);
				void ctx
					.rpc({ type: "login", providerId })
					.catch(error => {
						ports.send(callerTabId, {
							kind: "toast",
							message: ports.localize("Sign-in failed: ", "로그인 실패: ") + String(error),
						});
					})
					.finally(() => this.#signIns.delete(callerTabId));
			},
			invoke: (channel, ...args) => ports.invoke(callerTabId, this.#channel(channel, actionId, granted), args),
			fire: (channel, ...args) => ports.fire(callerTabId, this.#channel(channel, actionId, granted), args),
			ui: event => ports.send(callerTabId, event),
			sidebarView: () => ports.sidebarView(),
			openPrivacyPane: pane => ports.openPrivacyPane(pane),
			autopilot: args => ports.autopilot(callerTabId, args),
			undoLast: () => this.#undo(callerTabId),
		};
		return ctx;
	}

	#channel(channel: string, actionId: string, granted: GrantedTier): string {
		const entry = Object.hasOwn(AGENT_CHANNELS, channel) ? AGENT_CHANNELS[channel as IpcChannel] : undefined;
		if (!entry || "never" in entry) refuse(`The channel "${channel}"`, "never");
		if (!entry.actions.includes(actionId)) refuse(`The channel "${channel}" for ${actionId}`, "never");
		if (!covers(granted, entry.tier)) refuse(`The channel "${channel}"`, entry.tier);
		return channel;
	}

	async #record(callerTabId: string, change: AppChange, tier: GrantedTier): Promise<void> {
		const message = this.#ports.text("appChanged", {
			what: this.#ports.localize(change.en, change.ko),
			value: change.value,
		});
		if (change.undo) this.#last.set(callerTabId, { undo: change.undo, tier, en: change.en, ko: change.ko });
		else this.#last.delete(callerTabId);
		this.#ports.send(callerTabId, { kind: "toast", message, ...(change.undo ? { undo: change.undo } : {}) });
		await this.#ports.note(callerTabId, message).catch(() => undefined);
	}

	async #undo(callerTabId: string): Promise<ActionResult> {
		const last = this.#last.get(callerTabId);
		if (!last) throw new AppRefusal("Nothing to undo: your last change had no previous value, or you made none.");
		const full = this.#ports.fullEnabled();
		const needed = last.undo.kind === "pref" ? prefTier(last.undo.key, full) : settingTier(last.undo.path, full);
		if (needed === "never") refuse("Undoing that change", "never");
		const undo = last.undo;
		const row =
			undo.kind === "pref"
				? SETTINGS.find(setting => setting.kind === "pref" && setting.key === undo.key)
				: SETTING_BY_ID[undo.path];
		const undone = row ? (this.#registry[settingActionId(row.id)] ?? null) : null;
		await this.#confirmed(callerTabId, needed, undone, null, `undo "${last.en}"`);
		const ctx = this.#context(callerTabId, "app.undo", needed === "sensitive" ? "sensitive" : "change");
		if (last.undo.kind === "pref") {
			const { key, value: restored } = last.undo;
			await ctx.setPref(key, restored);
			const row = SETTINGS.find(setting => setting.kind === "pref" && setting.key === key);
			for (const [mirrored, derive] of Object.entries(row?.kind === "pref" ? (row.mirror ?? {}) : {}))
				await ctx.setPref(mirrored, derive(restored));
		} else await ctx.rpc({ type: "set_setting", path: last.undo.path, value: last.undo.value });
		this.#last.delete(callerTabId);
		const value = typeof last.undo.value === "string" ? last.undo.value : JSON.stringify(last.undo.value);
		return {
			text: `Restored ${last.en} to ${value}.`,
			change: { en: last.en, ko: last.ko, value },
		};
	}

	/** A session closed: its undo is gone. */
	released(callerTabId: string): void {
		this.#last.delete(callerTabId);
	}
}
