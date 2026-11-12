import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallContext } from "../cli-tools/detect";
import { classifyMcpBinary, detectMcpBinary, type OwnerDeps } from "./mcp-owner";

const MAC: InstallContext = { platform: "darwin", toolsDir: "/tools", brew: "/opt/homebrew/bin/brew" };
const WIN: InstallContext = { platform: "win32", toolsDir: "C:\\tools", brew: null };

describe("classifyMcpBinary", () => {
	it("npm, Bun and Homebrew installs name their package manager", async () => {
		expect(await classifyMcpBinary("/usr/local/lib/node_modules/@s/pkg/bin/cli.js", "pkg", MAC)).toEqual({
			owner: { method: "npm", name: "@s/pkg", prefix: "/usr/local", root: "/usr/local/lib/node_modules/@s/pkg" },
			skip: null,
		});
		expect(await classifyMcpBinary("/Users/u/.bun/install/global/node_modules/pkg/dist/cli.js", "pkg", MAC)).toEqual({
			owner: {
				method: "bun",
				name: "pkg",
				bunRoot: "/Users/u/.bun",
				root: "/Users/u/.bun/install/global/node_modules/pkg",
			},
			skip: null,
		});
		expect(await classifyMcpBinary("/opt/homebrew/Cellar/thing/1.0.0/bin/thing", "thing", MAC)).toEqual({
			owner: { method: "brew", name: "thing", brew: "/opt/homebrew/bin/brew" },
			skip: null,
		});
		expect(await classifyMcpBinary("/opt/homebrew/Caskroom/thing/1.0.0/thing", "thing", MAC)).toMatchObject({
			owner: { method: "brew-cask", name: "thing" },
		});
	});

	it("pipx and uv tool venvs are recognised by path, on both platforms", async () => {
		expect(await classifyMcpBinary("/Users/u/.local/pipx/venvs/mcp-thing/bin/mcp-thing", "mcp-thing", MAC)).toEqual({
			owner: { method: "pipx", name: "mcp-thing", venv: "/Users/u/.local/pipx/venvs/mcp-thing" },
			skip: null,
		});
		expect(
			await classifyMcpBinary("/Users/u/.local/share/uv/tools/mcp-thing/bin/mcp-thing", "mcp-thing", MAC),
		).toEqual({
			owner: { method: "uv", name: "mcp-thing", dir: "/Users/u/.local/share/uv/tools/mcp-thing" },
			skip: null,
		});
		expect(await classifyMcpBinary("C:\\Users\\u\\pipx\\venvs\\foo\\Scripts\\foo.exe", "foo", WIN)).toEqual({
			owner: { method: "pipx", name: "foo", venv: "C:\\Users\\u\\pipx\\venvs\\foo" },
			skip: null,
		});
		expect(
			await classifyMcpBinary("C:\\Users\\u\\AppData\\Roaming\\uv\\tools\\foo\\Scripts\\foo.exe", "foo", WIN),
		).toMatchObject({
			owner: { method: "uv", name: "foo" },
		});
	});

	it("system, app-bundled and unowned copies are left alone with the cli-tools reasons", async () => {
		expect(await classifyMcpBinary("/usr/bin/thing", "thing", MAC)).toEqual({ owner: null, skip: "system" });
		expect(await classifyMcpBinary("/Applications/App.app/Contents/MacOS/thing", "thing", MAC)).toEqual({
			owner: null,
			skip: "bundled",
		});
		expect(await classifyMcpBinary("/Users/u/bin/thing", "thing", MAC)).toEqual({
			owner: null,
			skip: "unknown-install",
		});
		// A Homebrew keg without brew on this Mac cannot be updated.
		expect(
			await classifyMcpBinary("/opt/homebrew/Cellar/thing/1.0.0/bin/thing", "thing", { ...MAC, brew: null }),
		).toEqual({
			owner: null,
			skip: "unknown-install",
		});
		// machine setup's managed tools dir is not an MCP server's owner.
		expect(await classifyMcpBinary("/tools/node/bin/thing", "thing", MAC)).toEqual({
			owner: null,
			skip: "unknown-install",
		});
	});
});

describe("on disk", () => {
	const dirs: string[] = [];
	const temp = () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-mcp-owner-")));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			fs.chmodSync(dir, 0o755);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	const write = (file: string, content: string | Buffer, mode = 0o755) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content, { mode });
	};
	const deps = (
		pathEnv: string,
		probe: OwnerDeps["probe"] = async () => Promise.reject(new Error("no python")),
	): OwnerDeps => ({
		pathEnv,
		ctx: MAC,
		probe,
	});

	it("reads a direct python and an env lookup from the shebang, and refuses other interpreters", async () => {
		const root = temp();
		const asked = async (shebang: string, pathEnv = "") => {
			const file = path.join(root, "tool");
			write(file, `${shebang}\n`);
			const pythons: string[] = [];
			await detectMcpBinary(
				file,
				deps(pathEnv, async bin => {
					pythons.push(bin);
					return "";
				}),
			);
			return pythons[0] ?? null;
		};
		expect(await asked("#!/opt/py/bin/python3.12")).toBe("/opt/py/bin/python3.12");
		expect(await asked("#!/bin/sh")).toBeNull();
		expect(await asked("#!/usr/bin/env node")).toBeNull();
		expect(await asked("#!/usr/bin/env python3", "/nowhere")).toBeNull();
		const bin = path.join(root, "bin");
		write(path.join(bin, "python3"), "");
		expect(await asked("#!/usr/bin/env python3", bin)).toBe(path.join(bin, "python3"));
	});

	it("tells scripts from native binaries by their first bytes", async () => {
		const root = temp();
		write(path.join(root, "script"), "#!/usr/bin/env node\n");
		write(path.join(root, "elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]));
		write(path.join(root, "macho"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
		write(path.join(root, "pe.exe"), Buffer.from("MZ\x90\x00"));
		write(path.join(root, "blob"), Buffer.from([1, 2, 3, 4, 5]));
		const script = async (name: string) => (await detectMcpBinary(path.join(root, name), deps("")))?.script;
		expect(await script("script")).toBe(true);
		expect(await script("elf")).toBe(false);
		expect(await script("macho")).toBe(false);
		expect(await script("pe.exe")).toBe(false);
		// Neither a script nor a native binary: it waits like a script.
		expect(await script("blob")).toBe(true);
	});

	it("reads a venv's dist-info version", async () => {
		const root = temp();
		const venv = path.join(root, "pipx", "venvs", "mcp-thing");
		const site = path.join(venv, "lib", "python3.12", "site-packages");
		fs.mkdirSync(path.join(site, "mcp_thing-2.0.1.dist-info"), { recursive: true });
		fs.mkdirSync(path.join(site, "other-9.9.9.dist-info"), { recursive: true });
		write(path.join(venv, "bin", "mcp-thing"), "#!/x/python\n");
		expect(await detectMcpBinary(path.join(venv, "bin", "mcp-thing"), deps(""))).toMatchObject({
			owner: { method: "pipx", name: "mcp-thing" },
			installed: "2.0.1",
			script: true,
		});
		// A venv without site-packages records no version.
		const bare = path.join(root, "uv", "tools", "absent");
		write(path.join(bare, "bin", "absent"), "#!/x/python\n");
		expect(await detectMcpBinary(path.join(bare, "bin", "absent"), deps(""))).toMatchObject({
			owner: { method: "uv", name: "absent" },
			installed: null,
		});
	});

	it.skipIf(process.platform === "win32")(
		"finds an npm global through its symlink and reads the package version",
		async () => {
			const root = temp();
			const pkg = path.join(root, "prefix", "lib", "node_modules", "@s", "pkg");
			write(path.join(pkg, "package.json"), JSON.stringify({ version: "1.2.3" }));
			write(path.join(pkg, "bin", "cli.js"), "#!/usr/bin/env node\n");
			fs.mkdirSync(path.join(root, "prefix", "bin"), { recursive: true });
			fs.symlinkSync(path.join(pkg, "bin", "cli.js"), path.join(root, "prefix", "bin", "pkg"));
			const found = await detectMcpBinary("pkg", deps(path.join(root, "prefix", "bin")));
			expect(found).toMatchObject({
				owner: { method: "npm", name: "@s/pkg", prefix: path.join(root, "prefix"), root: pkg },
				skip: null,
				installed: "1.2.3",
				script: true,
			});
			expect(found?.real).toBe(path.join(pkg, "bin", "cli.js"));
		},
	);

	it.skipIf(process.platform === "win32")("finds a pipx tool and its installed version", async () => {
		const root = temp();
		const venv = path.join(root, "pipx", "venvs", "mcp-thing");
		write(path.join(venv, "bin", "mcp-thing"), "#!/x/python\n");
		fs.mkdirSync(path.join(venv, "lib", "python3.12", "site-packages", "mcp_thing-0.4.0.dist-info"), {
			recursive: true,
		});
		fs.mkdirSync(path.join(root, "bin"), { recursive: true });
		fs.symlinkSync(path.join(venv, "bin", "mcp-thing"), path.join(root, "bin", "mcp-thing"));
		const found = await detectMcpBinary("mcp-thing", deps(path.join(root, "bin")));
		expect(found).toMatchObject({
			owner: { method: "pipx", name: "mcp-thing", venv },
			installed: "0.4.0",
			script: true,
		});
	});

	it.skipIf(process.platform === "win32")("a pip script is owned through its python's entry points", async () => {
		const root = temp();
		const python = path.join(root, "py", "python3");
		write(python, "");
		write(path.join(root, "bin", "tool"), `#!${python}\nprint('x')\n`);
		const calls: string[][] = [];
		const found = await detectMcpBinary(
			"tool",
			deps(path.join(root, "bin"), async (bin, args) => {
				calls.push([bin, ...args.slice(2)]);
				return args[1]?.includes("console_scripts") ? "my-dist\n" : "3.4.5\n";
			}),
		);
		expect(found).toMatchObject({
			owner: { method: "pip", name: "my-dist", python },
			installed: "3.4.5",
			skip: null,
		});
		expect(calls[0]).toEqual([python, "tool"]);
	});

	it.skipIf(process.platform === "win32")(
		"a script no python names stays unowned; a native binary is not a script",
		async () => {
			const root = temp();
			const python = path.join(root, "py", "python3");
			write(python, "");
			write(path.join(root, "bin", "tool"), `#!${python}\n`);
			write(path.join(root, "bin", "native"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
			expect(await detectMcpBinary("tool", deps(path.join(root, "bin")))).toMatchObject({
				owner: null,
				skip: "unknown-install",
				script: true,
			});
			expect(await detectMcpBinary("native", deps(path.join(root, "bin")))).toMatchObject({
				owner: null,
				skip: "unknown-install",
				script: false,
			});
			expect(await detectMcpBinary("absent", deps(path.join(root, "bin")))).toBeNull();
			expect(await detectMcpBinary(path.join(root, "bin", "absent"), deps(""))).toBeNull();
		},
	);

	it.skipIf(process.platform === "win32")(
		"an install in a directory the user cannot write is not-writable",
		async () => {
			const root = temp();
			const pkgs = path.join(root, "prefix", "lib", "node_modules");
			const pkg = path.join(pkgs, "pkg");
			write(path.join(pkg, "package.json"), JSON.stringify({ version: "1.0.0" }));
			write(path.join(pkg, "bin", "cli.js"), "#!/usr/bin/env node\n");
			fs.mkdirSync(path.join(root, "prefix", "bin"), { recursive: true });
			fs.symlinkSync(path.join(pkg, "bin", "cli.js"), path.join(root, "prefix", "bin", "pkg"));
			fs.chmodSync(pkgs, 0o555);
			try {
				const found = await detectMcpBinary("pkg", deps(path.join(root, "prefix", "bin")));
				expect(found).toMatchObject({ owner: null, skip: "not-writable", installed: "1.0.0" });
			} finally {
				fs.chmodSync(pkgs, 0o755);
			}
		},
	);
});
