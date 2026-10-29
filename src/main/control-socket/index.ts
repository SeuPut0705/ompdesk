/**
 * Starts the local control socket: anything on this computer that holds the token (a terminal omp, a script, another
 * agent CLI) can drive OMPdesk the way its own agents do with the `ompdesk_*` tools. The app works without it: a
 * failed start is one log line and a null handle.
 */

import { CONTROL_PROTOCOL_VERSION } from "../../../resources/cli/protocol";
import type { ControlBackend } from "./backend";
import { controlEndpoint, prepareControlDir, readOrCreateToken, removeEndpoint, writeEndpoint } from "./endpoint";
import { setControlEndpoint } from "./env";
import { EventHub } from "./events";
import { ControlRouter } from "./router";
import { ControlServer } from "./server";

export interface ControlSocketOptions {
	userData: string;
	backend: ControlBackend;
	platform?: NodeJS.Platform;
	log?: (line: string) => void;
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
}: ControlSocketOptions): Promise<ControlSocketHandle | null> {
	const { dir, socket, socketDir } = controlEndpoint(userData, platform);
	// Known before the first await: a session spawned while the socket comes up is still told where to find it.
	setControlEndpoint({ socket, dir });
	let server: ControlServer | undefined;
	try {
		const exposed = prepareControlDir(dir);
		if (socketDir) prepareControlDir(socketDir);
		const token = readOrCreateToken(dir, { exposed });
		server = new ControlServer({ token, router: new ControlRouter(backend, new EventHub(backend)) });
		await server.listen(socket);
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
