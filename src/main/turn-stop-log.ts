/**
 * One runtime-log line (source `turn-stop`) for every Stop that reaches an omp: the tab, the session file's name and
 * who asked. A stopped turn is never continued (turn-resume.ts), so when a turn ended by a Stop nobody remembers,
 * this line names the window and control, the paired device, the agent tool or the part of OMPdesk that sent it.
 * No message text. Electron-free: index.ts points it at the runtime log.
 */
import type { RpcCommand } from "../shared/rpc-types";

type StopCommand = Extract<RpcCommand, { type: "abort" | "abort_and_prompt" | "abort_and_restore_queue" }>;

/** The stock RPC commands that end the running turn; such a turn is never continued (`noteStopped`). */
export const STOP_COMMANDS: Record<string, true> = {
	abort: true,
	abort_and_prompt: true,
	abort_and_restore_queue: true,
};

export function isStopCommand(command: RpcCommand): command is StopCommand {
	return STOP_COMMANDS[command.type] === true;
}

/** Who sent a Stop. The first four come through a command dispatcher; the rest are parts of main that stop a turn. */
export type TurnStopBy =
	| "window"
	| "web-device"
	| "desktop-device"
	| "agent-control"
	| "autopilot"
	| "desktop-slot"
	| "quit"
	| "turn-resume";

export interface TurnStop {
	command: string;
	tab: string;
	/** The session file (only its name is logged); looked up by tab when left out. */
	session?: string;
	by: TurnStopBy;
	/** The renderer control (`StopSurface`), or why a part of main stopped the turn. */
	surface?: string;
	/** The asking window's routing id (a paired web device's window is negative). */
	window?: number;
	/** The paired device that asked: a web device, or a desktop device whose tab runs here. */
	device?: string;
	/** The tab whose request led to this Stop: an OMPdesk control tool's caller, or the Autopilot run of a child. */
	caller?: string;
	/** The paired host the tab runs on: the host logs the Stop again on its side. */
	host?: string;
	/** The IPC channel a dispatched Stop came in on, when it named no surface. */
	channel?: string;
}

export interface TurnStopSink {
	write(details: Record<string, string | number>): void;
	sessionOf(tab: string): string | undefined;
}

let sink: TurnStopSink | null = null;

/** Where `recordTurnStop` writes (index.ts: the runtime log); null stops it. */
export function setTurnStopLog(next: TurnStopSink | null): void {
	sink = next;
}

export function recordTurnStop(stop: TurnStop): void {
	if (!sink) return;
	const { session = sink.sessionOf(stop.tab), ...rest } = stop;
	const details: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(rest)) if (value !== undefined) details[key] = value;
	if (session) details.session = session.split(/[\\/]/).at(-1) ?? session;
	sink.write(details);
}

/** Where a dispatcher received a command. `peer`: on a host, the paired desktop device that sent it. */
export interface StopSite {
	tab: string;
	session?: string;
	window?: number;
	webDevice?: string;
	peer?: string;
	/** The tab runs on this paired host: the command goes there with its origin, and the host logs it too. */
	host?: string;
	channel?: string;
}

/**
 * A dispatcher's view of one command: a Stop is logged with who asked (the command's `origin`, else what the site
 * knows) and comes back without its origin, unless it goes on to a paired host, which reads and logs it itself.
 * Any other command comes back as it is.
 */
export function dispatchedCommand(command: RpcCommand, site: StopSite): RpcCommand {
	if (!isStopCommand(command)) return command;
	const { origin } = command;
	const by: TurnStopBy = site.peer
		? "desktop-device"
		: origin?.agentControl
			? "agent-control"
			: site.webDevice
				? "web-device"
				: "window";
	recordTurnStop({
		command: command.type,
		tab: site.tab,
		session: site.session,
		by,
		surface: origin?.surface,
		window: site.peer ? undefined : site.window,
		device: site.peer ?? site.webDevice,
		caller: origin?.agentControl,
		host: site.host,
		channel: origin?.surface || origin?.agentControl ? undefined : site.channel,
	});
	if (site.host || origin === undefined) return command;
	const { origin: _origin, ...rest } = command;
	return rest;
}
