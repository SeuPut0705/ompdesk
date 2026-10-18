import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinSnapshot, pruneSnapshots, publishSnapshot, stampHash } from "./out-snapshot";

const HASH = "0123456789abcdef0123456789abcdef";
let root: string;

function built(hash = HASH, main = "main();\n"): void {
	fs.rmSync(path.join(root, "out"), { recursive: true, force: true });
	fs.mkdirSync(path.join(root, "out/main"), { recursive: true });
	fs.writeFileSync(path.join(root, "out/main/index.js"), main);
	fs.writeFileSync(path.join(root, "out/.build-stamp.json"), JSON.stringify({ hash, out: {} }));
}

const age = (file: string, ms: number) => {
	const then = new Date(Date.now() - ms);
	fs.utimesSync(file, then, then);
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-snapshot-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("out snapshots", () => {
	it("reads the build's input hash, and none without a finished build", () => {
		expect(stampHash(root)).toBeUndefined();
		built();
		expect(stampHash(root)).toBe(HASH);
	});

	it("publishes out-<12 hex of the hash>/ as a copy a later build does not change", () => {
		built();
		const dest = publishSnapshot(root);
		expect(dest).toBe(path.join(root, "out-0123456789ab"));
		expect(fs.readFileSync(path.join(root, "out-0123456789ab/main/index.js"), "utf8")).toBe("main();\n");
		built("fedcba9876543210fedcba9876543210", "patched();\n");
		expect(publishSnapshot(root)).toBe(path.join(root, "out-fedcba987654"));
		expect(fs.readFileSync(path.join(dest ?? "", "main/index.js"), "utf8")).toBe("main();\n");
		expect(fs.readFileSync(path.join(root, "out/main/index.js"), "utf8")).toBe("patched();\n");
	});

	it("publishes nothing without a build stamp", () => {
		expect(publishSnapshot(root)).toBeUndefined();
	});

	it("deletes a snapshot no run touched for 30 minutes, never the current one or a used one", () => {
		built();
		const old = publishSnapshot(root) ?? "";
		const used = path.join(root, "out-aaaaaaaaaaaa");
		fs.mkdirSync(used);
		fs.writeFileSync(path.join(used, ".used"), "");
		age(path.join(old, ".used"), 31 * 60_000);
		built("fedcba9876543210fedcba9876543210");
		const current = publishSnapshot(root) ?? "";
		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(used)).toBe(true);
		age(path.join(current, ".used"), 31 * 60_000);
		pruneSnapshots(root, current);
		expect(fs.existsSync(current)).toBe(true);
	});

	it("pins the snapshot of the current build, or what OMP_GUI_E2E_OUT already names", () => {
		built();
		publishSnapshot(root);
		expect(pinSnapshot(root, {})).toBe(path.join(root, "out-0123456789ab"));
		expect(pinSnapshot(root, { OMP_GUI_E2E_OUT: "/elsewhere/out" })).toBe("/elsewhere/out");
	});
});
