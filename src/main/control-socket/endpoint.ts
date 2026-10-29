/**
 * Where the control socket lives and how its folder and token are protected. The socket answers anyone who holds the
 * token, so everything here keeps the folder, the token and the endpoint file readable by this user only.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENDPOINT_FILE, type Endpoint, POSIX_SOCKET_FILE, TOKEN_FILE } from "../../../resources/cli/protocol";
import { writeFileAtomicSync } from "../atomic-file";

/** `sockaddr_un.sun_path` holds 104 bytes on macOS (108 on Linux) with its terminator. */
const MAX_SOCKET_PATH_BYTES = 103;
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const GROUP_OR_OTHER = 0o077;

export class ControlDirRefused extends Error {
	constructor(dir: string, reason: string) {
		super(`Control folder ${dir} refused: ${reason}`);
		this.name = "ControlDirRefused";
	}
}

export interface ControlEndpoint {
	/** `<userData>/control`: the token and endpoint.json, where the CLI looks. */
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
	// Only the socket moves to a short owner-only folder: the token and endpoint.json stay where the CLI looks.
	const uid = process.getuid?.() ?? 0;
	const tag = createHash("sha256").update(userData).digest("hex").slice(0, 12);
	const socketDir = join(tmpdir(), `ompdesk-${uid}-${tag}`);
	return { dir, socket: join(socketDir, POSIX_SOCKET_FILE), socketDir };
}

export interface PrepareControlDirOptions {
	/** The caller's uid; absent on Windows, where the folder's access list is the user's own. */
	getuid?: () => number;
}

/**
 * Makes the folder (owner only) and refuses one that is a link or another user's; repairs loose mode bits on ours.
 * Returns true when it had to repair them: whatever the folder held may have been read meanwhile.
 */
export function prepareControlDir(
	dir: string,
	{ getuid = process.getuid?.bind(process) }: PrepareControlDirOptions = {},
): boolean {
	mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
	if (getuid === undefined) return false;
	const stat = lstatSync(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ControlDirRefused(dir, "not a real folder");
	if (stat.uid !== getuid()) throw new ControlDirRefused(dir, "owned by another user");
	if ((stat.mode & GROUP_OR_OTHER) === 0) return false;
	chmodSync(dir, OWNER_ONLY_DIR);
	return true;
}

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

export interface TokenOptions extends PrepareControlDirOptions {
	/** The folder was open to others before `prepareControlDir` repaired it: the token is replaced. */
	exposed?: boolean;
}

/**
 * The install's token: 64 hex characters, made on first use, whenever the file is damaged, and whenever someone
 * else could have read it (the folder or the file was open to others, or the file is another user's).
 */
export function readOrCreateToken(
	dir: string,
	{ getuid = process.getuid?.bind(process), exposed = false }: TokenOptions = {},
): string {
	const file = join(dir, TOKEN_FILE);
	const existing = readText(file)?.trim();
	let trusted = !exposed && existing !== undefined && TOKEN_SHAPE.test(existing);
	if (trusted && getuid !== undefined) {
		const stat = lstatSync(file);
		trusted = stat.isFile() && stat.uid === getuid() && (stat.mode & GROUP_OR_OTHER) === 0;
	}
	if (trusted && existing !== undefined) return existing;
	// A file another user owns cannot be chmodded or replaced in place: it goes (the folder is ours).
	rmSync(file, { force: true });
	const token = randomBytes(32).toString("hex");
	writeFileAtomicSync(file, `${token}\n`, { mode: OWNER_ONLY_FILE });
	return token;
}

export function writeEndpoint(dir: string, endpoint: Endpoint): void {
	writeFileAtomicSync(join(dir, ENDPOINT_FILE), `${JSON.stringify(endpoint)}\n`, { mode: OWNER_ONLY_FILE });
}

/** Removes `endpoint.json` only while it still names `socket`: a newer OMPdesk's file is not ours to delete. */
export function removeEndpoint(dir: string, socket: string): void {
	const file = join(dir, ENDPOINT_FILE);
	const text = readText(file);
	if (text === undefined) return;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "socket" in parsed && parsed.socket === socket) {
			rmSync(file, { force: true });
		}
	} catch {
		// A damaged file names nothing of ours.
	}
}
