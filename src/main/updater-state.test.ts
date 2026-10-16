import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyRepoAccess,
	DOWNLOAD_IDLE_TIMEOUT_MS,
	firstUpdateToken,
	githubApiHeaders,
	installerPartialPath,
	isSwappableBundleLocation,
	macBundlePath,
	macDownloadName,
	planInstallerTransfer,
	SingleTransfer,
	StageBundleError,
	SWAP_SCRIPT,
	settleFailedUpdateCheck,
	settleIncompleteUpdateCheck,
	sha512FileBase64,
	stageBundleFromDmg,
	sweepInstallerPartials,
	type ToolRunner,
	TransferStalledError,
	withinIdle,
} from "./updater-state";

describe("installer transfer concurrency", () => {
	it("never runs a second transfer while one is in flight", async () => {
		const transfers = new SingleTransfer();
		const { promise: gate, resolve: finish } = Promise.withResolvers<void>();
		const transfer = vi.fn(() => gate);

		const first = transfers.start(transfer);
		const second = transfers.start(transfer);
		expect(transfers.running).toBe(true);
		expect(transfer).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);

		finish();
		await first;
		expect(transfers.running).toBe(false);
	});

	it("lets a retry start once the previous transfer failed", async () => {
		const transfers = new SingleTransfer();
		await expect(transfers.start(async () => Promise.reject(new Error("offline")))).rejects.toThrow();
		expect(transfers.running).toBe(false);

		const retry = vi.fn(async () => {});
		await transfers.start(retry);
		expect(retry).toHaveBeenCalledTimes(1);
	});
});

describe("installer transfer idle timeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts a step that delivers nothing and fails with a stall", async () => {
		vi.useFakeTimers();
		const abort = vi.fn();
		const stalled = withinIdle(new Promise<never>(() => {}), DOWNLOAD_IDLE_TIMEOUT_MS, abort);
		const outcome = expect(stalled).rejects.toBeInstanceOf(TransferStalledError);

		await vi.advanceTimersByTimeAsync(DOWNLOAD_IDLE_TIMEOUT_MS);
		await outcome;
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("reports the stall even when the abort rejects the step synchronously", async () => {
		vi.useFakeTimers();
		const { promise: step, reject } = Promise.withResolvers<never>();
		const outcome = expect(
			withinIdle(step, DOWNLOAD_IDLE_TIMEOUT_MS, () => reject(new Error("aborted"))),
		).rejects.toBeInstanceOf(TransferStalledError);

		await vi.advanceTimersByTimeAsync(DOWNLOAD_IDLE_TIMEOUT_MS);
		await outcome;
	});

	it("passes a step that arrives in time through and never aborts it", async () => {
		vi.useFakeTimers();
		const abort = vi.fn();
		const chunk = withinIdle(Promise.resolve("bytes"), DOWNLOAD_IDLE_TIMEOUT_MS, abort);

		await expect(chunk).resolves.toBe("bytes");
		await vi.advanceTimersByTimeAsync(DOWNLOAD_IDLE_TIMEOUT_MS * 2);
		expect(abort).not.toHaveBeenCalled();
	});
});

describe("update check terminal state", () => {
	it("does not leave a completed manual check spinning forever", () => {
		expect(settleIncompleteUpdateCheck({ state: "checking" }, true)).toEqual({
			state: "error",
			message: "Couldn't finish the update check. Try again later.",
		});
	});

	it("keeps real updater terminal states intact and makes background misses silent", () => {
		const available = { state: "available", version: "0.7.2", mode: "automatic" } as const;
		expect(settleIncompleteUpdateCheck(available, true)).toBe(available);
		expect(settleIncompleteUpdateCheck({ state: "checking" }, false)).toEqual({ state: "idle" });
	});
});

describe("macOS DMG download name", () => {
	it("puts the version back into the version-free release asset's local name", () => {
		expect(macDownloadName("0.18.0")).toBe("ompdesk-0.18.0-arm64.dmg");
	});

	it("names it so the Downloads sweep still recognizes its partials", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-dmg-name-"));
		try {
			const stale = `${macDownloadName("0.18.0")}.partial`;
			fs.writeFileSync(path.join(dir, stale), "");
			const active = path.join(dir, `${macDownloadName("0.18.1")}.partial`);
			expect(await sweepInstallerPartials(dir, active)).toEqual([stale]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Symlinks (the DMG's /Applications link) need extra privileges on Windows; staging is macOS-only anyway.
describe.runIf(process.platform !== "win32")("macOS DMG staging", () => {
	let dir: string;
	let calls: string[][];
	/** Bundle id and short version each fake bundle reports through `plutil`. */
	let plists: Map<string, Record<string, string>>;
	let failures: Set<string>;

	const OWN = "/Applications/OMPdesk.app";
	const options = (run: ToolRunner, version = "0.18.0") => ({
		dmgPath: path.join(dir, "ompdesk-0.18.0-arm64.dmg"),
		stagingDir: path.join(dir, "updates", "0.18.0"),
		mountRoot: path.join(dir, "mnt"),
		version,
		ownBundle: OWN,
		run,
		fs: fs.promises,
	});

	/** hdiutil/ditto/codesign/plutil stand-ins: `attach` lays out the DMG's contents at the mount point. */
	const fakeTools =
		(dmgContents: (mountPoint: string) => void): ToolRunner =>
		async (command, args) => {
			const tool = path.basename(command);
			calls.push([tool, ...args]);
			const verb = tool === "hdiutil" ? `hdiutil ${args[0]}${args.includes("-force") ? " -force" : ""}` : tool;
			if (failures.has(verb)) return { ok: false, stdout: "" };
			if (verb === "hdiutil attach") dmgContents(args[args.indexOf("-mountpoint") + 1] ?? "");
			// Unmounting leaves the mount point an empty directory.
			if (args[0] === "detach") {
				const mountPoint = args[args.length - 1] ?? "";
				for (const entry of fs.readdirSync(mountPoint))
					fs.rmSync(path.join(mountPoint, entry), { recursive: true });
			}
			if (tool === "ditto") fs.cpSync(args[0] ?? "", args[1] ?? "", { recursive: true });
			if (tool === "plutil") {
				const plist = args[args.length - 1] ?? "";
				const value = plists.get(path.dirname(path.dirname(plist)))?.[args[1] ?? ""];
				return value === undefined ? { ok: false, stdout: "" } : { ok: true, stdout: `${value}\n` };
			}
			return { ok: true, stdout: "" };
		};

	const releaseDmg = (mountPoint: string) => {
		fs.mkdirSync(path.join(mountPoint, "OMPdesk.app", "Contents"), { recursive: true });
		fs.writeFileSync(path.join(mountPoint, "OMPdesk.app", "Contents", "marker"), "new");
		fs.symlinkSync("/Applications", path.join(mountPoint, "Applications"));
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stage-"));
		calls = [];
		failures = new Set();
		plists = new Map([[OWN, { CFBundleIdentifier: "com.seuput.ompdesk", CFBundleShortVersionString: "0.17.4" }]]);
		plists.set(path.join(dir, "updates", "0.18.0", "OMPdesk.app"), {
			CFBundleIdentifier: "com.seuput.ompdesk",
			CFBundleShortVersionString: "0.18.0",
		});
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("mounts read-only without Finder, copies the app out, detaches, then verifies it", async () => {
		const staged = await stageBundleFromDmg(options(fakeTools(releaseDmg)));

		expect(staged).toBe(path.join(dir, "updates", "0.18.0", "OMPdesk.app"));
		expect(fs.readFileSync(path.join(staged, "Contents", "marker"), "utf8")).toBe("new");
		// The /Applications symlink in the image is never mistaken for the bundle.
		expect(fs.readdirSync(path.dirname(staged))).toEqual(["OMPdesk.app"]);
		const [attach, copy, detach, verify] = calls;
		expect(attach?.slice(0, 5)).toEqual(["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen"]);
		expect(attach?.at(-1)).toBe(path.join(dir, "ompdesk-0.18.0-arm64.dmg"));
		expect(copy?.[0]).toBe("ditto");
		expect(detach?.slice(0, 2)).toEqual(["hdiutil", "detach"]);
		expect(verify).toEqual(["codesign", "--verify", "--deep", "--strict", staged]);
		// The temporary mount point is gone once the image is detached.
		expect(fs.readdirSync(path.join(dir, "mnt"))).toEqual([]);
	});

	it("rejects a bundle of another version and removes what it staged", async () => {
		const failure = stageBundleFromDmg(options(fakeTools(releaseDmg), "0.18.1"));
		await expect(failure).rejects.toMatchObject({ reason: "verify" });
		await expect(failure).rejects.toBeInstanceOf(StageBundleError);
		expect(fs.existsSync(path.join(dir, "updates", "0.18.0"))).toBe(false);
	});

	it("rejects a bundle whose signature does not verify", async () => {
		failures.add("codesign");
		await expect(stageBundleFromDmg(options(fakeTools(releaseDmg)))).rejects.toMatchObject({ reason: "verify" });
		expect(fs.existsSync(path.join(dir, "updates", "0.18.0"))).toBe(false);
	});

	it("rejects a bundle with another bundle id", async () => {
		plists.set(path.join(dir, "updates", "0.18.0", "OMPdesk.app"), {
			CFBundleIdentifier: "com.example.other",
			CFBundleShortVersionString: "0.18.0",
		});
		await expect(stageBundleFromDmg(options(fakeTools(releaseDmg)))).rejects.toMatchObject({ reason: "verify" });
	});

	it("fails as a mount error when hdiutil cannot attach, and copies nothing", async () => {
		failures.add("hdiutil attach");
		await expect(stageBundleFromDmg(options(fakeTools(releaseDmg)))).rejects.toMatchObject({ reason: "mount" });
		expect(calls.map(call => call[0])).toEqual(["hdiutil"]);
		expect(fs.readdirSync(path.join(dir, "mnt"))).toEqual([]);
	});

	it("detaches an image that holds no app", async () => {
		const noApp = (mountPoint: string) => fs.symlinkSync("/Applications", path.join(mountPoint, "Applications"));
		await expect(stageBundleFromDmg(options(fakeTools(noApp)))).rejects.toMatchObject({ reason: "missing" });
		expect(calls.at(-1)?.slice(0, 2)).toEqual(["hdiutil", "detach"]);
	});

	it("forces the detach when a plain detach is refused", async () => {
		failures.add("hdiutil detach");
		await stageBundleFromDmg(options(fakeTools(releaseDmg)));
		expect(calls.filter(call => call[1] === "detach").map(call => call.slice(1, 3))).toEqual([
			["detach", expect.any(String)],
			["detach", "-force"],
		]);
	});
});

describe("in-place macOS swap", () => {
	it("finds the bundle only from its own Contents/MacOS executable", () => {
		expect(macBundlePath("/Applications/ompdesk.app/Contents/MacOS/ompdesk")).toBe("/Applications/ompdesk.app");
		expect(macBundlePath("/usr/local/bin/ompdesk")).toBeUndefined();
	});

	it("refuses read-only disk images and translocated copies", () => {
		expect(isSwappableBundleLocation("/Applications/ompdesk.app")).toBe(true);
		expect(isSwappableBundleLocation("/Users/me/Applications/ompdesk.app")).toBe(true);
		expect(isSwappableBundleLocation("/Volumes/ompdesk 0.2.1/ompdesk.app")).toBe(false);
		expect(isSwappableBundleLocation("/private/var/folders/x/AppTranslocation/ABC/d/ompdesk.app")).toBe(false);
	});

	describe.runIf(process.platform === "darwin")("swap script", () => {
		let dir: string;
		const makeApp = (appPath: string, marker: string) => {
			fs.mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
			fs.writeFileSync(path.join(appPath, "Contents", "marker"), marker);
		};
		// Async: the test's own event loop must stay free to reap the fake app
		// process, or it lingers as a zombie that still answers `kill -0`.
		const runSwap = (pid: number, src: string, dest: string) => {
			const { promise, resolve } = Promise.withResolvers<number | null>();
			spawn("/bin/bash", ["-c", SWAP_SCRIPT, "swap", String(pid), src, dest, "0", path.join(dir, "swap.log")]).on(
				"exit",
				resolve,
			);
			return promise;
		};

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-swap-"));
		});
		afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

		it("waits for the app to exit, then replaces it and leaves no debris", async () => {
			const dest = path.join(dir, "Applications", "ompdesk.app");
			const src = path.join(dir, "updates", "0.2.2", "ompdesk.app");
			makeApp(dest, "old");
			makeApp(src, "new");
			const app = spawn("/bin/sleep", ["0.6"]);
			const startedAt = Date.now();
			const status = await runSwap(app.pid ?? 0, src, dest);

			expect(status).toBe(0);
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
			expect(fs.readFileSync(path.join(dest, "Contents", "marker"), "utf8")).toBe("new");
			expect(fs.readdirSync(path.dirname(dest))).toEqual(["ompdesk.app"]);
			expect(fs.existsSync(src)).toBe(false);
			expect(fs.readFileSync(path.join(dir, "swap.log"), "utf8")).toContain("installed");
		});

		it("leaves the installed app untouched when the staged bundle is gone", async () => {
			const dest = path.join(dir, "ompdesk.app");
			makeApp(dest, "old");
			const status = await runSwap(999_999, path.join(dir, "missing", "ompdesk.app"), dest);

			expect(status).toBe(1);
			expect(fs.readFileSync(path.join(dest, "Contents", "marker"), "utf8")).toBe("old");
			expect(fs.readdirSync(dir).sort()).toEqual(["ompdesk.app", "swap.log"]);
		});
	});
});

describe("manual installer transfer", () => {
	it("continues a partial only when the server answers for exactly the bytes it holds", () => {
		expect(planInstallerTransfer(500, { status: 206, contentRange: "bytes 500-999/1000" })).toEqual({
			offset: 500,
			append: true,
		});
	});

	it("rewrites from the top whenever appended bytes would corrupt the installer", () => {
		const restarts = [
			planInstallerTransfer(0, { status: 206, contentRange: "bytes 0-999/1000" }),
			planInstallerTransfer(500, { status: 200 }),
			planInstallerTransfer(500, { status: 206 }),
			planInstallerTransfer(500, { status: 206, contentRange: "bytes 0-999/1000" }),
		];
		for (const plan of restarts) expect(plan).toEqual({ offset: 0, append: false });
	});

	it("hashes every byte of an installer larger than its read buffer", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-installer-"));
		try {
			for (const size of [1024 * 1024 + 7, 2 * 1024 * 1024]) {
				const bytes = new Uint8Array(size);
				for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
				const file = path.join(dir, `blob-${size}`);
				fs.writeFileSync(file, bytes);
				expect(await sha512FileBase64(file)).toBe(createHash("sha512").update(bytes).digest("base64"));
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("installer debris sweep", () => {
	const ENTRIES = [
		"ompdesk-0.9.7.dmg.download-4242",
		"ompdesk-0.9.8.dmg.download-99",
		"ompdesk-0.9.8.dmg.partial",
		"ompdesk-0.9.7 (1).dmg.partial",
		"holiday.dmg.partial",
		"notes.partial",
		"install-ompdesk.dmg.download-1",
		"ompdesk-0.9.9-arm64.dmg",
	];
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-downloads-"));
		for (const name of ENTRIES) fs.writeFileSync(path.join(dir, name), "x");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("clears PID-keyed orphans that no restart could ever continue", async () => {
		expect((await sweepInstallerPartials(dir)).sort()).toEqual([
			"ompdesk-0.9.7.dmg.download-4242",
			"ompdesk-0.9.8.dmg.download-99",
		]);
	});

	it("keeps every current-name partial while nothing is downloading", async () => {
		await sweepInstallerPartials(dir);
		expect(fs.existsSync(path.join(dir, "ompdesk-0.9.8.dmg.partial"))).toBe(true);
	});

	it("drops a superseded release's partial once the current download names its own", async () => {
		const active = installerPartialPath(path.join(dir, "ompdesk-0.9.9-arm64.dmg"));
		fs.writeFileSync(active, "x");
		const removed = await sweepInstallerPartials(dir, active);
		expect(removed.sort()).toEqual([
			"ompdesk-0.9.7 (1).dmg.partial",
			"ompdesk-0.9.7.dmg.download-4242",
			"ompdesk-0.9.8.dmg.download-99",
			"ompdesk-0.9.8.dmg.partial",
		]);
		expect(fs.existsSync(active)).toBe(true);
	});

	it("leaves files the updater never wrote where they are", async () => {
		const active = installerPartialPath(path.join(dir, "ompdesk-0.9.9-arm64.dmg"));
		await sweepInstallerPartials(dir, active);
		await sweepInstallerPartials(dir);
		for (const name of [
			"holiday.dmg.partial",
			"notes.partial",
			"install-ompdesk.dmg.download-1",
			"ompdesk-0.9.9-arm64.dmg",
		]) {
			expect(fs.existsSync(path.join(dir, name)), name).toBe(true);
		}
	});

	it("says nothing when the downloads directory doesn't exist yet", async () => {
		expect(await sweepInstallerPartials(path.join(dir, "absent"))).toEqual([]);
	});
});

describe("release access with an optional token", () => {
	it("takes the first token in precedence order and never runs later lookups", async () => {
		const calls: string[] = [];
		const lookup = (name: string, value: string | undefined) => () => {
			calls.push(name);
			return value;
		};
		expect(
			await firstUpdateToken([
				["env", lookup("env", "  ")],
				["gh", lookup("gh", "gho_abc\n")],
				["stored", lookup("stored", "stored-token")],
			]),
		).toEqual({ token: "gho_abc", source: "gh" });
		expect(calls).toEqual(["env", "gh"]);
		expect(await firstUpdateToken([["env", () => undefined]])).toBeUndefined();
	});

	it("treats GitHub's 404 for an invisible private repo as no access", () => {
		expect(classifyRepoAccess(200)).toBe("ok");
		expect(classifyRepoAccess(401)).toBe("invalid");
		expect(classifyRepoAccess(403)).toBe("denied");
		expect(classifyRepoAccess(404)).toBe("denied");
		expect(classifyRepoAccess(502)).toBe("network");
	});

	it("sends no Authorization header without a token and a Bearer one with a token", () => {
		expect(githubApiHeaders(undefined)).toEqual({
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
		});
		expect(githubApiHeaders("", "application/octet-stream")).not.toHaveProperty("authorization");
		expect(githubApiHeaders("gho_abc", "application/octet-stream")).toEqual({
			accept: "application/octet-stream",
			authorization: "Bearer gho_abc",
			"x-github-api-version": "2022-11-28",
		});
	});

	it("reads GitHub's hourly rate limit as a failed request, not as missing access", () => {
		expect(classifyRepoAccess(403, true)).toBe("network");
		expect(classifyRepoAccess(403, false)).toBe("denied");
		expect(classifyRepoAccess(429)).toBe("network");
	});

	it("asks for a token only when an anonymous request is refused", () => {
		expect(settleFailedUpdateCheck("missing", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "404", "0.1.0", false)).toEqual(
			{
				state: "auth-required",
				reason: "missing",
			},
		);
		expect(settleFailedUpdateCheck("ok", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "404", "0.1.0", false)).toEqual({
			state: "not-available",
			version: "0.1.0",
		});
	});

	it("turns a failed check into sign-in guidance, up to date, or a quiet background error", () => {
		expect(settleFailedUpdateCheck("denied", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "404", "0.1.0", false)).toEqual({
			state: "auth-required",
			reason: "denied",
		});
		expect(settleFailedUpdateCheck("invalid", undefined, "401", "0.1.0", true)).toEqual({
			state: "auth-required",
			reason: "invalid",
		});
		expect(settleFailedUpdateCheck("ok", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "404", "0.1.0", true)).toEqual({
			state: "not-available",
			version: "0.1.0",
		});
		expect(settleFailedUpdateCheck("network", undefined, "offline", "0.1.0", false)).toEqual({
			state: "error",
			message: "offline",
			showInBanner: false,
		});
		expect(settleFailedUpdateCheck("ok", "ERR_X", "boom", "0.1.0", true)).toEqual({
			state: "error",
			message: "boom",
			showInBanner: true,
		});
	});
});
