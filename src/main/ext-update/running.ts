/**
 * The running rule for an MCP server's own package (the vendor CLIs' rule in cli-tools/plans.ts, for
 * servers). npm and Bun replace the whole package dir (new directory inode; a later `require` reads the new
 * version's file, files only the old version had are gone), Homebrew removes the old keg, and pipx, `uv tool`
 * and pip rewrite site-packages in place: a SCRIPT (shebang, an interpreter loading its modules lazily) that
 * runs while that happens can load a file of the other version or find it missing, so its update waits. A
 * native binary (Mach-O/ELF/PE) keeps running from its old inode and updates at once. macOS scans `ps`;
 * Windows has no scan, a file a running server holds just fails the update (recorded, retried). The rule is the
 * core process's (`native/ompdesk/crates/core/src/ext/running.rs`); main lists the processes and asks.
 */
import type { ExtensionMethod } from "../../shared/extension-update";
import { extRule } from "./core";
import type { McpBinary } from "./mcp-owner";

/** An update by `method` of a file of this kind must wait while the server runs. */
export function deferForRunning(method: ExtensionMethod | null, script: boolean): Promise<boolean> {
	return extRule("ext.defersWhileRunning", { method, script });
}

/** Only macOS has the process scan (main's `processes`). */
export const scansProcesses = (platform: "darwin" | "win32"): boolean => platform === "darwin";

/**
 * `ps` command lines: does a process of this server run (its executable, its package dir, or its command
 * name as the program)?
 */
export function runningServer(commands: string, server: { command: string }, binary: McpBinary): Promise<boolean> {
	return extRule("ext.serverRunning", { commands, command: server.command, binary });
}
