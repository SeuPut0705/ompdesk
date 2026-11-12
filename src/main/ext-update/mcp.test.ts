import { describe, expect, it } from "vitest";
import type { HelperMcpServer } from "../../../resources/gui-bridge/stock-helper/extensions-contracts";
import { classifyMcpServers } from "./mcp";

function server(command: string | null, args: string[] = [], over: Partial<HelperMcpServer> = {}): HelperMcpServer {
	return {
		name: "s",
		type: "stdio",
		command,
		args,
		url: null,
		enabled: true,
		sourcePath: "/home/u/.omp/agent/mcp.json",
		origin: "user",
		...over,
	};
}

const classifyUnder = async (reaRoot: string | null, entry: HelperMcpServer) =>
	(await classifyMcpServers([entry], { reaRoot }))[0];

const classify = (command: string | null, args: string[] = [], over: Partial<HelperMcpServer> = {}) =>
	classifyUnder("/app/resources/omp-builtin", server(command, args, over));

describe("built-in and remote servers", () => {
	it("marks a server whose source is under the REA root", async () => {
		expect(await classify("node", ["x"], { sourcePath: "/app/resources/omp-builtin/.mcp.json" })).toEqual({
			kind: "builtin",
		});
		expect(
			await classifyUnder(
				"/app/resources/omp-builtin",
				server("x", [], { sourcePath: "/app/resources/omp-builtin-other/.mcp.json" }),
			),
		).toEqual({ kind: "direct", command: "x" });
		expect(
			await classifyUnder("c:/app/omp-builtin", server("x", [], { sourcePath: "C:\\App\\omp-builtin\\.mcp.json" })),
		).toEqual({ kind: "builtin" });
		expect(await classifyUnder(null, server("x"))).toEqual({ kind: "direct", command: "x" });
	});

	it("marks http and sse servers remote", async () => {
		expect(await classify(null, [], { type: "http", url: "https://x.test/mcp" })).toEqual({ kind: "remote" });
		expect(await classify(null, [], { type: "sse", url: "https://x.test/sse" })).toEqual({ kind: "remote" });
		expect(await classify(null)).toEqual({ kind: "unsupported" });
	});
});

describe("runner packages", () => {
	it("npx: unpinned without a version or at @latest", async () => {
		expect(await classify("npx", ["-y", "@scope/server"])).toMatchObject({
			kind: "runner",
			runner: "npx",
			ecosystem: "npm",
			pkg: "@scope/server",
			version: null,
			pinned: false,
			checkable: true,
			spec: "@scope/server",
		});
		expect(await classify("npx", ["-y", "server@latest", "--flag"])).toMatchObject({ pkg: "server", pinned: false });
	});

	it("npx: an exact version, a range and a dist-tag are all pinned", async () => {
		expect(await classify("npx", ["--yes", "@scope/server@1.2.3"])).toMatchObject({
			pkg: "@scope/server",
			version: "1.2.3",
			pinned: true,
			spec: "@scope/server@1.2.3",
		});
		expect(await classify("npx", ["server@^1.2.0"])).toMatchObject({
			pkg: "server",
			version: "^1.2.0",
			pinned: true,
		});
		expect(await classify("npx", ["server@next"])).toMatchObject({ pkg: "server", version: "next", pinned: true });
	});

	it("skips flags and the values they take", async () => {
		expect(await classify("npx", ["-y", "--registry", "https://r.test", "server@2.0.0"])).toMatchObject({
			pkg: "server",
			version: "2.0.0",
		});
		expect(await classify("npx", ["--registry=https://r.test", "-y", "server"])).toMatchObject({ pkg: "server" });
		expect(await classify("npx", ["-y", "-p", "real-pkg@3.1.0", "bin-name"])).toMatchObject({
			pkg: "real-pkg",
			version: "3.1.0",
			pinned: true,
		});
		expect(await classify("npx", ["--package=real-pkg", "bin-name"])).toMatchObject({
			pkg: "real-pkg",
			pinned: false,
		});
		expect(await classify("npx", ["--", "server@1.0.0"])).toMatchObject({ pkg: "server", pinned: true });
		// Arguments after the package belong to the server.
		expect(await classify("npx", ["server", "--version", "9.9.9"])).toMatchObject({ pkg: "server", pinned: false });
	});

	it("a shell string, a git URL and a path cannot name a registry package", async () => {
		expect(await classify("npx", ["-c", "server --x"])).toEqual({ kind: "unsupported" });
		expect(await classify("npx", ["github:owner/repo"])).toMatchObject({
			kind: "runner",
			pinned: true,
			checkable: false,
		});
		expect(await classify("npx", ["owner/repo"])).toMatchObject({ checkable: false });
		expect(await classify("npx", ["./local-server"])).toMatchObject({ checkable: false });
		expect(await classify("npx", ["https://x.test/p.tgz"])).toMatchObject({ checkable: false, pinned: true });
		expect(await classify("npx", ["-y"])).toEqual({ kind: "unsupported" });
	});

	it("bunx, bun x, pnpm dlx and npm exec", async () => {
		expect(await classify("bunx", ["--bun", "server@1.0.0"])).toMatchObject({
			runner: "bunx",
			pkg: "server",
			pinned: true,
		});
		expect(await classify("bun", ["x", "server"])).toMatchObject({ runner: "bun-x", pinned: false });
		expect(await classify("pnpm", ["dlx", "@s/server@4"])).toMatchObject({
			runner: "pnpm-dlx",
			pkg: "@s/server",
			version: "4",
		});
		expect(await classify("npm", ["exec", "--yes", "--", "server@1.0.0"])).toMatchObject({
			runner: "npm-exec",
			pkg: "server",
			pinned: true,
		});
		expect(await classify("npm", ["exec", "-p", "server@2.0.0", "--", "bin"])).toMatchObject({
			pkg: "server",
			version: "2.0.0",
		});
	});

	it("uvx: ==, @ and ranges; extras are not part of the name", async () => {
		expect(await classify("uvx", ["mcp-server-git"])).toMatchObject({
			runner: "uvx",
			ecosystem: "pypi",
			pkg: "mcp-server-git",
			pinned: false,
		});
		expect(await classify("uvx", ["mcp-server-git==1.2.3"])).toMatchObject({
			pkg: "mcp-server-git",
			version: "1.2.3",
			pinned: true,
		});
		expect(await classify("uvx", ["mcp-server-git@1.2.3"])).toMatchObject({ version: "1.2.3", pinned: true });
		expect(await classify("uvx", ["mcp-server-git@latest"])).toMatchObject({ pinned: false });
		expect(await classify("uvx", ["mcp-server-git>=1.0,<2"])).toMatchObject({
			pkg: "mcp-server-git",
			version: ">=1.0,<2",
			pinned: true,
		});
		expect(await classify("uvx", ["server[extra]==2.0.0"])).toMatchObject({ pkg: "server", version: "2.0.0" });
		expect(await classify("uvx", ["--python", "3.12", "--with", "extra", "server"])).toMatchObject({
			pkg: "server",
			pinned: false,
		});
		expect(await classify("uvx", ["--from", "real-pkg==3.0.0", "bin"])).toMatchObject({
			pkg: "real-pkg",
			version: "3.0.0",
			pinned: true,
		});
		expect(await classify("uvx", ["--from", "git+https://x.test/r.git", "bin"])).toMatchObject({ checkable: false });
	});

	it("uv tool run and pipx run", async () => {
		expect(await classify("uv", ["tool", "run", "server==1.0.0"])).toMatchObject({
			runner: "uv-tool-run",
			pinned: true,
		});
		expect(await classify("pipx", ["run", "--spec", "real==2.0.0", "bin"])).toMatchObject({
			runner: "pipx-run",
			pkg: "real",
			version: "2.0.0",
		});
		expect(await classify("pipx", ["run", "server"])).toMatchObject({ runner: "pipx-run", pinned: false });
	});

	it("looks through Windows launchers and cmd /c", async () => {
		expect(await classify("npx.cmd", ["-y", "server@1.0.0"])).toMatchObject({ runner: "npx", pinned: true });
		expect(await classify("C:\\Program Files\\nodejs\\npx.cmd", ["server"])).toMatchObject({ runner: "npx" });
		expect(await classify("cmd", ["/c", "npx", "-y", "server@1.0.0"])).toMatchObject({
			runner: "npx",
			pkg: "server",
			pinned: true,
		});
		expect(await classify("uvx.exe", ["server"])).toMatchObject({ runner: "uvx" });
	});
});

describe("direct commands and the rest", () => {
	it("a binary name is direct", async () => {
		expect(await classify("mcp-server-thing", ["--stdio"])).toEqual({ kind: "direct", command: "mcp-server-thing" });
		expect(await classify("/opt/homebrew/bin/thing")).toEqual({ kind: "direct", command: "/opt/homebrew/bin/thing" });
	});

	it("an interpreter or a container runner is never the thing to update", async () => {
		for (const command of ["node", "python3", "python3.12", "deno", "docker", "bash", "uv", "bun", "npm"]) {
			expect(await classify(command, ["server.js"])).toEqual({ kind: "unsupported" });
		}
		expect(await classify("uv", ["run", "server"])).toEqual({ kind: "unsupported" });
	});
});
