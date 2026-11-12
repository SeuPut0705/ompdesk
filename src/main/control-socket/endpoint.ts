/** Main names the endpoint synchronously for per-spawn env; the core owns its folder, token and endpoint file. */
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POSIX_SOCKET_FILE } from "../../shared/control-protocol";
import { CoreError, core } from "../core/process";

/** `sockaddr_un.sun_path` holds 104 bytes on macOS (108 on Linux) with its terminator. */
const MAX_SOCKET_PATH_BYTES = 103;

export class ControlDirRefused extends Error {
	constructor(dir: string, reason: string) {
		super(`Control folder ${dir} refused: ${reason}`);
		this.name = "ControlDirRefused";
	}
}

export interface ControlEndpoint {
	dir: string;
	socket: string;
	/** The short folder the socket moved to when `<dir>/control.sock` would not fit `sun_path`. */
	socketDir?: string;
}

export function controlEndpoint(userData: string, platform: NodeJS.Platform = process.platform): ControlEndpoint {
	const dir = join(userData, "control");
	if (platform === "win32") return { dir, socket: `\\\\.\\pipe\\ompdesk-${randomBytes(16).toString("hex")}` };
	const socket = join(dir, POSIX_SOCKET_FILE);
	if (Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES) return { dir, socket };
	const uid = process.getuid?.() ?? 0;
	const tag = createHash("sha256").update(userData).digest("hex").slice(0, 12);
	const socketDir = join(tmpdir(), `ompdesk-${uid}-${tag}`);
	return { dir, socket: join(socketDir, POSIX_SOCKET_FILE), socketDir };
}

export interface PrepareControlDirOptions {
	getuid?: () => number;
}

export async function prepareControlDir(
	dir: string,
	{ getuid = process.getuid?.bind(process) }: PrepareControlDirOptions = {},
): Promise<boolean> {
	try {
		return (await core().call<{ repaired: boolean }>("control.prepareDir", { dir, uid: getuid?.() })).result.repaired;
	} catch (error) {
		if (error instanceof CoreError && error.code === "control_dir_refused") {
			const refused = new ControlDirRefused(dir, "");
			refused.message = error.message;
			throw refused;
		}
		throw error;
	}
}

export interface TokenOptions extends PrepareControlDirOptions {
	exposed?: boolean;
}

export async function readOrCreateToken(
	dir: string,
	{ getuid = process.getuid?.bind(process), exposed = false }: TokenOptions = {},
): Promise<string> {
	return (await core().call<{ token: string }>("control.token", { dir, uid: getuid?.(), exposed })).result.token;
}
