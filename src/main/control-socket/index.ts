/**
 * Starts the local control socket: anything on this computer that holds the token (a terminal omp, a script, another
 * agent CLI) can drive OMPdesk the way its own agents do with the `ompdesk_*` tools. The app works without it: a
 * failed start is one log line and a null handle.
 */

import { join } from "node:path";
import { CONTROL_PROTOCOL_VERSION, TOKEN_FILE } from "../../../resources/cli/protocol";
import type { ControlBackend } from "./backend";
import {
	ControlDirRefused,
	controlEndpoint,
	prepareControlDir,
	readOrCreateToken,
	removeEndpoint,
	writeEndpoint,
} from "./endpoint";
import { setControlEndpoint } from "./env";
import { EventHub } from "./events";
import { ControlRouter } from "./router";
import { ControlServer } from "./server";
import { type PowerShell, runPowerShell, secureFolder, securePipe } from "./windows-acl";

export interface ControlSocketOptions {
	userData: string;
	backend: ControlBackend;
	platform?: NodeJS.Platform;
	log?: (line: string) => void;
	/** Runs the Windows access-control scripts (`windows-acl.ts`); tests may stand in. */
	powershell?: PowerShell;
}

export interface ControlSocketHandle {
	socket: string;
	dir: string;
	close(): Promise<void>;
}

export async function startControlSocket({
	userData,
	backend,
	platform = process.platform,
	log = () => undefined,
	powershell = runPowerShell,
}: ControlSocketOptions): Promise<ControlSocketHandle | null> {
	const { dir, socket, socketDir } = controlEndpoint(userData, platform);
	const windows = platform === "win32";
	// Known before the first await: a session spawned while the socket comes up is still told where to find it.
	setControlEndpoint({ socket, dir });
	let server: ControlServer | undefined;
	try {
		let exposed = prepareControlDir(dir);
		if (socketDir) prepareControlDir(socketDir);
		if (windows) {
			const verdict = await secureFolder(dir, join(dir, TOKEN_FILE), powershell);
			if (verdict === "foreign") throw new ControlDirRefused(dir, "owned by another user");
			exposed ||= verdict === "repaired";
		}
		const token = readOrCreateToken(dir, { exposed });
		server = new ControlServer({ token, router: new ControlRouter(backend, new EventHub(backend)) });
		await server.listen(socket);
		// The pipe's name is published (endpoint.json) only once it is this user's alone and refuses the network.
		if (windows) await securePipe(socket, powershell);
		writeEndpoint(dir, { version: CONTROL_PROTOCOL_VERSION, socket, pid: process.pid });
	} catch (error) {
		await server?.close();
		setControlEndpoint(null);
		log(`Control socket not started: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
	const running = server;
	return {
		socket,
		dir,
		async close() {
			await running.close();
			removeEndpoint(dir, socket);
			setControlEndpoint(null);
		},
	};
}
