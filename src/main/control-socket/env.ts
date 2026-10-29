import { CONTROL_DIR_ENV, CONTROL_OFF_ENV, CONTROL_SOCKET_ENV } from "../../../resources/cli/protocol";

const CONTROL_ENV = [CONTROL_SOCKET_ENV, CONTROL_DIR_ENV, CONTROL_OFF_ENV] as const;

/** Where this app's control socket listens while it runs (`startControlSocket`); null before and after. */
let endpoint: { socket: string; dir: string } | null = null;

export function setControlEndpoint(next: { socket: string; dir: string } | null): void {
	endpoint = next;
}

/**
 * What a process OMPdesk spawns is told about the control socket. Never `process.env`: every child would inherit it,
 * including the sessions this computer runs for a paired device or the phone page, which would then drive this
 * computer with its front window instead of their device's permissions and quota. `foreign` (such a session, or its
 * terminal) gets only `OMPDESK_CONTROL_OFF=1`, which the CLI refuses on.
 */
export function controlEnvFor(foreign: boolean): Record<string, string> {
	if (foreign) return { [CONTROL_OFF_ENV]: "1" };
	return endpoint ? { [CONTROL_SOCKET_ENV]: endpoint.socket, [CONTROL_DIR_ENV]: endpoint.dir } : {};
}

/**
 * `env` without the control socket's variables a login shell or a parent OMPdesk passed on: a dev run started from
 * an OMPdesk terminal would otherwise hand its sessions the parent's socket.
 */
export function withoutControlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const own = { ...env };
	for (const key of CONTROL_ENV) delete own[key];
	return own;
}
