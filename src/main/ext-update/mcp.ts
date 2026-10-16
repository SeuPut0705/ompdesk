/**
 * What an MCP server's configured launch is, read from the config the user wrote (never changed here):
 * the built-in REA, a remote URL, a package a runner (`npx`, `bunx`, `uvx`, `pnpm dlx`, `bun x`,
 * `uv tool run`, `pipx run`, `npm exec`) fetches itself, a command that runs an installed binary, or
 * something that is none of those (an interpreter running a script, a container). Pure.
 *
 * A runner package is `unpinned` when the spec names no version or `@latest` (the runner resolves the
 * newest by itself at start), otherwise pinned: an exact version, a range or a dist-tag all count, because
 * the user chose it.
 */
import type { HelperMcpServer } from "../../../resources/gui-bridge/stock-helper/extensions-contracts";

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

/** `C:\x\npx.cmd`, `/usr/bin/NPX` → `npx`. */
export function commandName(command: string): string {
	const base = command.split(/[\\/]/).at(-1) ?? command;
	return base.replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
}

/** Programs that run something else: their own binary is never the server, so it is never "updated". */
const INTERPRETERS: Record<string, true> = {
	node: true,
	nodejs: true,
	deno: true,
	bun: true,
	npm: true,
	pnpm: true,
	yarn: true,
	python: true,
	py: true,
	uv: true,
	pipx: true,
	poetry: true,
	ruby: true,
	java: true,
	dotnet: true,
	php: true,
	perl: true,
	go: true,
	cargo: true,
	sh: true,
	bash: true,
	zsh: true,
	fish: true,
	cmd: true,
	pwsh: true,
	powershell: true,
	env: true,
	docker: true,
	podman: true,
	nerdctl: true,
	wsl: true,
	ssh: true,
};

const isInterpreter = (name: string) => Object.hasOwn(INTERPRETERS, name) || /^python[\d.]*$/.test(name);

interface RunnerLaunch {
	runner: McpRunner;
	args: string[];
}

function runnerOf(name: string, args: string[]): RunnerLaunch | null {
	switch (name) {
		case "npx":
			return { runner: "npx", args };
		case "bunx":
			return { runner: "bunx", args };
		case "uvx":
			return { runner: "uvx", args };
		case "pnpm":
			return args[0] === "dlx" ? { runner: "pnpm-dlx", args: args.slice(1) } : null;
		case "bun":
			return args[0] === "x" ? { runner: "bun-x", args: args.slice(1) } : null;
		case "npm":
			return args[0] === "exec" || args[0] === "x" ? { runner: "npm-exec", args: args.slice(1) } : null;
		case "uv":
			return args[0] === "tool" && args[1] === "run" ? { runner: "uv-tool-run", args: args.slice(2) } : null;
		case "pipx":
			return args[0] === "run" ? { runner: "pipx-run", args: args.slice(1) } : null;
		default:
			return null;
	}
}

interface FlagTable {
	/** Flags that name the package to fetch. */
	package: readonly string[];
	/** Flags that take a value and are not the package. */
	value: readonly string[];
}

const NPM_FLAGS: FlagTable = {
	package: ["-p", "--package"],
	value: [
		"--registry",
		"--cache",
		"--userconfig",
		"--prefix",
		"--node-options",
		"--loglevel",
		"-w",
		"--workspace",
		"--shell",
		"--otp",
		"--before",
		"--fetch-retries",
	],
};
const BUNX_FLAGS: FlagTable = {
	package: ["-p", "--package"],
	value: ["--registry", "--cwd", "-c", "--config", "--cache-dir"],
};
const UV_FLAGS: FlagTable = {
	package: ["--from"],
	value: [
		"-w",
		"--with",
		"--with-editable",
		"--with-requirements",
		"-p",
		"--python",
		"--index",
		"-i",
		"--index-url",
		"--default-index",
		"--extra-index-url",
		"-f",
		"--find-links",
		"--index-strategy",
		"-c",
		"--constraints",
		"--overrides",
		"--env-file",
		"--directory",
		"--project",
		"--config-file",
		"--cache-dir",
		"--exclude-newer",
		"--resolution",
		"--prerelease",
		"--python-platform",
		"--link-mode",
		"--keyring-provider",
		"--color",
		"--allow-insecure-host",
		"--refresh-package",
		"--reinstall-package",
		"-P",
		"--upgrade-package",
		"--no-binary-package",
		"--no-build-package",
	],
};
const PIPX_FLAGS: FlagTable = {
	package: ["--spec"],
	value: ["--python", "--pip-args", "-i", "--index-url", "--fetch-missing-python"],
};

const FLAGS: Record<McpRunner, FlagTable> = {
	npx: NPM_FLAGS,
	"pnpm-dlx": NPM_FLAGS,
	"npm-exec": NPM_FLAGS,
	bunx: BUNX_FLAGS,
	"bun-x": BUNX_FLAGS,
	uvx: UV_FLAGS,
	"uv-tool-run": UV_FLAGS,
	"pipx-run": PIPX_FLAGS,
};

/** The package a runner is told to fetch: the `-p/--from/--spec` value, else the first positional. Null when none can be read. */
function packageArg(launch: RunnerLaunch): string | null {
	const table = FLAGS[launch.runner];
	let flagged: string | null = null;
	let positional: string | null = null;
	let literal = false;
	for (let i = 0; i < launch.args.length && positional === null; i++) {
		const arg = launch.args[i] ?? "";
		if (!literal && arg === "--") {
			literal = true;
			continue;
		}
		if (literal || !arg.startsWith("-")) {
			positional = arg;
			continue;
		}
		const eq = arg.indexOf("=");
		const flag = eq > 0 ? arg.slice(0, eq) : arg;
		const inline = eq > 0 ? arg.slice(eq + 1) : null;
		const isPackage = table.package.includes(flag);
		// `npx -c "cmd"` runs a shell string: there is no package to read.
		if (flag === "-c" && (launch.runner === "npx" || launch.runner === "npm-exec")) return null;
		if (flag === "--call") return null;
		if (isPackage || table.value.includes(flag)) {
			const value = inline ?? launch.args[++i] ?? null;
			if (isPackage && flagged === null) flagged = value;
		}
	}
	return flagged ?? positional;
}

function parseNpmSpec(raw: string): { pkg: string; version: string | null; checkable: boolean } {
	const spec = raw.replace(/^npm:/, "");
	if (
		/:\/\/|^(git\+|git@|github:|gitlab:|bitbucket:|file:|link:|\.|\/|~)/.test(spec) ||
		/^[^@][^/]*\/[^/]/.test(spec)
	) {
		return { pkg: raw, version: raw, checkable: false };
	}
	const at = spec.lastIndexOf("@");
	const version = at > 0 ? spec.slice(at + 1) : "";
	return {
		pkg: at > 0 ? spec.slice(0, at) : spec,
		version: version === "" || version === "latest" ? null : version,
		checkable: true,
	};
}

function parsePypiSpec(raw: string): { pkg: string; version: string | null; checkable: boolean } {
	if (/:\/\/|^(git\+|\.|\/|~)|\.(whl|tar\.gz|zip)$/.test(raw)) return { pkg: raw, version: raw, checkable: false };
	const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/.exec(raw);
	if (!match?.[1]) return { pkg: raw, version: raw, checkable: false };
	const rest = (match[2] ?? "").trim();
	if (rest === "" || rest === "@latest") return { pkg: match[1], version: null, checkable: true };
	if (rest.startsWith("@")) {
		const version = rest.slice(1).trim();
		return { pkg: match[1], version, checkable: !/:\/\//.test(version) };
	}
	const exact = /^===?\s*(\S+)$/.exec(rest);
	return { pkg: match[1], version: exact?.[1] ?? rest, checkable: true };
}

/** A `cmd /c npx …` wrapper (how Windows configs start `.cmd` shims) is looked through. */
function unwrap(command: string, args: string[]): { name: string; args: string[] } {
	const name = commandName(command);
	if (name === "cmd" && args[0]?.toLowerCase() === "/c" && args[1]) {
		return { name: commandName(args[1]), args: args.slice(2) };
	}
	return { name, args };
}

function slash(value: string, lower: boolean): string {
	const text = value.replaceAll("\\", "/").replace(/\/+$/, "");
	return lower ? text.toLowerCase() : text;
}

/** The config file or plugin dir the server came from sits under the built-in REA's root. */
export function isBuiltinServer(server: HelperMcpServer, reaRoot: string | null): boolean {
	if (!reaRoot || !server.sourcePath) return false;
	const windows = /^[a-z]:[\\/]/i.test(reaRoot);
	const root = slash(reaRoot, windows);
	const source = slash(server.sourcePath, windows);
	return source === root || source.startsWith(`${root}/`);
}

export function classifyMcpServer(server: HelperMcpServer, options: { reaRoot: string | null }): McpClass {
	if (isBuiltinServer(server, options.reaRoot)) return { kind: "builtin" };
	if (server.type === "http" || server.type === "sse" || (!server.command && server.url)) return { kind: "remote" };
	if (!server.command) return { kind: "unsupported" };
	const { name, args } = unwrap(server.command, server.args);
	const launch = runnerOf(name, args);
	if (launch) {
		const raw = packageArg(launch);
		if (!raw) return { kind: "unsupported" };
		const ecosystem =
			launch.runner === "uvx" || launch.runner === "uv-tool-run" || launch.runner === "pipx-run" ? "pypi" : "npm";
		const parsed = ecosystem === "npm" ? parseNpmSpec(raw) : parsePypiSpec(raw);
		return {
			kind: "runner",
			runner: launch.runner,
			ecosystem,
			pkg: parsed.pkg,
			version: parsed.version,
			spec: raw,
			pinned: parsed.version !== null,
			checkable: parsed.checkable,
		};
	}
	if (isInterpreter(name)) return { kind: "unsupported" };
	return { kind: "direct", command: server.command };
}
