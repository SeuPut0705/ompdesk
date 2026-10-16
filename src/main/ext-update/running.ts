/**
 * The running rule for an MCP server's own package (the vendor CLIs' rule in cli-tools/plans.ts, for
 * servers). npm and Bun replace the whole package dir (new directory inode; a later `require` reads the new
 * version's file, files only the old version had are gone), Homebrew removes the old keg, and pipx, `uv tool`
 * and pip rewrite site-packages in place: a SCRIPT (shebang, an interpreter loading its modules lazily) that
 * runs while that happens can load a file of the other version or find it missing, so its update waits. A
 * native binary (Mach-O/ELF/PE) keeps running from its old inode and updates at once. macOS scans `ps`;
 * Windows has no scan, a file a running server holds just fails the update (recorded, retried).
 */
import type { ExtensionMethod } from "../../shared/extension-update";
import { commandName } from "./mcp";
import type { McpBinary } from "./mcp-owner";

/** Owners whose update replaces files a running script loads lazily. */
const REPLACING: Record<string, true> = {
	npm: true,
	bun: true,
	brew: true,
	"brew-cask": true,
	pipx: true,
	uv: true,
	pip: true,
};

/** An update by `method` of a file of this kind must wait while the server runs. */
export function deferForRunning(method: ExtensionMethod | null, script: boolean): boolean {
	return script && method !== null && Object.hasOwn(REPLACING, method);
}

/** Only macOS has the process scan. */
export const scansProcesses = (platform: "darwin" | "win32"): boolean => platform === "darwin";

/** `needle` appears in `text` as a whole path: not the tail of a longer one, not the head of a longer name. */
function mentions(text: string, needle: string): boolean {
	for (let from = 0; ; ) {
		const at = text.indexOf(needle, from);
		if (at < 0) return false;
		const before = text[at - 1];
		const after = text[at + needle.length];
		if ((before === undefined || /[\s="':]/.test(before)) && (after === undefined || /[\s/"']/.test(after)))
			return true;
		from = at + 1;
	}
}

/** The directory (or keg) an update of this owner replaces. */
function ownedDir(binary: McpBinary): { dir: string | null; fragment: string | null } {
	const owner = binary.owner;
	switch (owner?.method) {
		case "npm":
		case "bun":
			return { dir: owner.root, fragment: null };
		case "pipx":
			return { dir: owner.venv, fragment: null };
		case "uv":
			return { dir: owner.dir, fragment: null };
		case "brew":
			return { dir: null, fragment: `/Cellar/${owner.name}/` };
		case "brew-cask":
			return { dir: null, fragment: `/Caskroom/${owner.name}/` };
		default:
			return { dir: null, fragment: null };
	}
}

/**
 * `ps` command lines: does a process of this server run (its executable, its package dir, or its command
 * name as the program)?
 */
export function runningServer(commands: string, server: { command: string }, binary: McpBinary): boolean {
	const name = server.command.split(/[\\/]/).at(-1) ?? server.command;
	const { dir, fragment } = ownedDir(binary);
	const paths = [binary.real, binary.path, dir].filter((value): value is string => Boolean(value));
	return commands.split("\n").some(line => {
		const text = line.trim();
		if (!text) return false;
		const first = text.split(/\s+/)[0] ?? "";
		return (
			first === server.command ||
			commandName(first) === commandName(name) ||
			paths.some(path => mentions(text, path)) ||
			(fragment !== null && text.includes(fragment))
		);
	});
}
