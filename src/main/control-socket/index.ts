/** Starts the core's local control socket; a failed start is one log line and a null handle. */
import { CONTROL_PROTOCOL_VERSION } from "../../shared/control-protocol";
import type { ControlBackend } from "./backend";
import { controlEndpoint, prepareControlDir, readOrCreateToken } from "./endpoint";
import { setControlEndpoint } from "./env";
import { ControlServer, type ControlTuning } from "./server";

export interface ControlSocketOptions {
	userData: string;
	backend: ControlBackend;
	platform?: NodeJS.Platform;
	log?: (line: string) => void;
	/** Shorter beats and limits for parity tests against the real core. */
	tuning?: ControlTuning;
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
	tuning,
}: ControlSocketOptions): Promise<ControlSocketHandle | null> {
	const { dir, socket, socketDir } = controlEndpoint(userData, platform);
	// Known before the first await: a session spawned while the socket comes up can still find it.
	setControlEndpoint({ socket, dir });
	let server: ControlServer | undefined;
	try {
		const exposed = await prepareControlDir(dir);
		if (socketDir) await prepareControlDir(socketDir);
		const token = await readOrCreateToken(dir, { exposed });
		server = new ControlServer({
			token,
			backend,
			tuning,
			log,
			publish: { dir, endpoint: { version: CONTROL_PROTOCOL_VERSION, socket, pid: process.pid } },
		});
		await server.listen(socket);
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
			setControlEndpoint(null);
		},
	};
}
