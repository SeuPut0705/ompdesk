/**
 * What an MCP server's configured launch is, read from the config the user wrote (never changed here):
 * the built-in REA, a remote URL, a package a runner (`npx`, `bunx`, `uvx`, `pnpm dlx`, `bun x`,
 * `uv tool run`, `pipx run`, `npm exec`) fetches itself, a command that runs an installed binary, or
 * something that is none of those (an interpreter running a script, a container). The rules are the core
 * process's (`native/ompdesk/crates/core/src/ext/mcp.rs`); this file is their contract and client.
 *
 * A runner package is `unpinned` when the spec names no version or `@latest` (the runner resolves the
 * newest by itself at start), otherwise pinned: an exact version, a range or a dist-tag all count, because
 * the user chose it.
 */
import type { HelperMcpServer } from "../../../resources/gui-bridge/stock-helper/extensions-contracts";
import { extRule } from "./core";

export type McpRunner = "npx" | "bunx" | "pnpm-dlx" | "bun-x" | "npm-exec" | "uvx" | "uv-tool-run" | "pipx-run";

export type McpClass =
	| { kind: "builtin" }
	| { kind: "remote" }
	| {
			kind: "runner";
			runner: McpRunner;
			ecosystem: "npm" | "pypi";
			/** The package name without version or extras; the whole spec for a URL or path. */
			pkg: string;
			/** The version part of the spec; null when none (or `latest`). */
			version: string | null;
			/** The spec as written (`pkg@1.2.3`), shown as the row's detail. */
			spec: string;
			pinned: boolean;
			/** False for a git URL, a path or a tarball: no registry can say what is newer. */
			checkable: boolean;
	  }
	| { kind: "direct"; command: string }
	| { kind: "unsupported" };

/** Each server's class, in the servers' order. A server whose source is under `reaRoot` is the built-in REA. */
export function classifyMcpServers(
	servers: readonly HelperMcpServer[],
	options: { reaRoot: string | null },
): Promise<McpClass[]> {
	return extRule("ext.mcpClasses", { servers, reaRoot: options.reaRoot });
}
