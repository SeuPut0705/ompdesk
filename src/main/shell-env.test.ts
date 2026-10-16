import * as fs from "node:fs/promises";
import * as os from "node:os";
import { homedir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DelegationMode } from "../../resources/gui-bridge/delegation-contracts";
import type { NextPromptSettings } from "../../resources/gui-bridge/next-prompt-contracts";
import type { UserProfile } from "../../resources/gui-bridge/user-profile-contracts";
import type { AccountRotationMode } from "../shared/account-rotation";
import {
	resetLoginShellEnvCache,
	resolveEditorCommand,
	resolveLoginShellEnv,
	shellSpawnEnv,
	spawnPath,
} from "./shell-env";
import { SidecarManager } from "./sidecar";
import { RM_TEMP, writeFakeOmp } from "./test-fake-omp";

/**
 * shell-env contract: GUI-spawned processes must see the user's login-shell
 * environment (PATH for bare-name MCP/CLI tools, rc-exported provider API
 * keys, $VISUAL/$EDITOR), never block a spawn on probe failure, never let
 * rc noise corrupt extraction, and never override an explicitly exported
 * launch env. The probe caches at module scope; resetLoginShellEnvCache
 * re-arms it so each test controls SHELL/HOME. Env is poked directly
 * (save/restore in afterEach) instead of vi.stubEnv so the file passes
 * under both vitest and `bun test`, whose vi-compat lacks stubEnv.
 */

const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
	if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
	process.env[key] = value;
}

function deleteEnv(key: string): void {
	if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
	delete process.env[key];
}

/** Login-shell probing is POSIX-only by design; Windows behavior is pinned by the `win32`-injected tests below. */
const itProbes = it.skipIf(process.platform === "win32");

async function writeFakeShell(dir: string, body: string): Promise<string> {
	const fakeShell = path.join(dir, "fake-shell");
	await fs.writeFile(fakeShell, `#!/bin/sh\n${body}\n`);
	await fs.chmod(fakeShell, 0o755);
	return fakeShell;
}

/** Fake login shell: optional rc noise around a marker-wrapped `env` dump. */
function envDumpBody(entries: Record<string, string>, noisy: boolean): string {
	const dump = Object.entries(entries)
		.map(([key, value]) => `printf '%s=%s\\n' '${key}' '${value}'`)
		.join("\n");
	return [
		...(noisy ? ['printf "rc-banner-noise\\n"'] : []),
		"printf '%s\\n' '__OMP_ENV_BEGIN__'",
		dump,
		"printf '%s\\n' '__OMP_ENV_END__'",
		...(noisy ? ['printf "trailing-noise\\n"'] : []),
	].join("\n");
}

beforeEach(() => {
	resetLoginShellEnvCache();
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
});

describe("resolveLoginShellEnv", () => {
	itProbes("extracts the env dump between markers even when the rc file prints noise", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-env-"));
		try {
			const fakeShell = await writeFakeShell(
				tempDir,
				envDumpBody({ PATH: "/probed/bin:/usr/bin", VISUAL: "probed-editor", PROBED_ONLY_KEY: "k1" }, true),
			);
			setEnv("SHELL", fakeShell);
			const result = await resolveLoginShellEnv();
			expect(result.path).toBe("/probed/bin:/usr/bin");
			expect(result.editor).toBe("probed-editor");
			expect(result.env.PROBED_ONLY_KEY).toBe("k1");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("degrades to empty fields when the shell probe fails", async () => {
		setEnv("SHELL", path.join(os.tmpdir(), "omp-no-such-shell"));
		await expect(resolveLoginShellEnv()).resolves.toEqual({ env: {}, path: null, editor: null });
	});

	it("never runs the login shell on Windows", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-env-"));
		try {
			setEnv("SHELL", await writeFakeShell(tempDir, envDumpBody({ PATH: "/probed/bin" }, false)));
			await expect(resolveLoginShellEnv("win32")).resolves.toEqual({ env: {}, path: null, editor: null });
		} finally {
			await fs.rm(tempDir, RM_TEMP);
		}
	});
});

describe("spawnPath", () => {
	itProbes("puts inherited PATH entries first and appends the probed shell PATH", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-env-"));
		try {
			const fakeShell = await writeFakeShell(tempDir, envDumpBody({ PATH: "/probed/bin" }, false));
			setEnv("SHELL", fakeShell);
			setEnv("PATH", "/inherited/bin:/usr/bin");
			const result = await spawnPath();
			expect(result.startsWith("/inherited/bin:/usr/bin")).toBe(true);
			expect(result.split(":")).toContain("/probed/bin");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to existing well-known user bin dirs when the probe fails", async () => {
		// homedir() differs across runners: node honors the stubbed $HOME
		// (%USERPROFILE% on Windows) while Bun's compat resolves the real home.
		// Stub first, then anchor the assertion on the same homedir() the module
		// calls, and mkdir -p whichever it returns (a no-op when it exists).
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-env-home-"));
		setEnv("SHELL", path.join(os.tmpdir(), "omp-no-such-shell"));
		setEnv("HOME", tempDir);
		setEnv("USERPROFILE", tempDir);
		setEnv("PATH", "/usr/bin");
		const homeBin = path.join(homedir(), ".local", "bin");
		await fs.mkdir(homeBin, { recursive: true });
		try {
			const entries = (await spawnPath()).split(path.delimiter);
			expect(entries).toContain(homeBin);
			expect(entries[0]).toBe("/usr/bin");
		} finally {
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("appends the Windows per-user tool dirs, never a probed shell PATH, on Windows", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-env-win-"));
		setEnv("SHELL", await writeFakeShell(tempDir, envDumpBody({ PATH: "/probed/bin" }, false)));
		setEnv("HOME", tempDir);
		setEnv("USERPROFILE", tempDir);
		setEnv("LOCALAPPDATA", path.join(tempDir, "Local"));
		setEnv("APPDATA", path.join(tempDir, "Roaming"));
		setEnv("PATH", ["/inherited/bin", "/usr/bin"].join(path.delimiter));
		const bunBin = path.join(homedir(), ".bun", "bin");
		const npmBin = path.join(tempDir, "Roaming", "npm");
		await fs.mkdir(bunBin, { recursive: true });
		await fs.mkdir(npmBin, { recursive: true });
		try {
			const entries = (await spawnPath("win32")).split(path.delimiter);
			expect(entries.slice(0, 2)).toEqual(["/inherited/bin", "/usr/bin"]);
			expect(entries).toContain(bunBin);
			expect(entries).toContain(npmBin);
			// Missing dirs stay off the PATH.
			expect(entries).not.toContain(path.join(tempDir, "Local", "Programs", "bun"));
			expect(entries).not.toContain("/probed/bin");
		} finally {
			await fs.rm(tempDir, RM_TEMP);
		}
	});
});

describe("shellSpawnEnv", () => {
	itProbes("overlays shell-only keys (rc-exported API keys) but never keys the launch env defines", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-env-"));
		try {
			const fakeShell = await writeFakeShell(
				tempDir,
				envDumpBody(
					{
						PATH: "/probed/bin",
						SHELL_ONLY_API_KEY: "from-rc",
						LAUNCH_WINS_KEY: "from-rc",
						HTTPS_PROXY: "rc-proxy-must-not-leak",
						PWD: "/rc/pwd/must/not/leak",
					},
					false,
				),
			);
			setEnv("SHELL", fakeShell);
			deleteEnv("SHELL_ONLY_API_KEY");
			setEnv("LAUNCH_WINS_KEY", "from-launch");
			const overlay = await shellSpawnEnv();
			expect(overlay.SHELL_ONLY_API_KEY).toBe("from-rc");
			expect(overlay.LAUNCH_WINS_KEY).toBeUndefined();
			expect(overlay.HTTPS_PROXY).toBeUndefined();
			expect(overlay.PWD).toBeUndefined();
			expect(overlay.PATH.split(path.delimiter)).toContain("/probed/bin");
		} finally {
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("overlays only the merged PATH on Windows", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-env-"));
		try {
			setEnv("SHELL", await writeFakeShell(tempDir, envDumpBody({ SHELL_ONLY_API_KEY: "from-rc" }, false)));
			deleteEnv("SHELL_ONLY_API_KEY");
			const overlay = await shellSpawnEnv("win32");
			expect(Object.keys(overlay)).toEqual(["PATH"]);
			expect(overlay.PATH).toBe(await spawnPath("win32"));
		} finally {
			await fs.rm(tempDir, RM_TEMP);
		}
	});
});

describe("resolveEditorCommand", () => {
	it("prefers process-env $VISUAL over the login-shell editor", async () => {
		setEnv("VISUAL", "explicit-editor");
		await expect(resolveEditorCommand()).resolves.toBe("explicit-editor");
	});

	it("falls back to notepad on Windows", async () => {
		deleteEnv("VISUAL");
		deleteEnv("EDITOR");
		await expect(resolveEditorCommand("win32")).resolves.toBe("notepad");
	});
});

describe("SidecarManager spawn env", () => {
	it("injects the shellEnv overlay into the spawned process", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-env-"));
		const envPath = path.join(tempDir, "env.json");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(envPath)}, JSON.stringify({ PATH: process.env.PATH, KEY: process.env.PROBED_SHELL_KEY ?? null }));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		const shellProbed = path.join(tempDir, "shell-probed");

		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin: binaryPath, version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: tempDir,
			shellEnv: () =>
				Promise.resolve({
					PATH: [shellProbed, process.env.PATH].join(path.delimiter),
					PROBED_SHELL_KEY: "present",
				}),
		});
		const ready = Promise.withResolvers<void>();
		sidecar.on("status", ({ status }) => {
			if (status === "ready") ready.resolve();
		});
		try {
			sidecar.start();
			await ready.promise;
			const env = JSON.parse(await fs.readFile(envPath, "utf8")) as { PATH: string; KEY: string | null };
			expect(env.PATH.split(path.delimiter)[0]).toBe(shellProbed);
			expect(env.KEY).toBe("present");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("passes the reply language as OMP_GUI_REPLY_LANGUAGE, resolved on every spawn", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-env-"));
		const envPath = path.join(tempDir, "language.txt");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(envPath)}, process.env.OMP_GUI_REPLY_LANGUAGE ?? "");\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		let language = "Korean";
		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin: binaryPath, version: "18.8.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: tempDir,
			replyLanguage: () => language,
		});
		let ready = Promise.withResolvers<void>();
		sidecar.on("status", ({ status }) => {
			if (status === "ready") ready.resolve();
		});
		const spawnedLanguage = () => fs.readFile(envPath, "utf8");
		try {
			sidecar.start();
			await ready.promise;
			expect(await spawnedLanguage()).toBe("Korean");
			language = "Japanese";
			ready = Promise.withResolvers<void>();
			sidecar.restart();
			await ready.promise;
			expect(await spawnedLanguage()).toBe("Japanese");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("spawns omp with OTLP telemetry export off, over whatever the user's environment says", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-otel-"));
		const envPath = path.join(tempDir, "otel.json");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(envPath)}, JSON.stringify({ disabled: process.env.OTEL_SDK_DISABLED ?? null }));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		setEnv("OTEL_SDK_DISABLED", "false");
		setEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318");
		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin: binaryPath, version: "18.8.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: tempDir,
			shellEnv: async () => ({ OTEL_SDK_DISABLED: "false" }),
		});
		const ready = Promise.withResolvers<void>();
		sidecar.on("status", ({ status }) => {
			if (status === "ready") ready.resolve();
		});
		try {
			sidecar.start();
			await ready.promise;
			// Stock's initTelemetryExport returns at once on exactly this value.
			expect(JSON.parse(await fs.readFile(envPath, "utf8"))).toEqual({ disabled: "true" });
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("pushes the current reply language over the gui-bridge on connect and on syncReplyLanguage()", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-bridge-"));
		const logPath = path.join(tempDir, "bridge.jsonl");
		const binaryPath = await writeFakeOmp(tempDir, loggingBridgeOmp(logPath));
		let language: string | undefined = "Korean";
		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin: binaryPath, version: "18.8.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: tempDir,
			bridgeDir: tempDir,
			replyLanguage: () => language,
		});
		const replyLanguageRequests = () => bridgeRequests(logPath, "reply_language_set");
		try {
			sidecar.start();
			await expect.poll(replyLanguageRequests, { timeout: 5_000, interval: 25 }).toEqual([{ language: "Korean" }]);
			language = undefined;
			sidecar.syncReplyLanguage();
			await expect
				.poll(replyLanguageRequests, { timeout: 5_000, interval: 25 })
				.toEqual([{ language: "Korean" }, { language: null }]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("reloadExtensions() sends extension_update.reload, then extension_update.reconnect with the names", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-extreload-"));
		const logPath = path.join(tempDir, "bridge.jsonl");
		const binaryPath = await writeFakeOmp(tempDir, loggingBridgeOmp(logPath));
		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin: binaryPath, version: "18.8.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: tempDir,
			bridgeDir: tempDir,
			replyLanguage: () => "Korean",
		});
		try {
			sidecar.start();
			// The connect-time push proves the bridge is up.
			await expect
				.poll(() => bridgeRequests(logPath, "reply_language_set"), { timeout: 5_000, interval: 25 })
				.toHaveLength(1);
			await sidecar.reloadExtensions({ reload: true, reconnect: ["alpha", "beta"] });
			expect(await bridgeRequests(logPath, "extension_update.reload")).toEqual([null]);
			expect(await bridgeRequests(logPath, "extension_update.reconnect")).toEqual([{ names: ["alpha", "beta"] }]);
			const log = await fs.readFile(logPath, "utf8");
			expect(log.indexOf("extension_update.reload")).toBeLessThan(log.indexOf("extension_update.reconnect"));

			await sidecar.reloadExtensions({ reload: false, reconnect: [] });
			expect(await bridgeRequests(logPath, "extension_update.reload")).toHaveLength(1);
			expect(await bridgeRequests(logPath, "extension_update.reconnect")).toHaveLength(1);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("passes the account-rotation mode and ledger at spawn and pushes the mode on connect and on syncAccountRotation()", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-rotation-"));
		const logPath = path.join(tempDir, "bridge.jsonl");
		const envPath = path.join(tempDir, "rotation.json");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`${loggingBridgeOmp(logPath)}\nfs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ mode: process.env.OMP_GUI_ACCOUNT_ROTATION ?? null, ledger: process.env.OMP_GUI_ACCOUNT_ROTATION_STATE ?? null }));`,
		);
		let mode: AccountRotationMode = "even";
		const ledger = path.join(tempDir, "account-rotation.json");
		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin: binaryPath, version: "18.8.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: tempDir,
			bridgeDir: tempDir,
			accountRotation: () => mode,
			accountRotationLedger: ledger,
		});
		const rotationRequests = () => bridgeRequests(logPath, "account_rotation_set");
		try {
			sidecar.start();
			await expect.poll(rotationRequests, { timeout: 5_000, interval: 25 }).toEqual([{ mode: "even" }]);
			expect(JSON.parse(await fs.readFile(envPath, "utf8"))).toEqual({ mode: "even", ledger });
			mode = "quota";
			sidecar.syncAccountRotation();
			await expect
				.poll(rotationRequests, { timeout: 5_000, interval: 25 })
				.toEqual([{ mode: "even" }, { mode: "quota" }]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("passes a set profile as OMP_GUI_USER_PROFILE and pushes it on connect and on syncUserProfile()", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-profile-"));
		const logPath = path.join(tempDir, "bridge.jsonl");
		const envPath = path.join(tempDir, "profile.txt");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`${loggingBridgeOmp(logPath)}\nfs.writeFileSync(${JSON.stringify(envPath)}, process.env.OMP_GUI_USER_PROFILE ?? "");`,
		);
		let profile: UserProfile = { name: "Sam", experience: "junior" };
		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin: binaryPath, version: "18.8.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: tempDir,
			bridgeDir: tempDir,
			userProfile: () => profile,
		});
		const profileRequests = () => bridgeRequests(logPath, "user_profile_set");
		try {
			sidecar.start();
			await expect.poll(profileRequests, { timeout: 5_000, interval: 25 }).toEqual([profile]);
			expect(JSON.parse(await fs.readFile(envPath, "utf8"))).toEqual({ name: "Sam", experience: "junior" });
			profile = { name: "", experience: null };
			sidecar.syncUserProfile();
			await expect.poll(profileRequests, { timeout: 5_000, interval: 25 }).toEqual([
				{ name: "Sam", experience: "junior" },
				{ name: "", experience: null },
			]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("passes the prompt-suggestion switches as OMP_GUI_NEXT_PROMPT and pushes them on connect and on syncNextPrompt()", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-next-prompt-"));
		const logPath = path.join(tempDir, "bridge.jsonl");
		const envPath = path.join(tempDir, "next-prompt.txt");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`${loggingBridgeOmp(logPath)}\nfs.writeFileSync(${JSON.stringify(envPath)}, process.env.OMP_GUI_NEXT_PROMPT ?? "unset");`,
		);
		let settings: NextPromptSettings = { suggestions: true, inline: true };
		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin: binaryPath, version: "18.8.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: tempDir,
			bridgeDir: tempDir,
			nextPrompt: () => settings,
		});
		const nextPromptRequests = () => bridgeRequests(logPath, "next_prompt_set");
		try {
			sidecar.start();
			await expect.poll(nextPromptRequests, { timeout: 5_000, interval: 25 }).toEqual([settings]);
			expect(JSON.parse(await fs.readFile(envPath, "utf8"))).toEqual({ suggestions: true, inline: true });
			settings = { suggestions: true, inline: false };
			sidecar.syncNextPrompt();
			await expect.poll(nextPromptRequests, { timeout: 5_000, interval: 25 }).toEqual([
				{ suggestions: true, inline: true },
				{ suggestions: true, inline: false },
			]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("passes a chosen delegation strength as OMP_GUI_DELEGATION, read on every spawn, and nothing for default", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-delegation-"));
		const envPath = path.join(tempDir, "delegation.txt");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(envPath)}, process.env.OMP_GUI_DELEGATION ?? "unset");\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		let mode: DelegationMode = "swarm";
		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin: binaryPath, version: "18.8.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: tempDir,
			delegation: () => mode,
		});
		const written = () => fs.readFile(envPath, "utf8").catch(() => "");
		try {
			sidecar.start();
			await expect.poll(written, { timeout: 5_000, interval: 25 }).toBe("swarm");
			await fs.rm(envPath);
			mode = "default";
			sidecar.restart();
			await expect.poll(written, { timeout: 5_000, interval: 25 }).toBe("unset");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});
});

/** A fake omp that serves the gui-bridge socket, answers `{}` and logs every request to `logPath`. */
function loggingBridgeOmp(logPath: string): string {
	return [
		'import * as fs from "node:fs";',
		'import * as net from "node:net";',
		"const server = net.createServer(socket => {",
		'\tsocket.setEncoding("utf8");',
		'\tlet buffer = "";',
		'\tsocket.on("data", (chunk: string) => {',
		"\t\tbuffer += chunk;",
		'\t\tfor (let i = buffer.indexOf("\\n"); i !== -1; i = buffer.indexOf("\\n")) {',
		"\t\t\tconst request = JSON.parse(buffer.slice(0, i)) as { id: unknown; method: string; params?: unknown };",
		"\t\t\tbuffer = buffer.slice(i + 1);",
		`\t\t\tfs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method: request.method, params: request.params ?? null }) + "\\n");`,
		'\t\t\tsocket.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + "\\n");',
		"\t\t}",
		"\t});",
		"});",
		"server.listen(process.env.OMP_GUI_BRIDGE, () => {",
		'\tprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");',
		"});",
		"process.stdin.resume();",
		'process.stdin.on("end", () => process.exit(0));',
	].join("\n");
}

/** Params of every `method` request the fake bridge logged, in order. */
async function bridgeRequests(logPath: string, method: string): Promise<unknown[]> {
	const text = await fs.readFile(logPath, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { method: string; params: unknown })
		.filter(request => request.method === method)
		.map(request => request.params);
}
