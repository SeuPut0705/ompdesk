import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyRepoAccess,
	firstUpdateToken,
	hasStableMacSigningIdentity,
	installerPartialPath,
	planInstallerTransfer,
	selectMacInstaller,
	settleFailedUpdateCheck,
	settleIncompleteUpdateCheck,
	sha512FileBase64,
	sweepInstallerPartials,
} from "./updater-state";

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

describe("manual macOS installer selection", () => {
	const files = [
		{ url: "ompdesk-0.8.4-arm64-mac.zip", sha512: "arm-zip" },
		{ url: "ompdesk-0.8.4-arm64.dmg", sha512: "arm-dmg", size: 120 },
		{ url: "https://example.test/ompdesk-0.8.4.dmg", sha512: "other-dmg", size: 140 },
	];

	it("selects the exact Apple Silicon DMG", () => {
		expect(selectMacInstaller(files, "0.8.4")).toEqual({
			name: "ompdesk-0.8.4-arm64.dmg",
			sha512: "arm-dmg",
			size: 120,
		});
	});

	it("rejects ZIPs, other DMG names, and installers for a different release", () => {
		expect(selectMacInstaller(files, "0.8.5")).toBeUndefined();
		expect(
			selectMacInstaller(
				files.filter(file => !file.url.endsWith("arm64.dmg")),
				"0.8.4",
			),
		).toBeUndefined();
	});
});

describe("macOS signing identity", () => {
	it("keeps Squirrel only for a certificate-backed stable identity", () => {
		expect(
			hasStableMacSigningIdentity(
				"Authority=Developer ID Application: Example Corp (TEAM123456)\nTeamIdentifier=TEAM123456",
			),
		).toBe(true);
		expect(hasStableMacSigningIdentity("Signature=adhoc\nTeamIdentifier=not set")).toBe(false);
		expect(hasStableMacSigningIdentity("TeamIdentifier=TEAM123456")).toBe(false);
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

describe("private release repo authentication", () => {
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
