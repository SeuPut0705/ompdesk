import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_USER_DATA_NAME, migrateLegacyUserData } from "./legacy-user-data";

// Real fs throughout; tests inject one-off rename/copy failures.
vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, renameSync: vi.fn(actual.renameSync), cpSync: vi.fn(actual.cpSync) };
});

const locked = () => {
	throw Object.assign(new Error("locked"), { code: "EPERM" });
};

let root: string;
let userData: string;
let legacy: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-user-data-"));
	userData = path.join(root, "ompdesk");
	legacy = path.join(root, LEGACY_USER_DATA_NAME);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function seedLegacy(): void {
	fs.mkdirSync(path.join(legacy, "Local Storage"), { recursive: true });
	fs.writeFileSync(path.join(legacy, "prefs.json"), '{"lastProject":"/work"}');
	fs.writeFileSync(path.join(legacy, "Local Storage", "leveldb.log"), "state");
}

function expectMigrated(): void {
	expect(fs.readFileSync(path.join(userData, "prefs.json"), "utf8")).toBe('{"lastProject":"/work"}');
	expect(fs.readFileSync(path.join(userData, "Local Storage", "leveldb.log"), "utf8")).toBe("state");
}

describe("migrateLegacyUserData", () => {
	it("moves the legacy sibling when userData does not exist", () => {
		seedLegacy();
		expect(migrateLegacyUserData(userData)).toBe("moved");
		expectMigrated();
		expect(fs.existsSync(legacy)).toBe(false);
	});

	it("treats the empty userData Electron pre-creates as fresh", () => {
		seedLegacy();
		fs.mkdirSync(userData);
		expect(migrateLegacyUserData(userData)).toBe("moved");
		expectMigrated();
	});

	it("leaves a used userData and the legacy profile alone", () => {
		seedLegacy();
		fs.mkdirSync(userData);
		fs.writeFileSync(path.join(userData, "prefs.json"), "{}");
		expect(migrateLegacyUserData(userData)).toBe("skipped");
		expect(fs.readFileSync(path.join(userData, "prefs.json"), "utf8")).toBe("{}");
		expect(fs.existsSync(path.join(legacy, "prefs.json"))).toBe(true);
	});

	it("skips when there is no legacy profile", () => {
		expect(migrateLegacyUserData(userData)).toBe("skipped");
		expect(fs.existsSync(userData)).toBe(false);
	});

	it("skips a legacy path that is a file, or the userData directory itself", () => {
		fs.writeFileSync(legacy, "not a profile");
		expect(migrateLegacyUserData(userData)).toBe("skipped");
		fs.mkdirSync(userData);
		expect(migrateLegacyUserData(userData, userData)).toBe("skipped");
	});

	it("falls back to a staged copy when the rename fails, keeping the legacy profile", () => {
		seedLegacy();
		fs.mkdirSync(`${userData}.migrating`);
		fs.writeFileSync(path.join(`${userData}.migrating`, "stale"), "from a crashed copy");
		vi.mocked(fs.renameSync).mockImplementationOnce(locked);
		expect(migrateLegacyUserData(userData)).toBe("copied");
		expectMigrated();
		expect(fs.existsSync(path.join(userData, "stale"))).toBe(false);
		expect(fs.existsSync(`${userData}.migrating`)).toBe(false);
		expect(fs.existsSync(path.join(legacy, "prefs.json"))).toBe(true);
	});

	it("recreates an empty userData and rethrows when both rename and copy fail", () => {
		seedLegacy();
		vi.mocked(fs.renameSync).mockImplementationOnce(locked);
		vi.mocked(fs.cpSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
		});
		expect(() => migrateLegacyUserData(userData)).toThrow("disk full");
		expect(fs.readdirSync(userData)).toEqual([]);
		expect(fs.existsSync(`${userData}.migrating`)).toBe(false);
		expect(fs.existsSync(path.join(legacy, "prefs.json"))).toBe(true);
	});
});
