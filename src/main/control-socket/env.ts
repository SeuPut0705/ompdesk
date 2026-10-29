import { CONTROL_DIR_ENV, CONTROL_SOCKET_ENV } from "../../../resources/cli/protocol";

const CONTROL_ENV = [CONTROL_SOCKET_ENV, CONTROL_DIR_ENV] as const;

/**
 * `env` with the control socket's variables as this app set them (`startControlSocket` writes them into
 * `process.env`), never what a login shell or a parent OMPdesk passed on: a dev run started from an OMPdesk terminal
 * would otherwise hand its sessions the parent's socket.
 */
export function withControlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const own = { ...env };
	for (const key of CONTROL_ENV) {
		const value = process.env[key];
		if (value) own[key] = value;
		else delete own[key];
	}
	return own;
}
