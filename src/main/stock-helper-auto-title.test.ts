import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTO_TITLE_ENTRY, TITLE_TRIGGER } from "../../resources/gui-bridge/modes/auto-title-contracts";
import { listedAutoTitle } from "../../resources/gui-bridge/stock-helper/session-auto-title";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-auto-title-list-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** Stock's journal: the fixed-width title slot, the header, then entries, one JSON line each. */
const slot = (title: string, source: "auto" | "user") =>
	JSON.stringify({ type: "title", v: 1, title, source, updatedAt: "2026-11-01T00:00:00Z", pad: "    " });
const header = JSON.stringify({ type: "session", id: "s1", cwd: "/w", timestamp: "2026-11-01T00:00:00Z" });
const change = (title: string, source: "auto" | "user", trigger?: string) =>
	JSON.stringify({ type: "title_change", id: title, timestamp: "2026-11-01T00:00:00Z", title, source, trigger });
const beside = (title: string) => JSON.stringify({ type: "custom", customType: AUTO_TITLE_ENTRY, data: { title } });
const message = (text: string) =>
	JSON.stringify({ type: "message", message: { role: "user", content: text, timestamp: 1 } });

async function journal(name: string, lines: string[]): Promise<string> {
	const file = path.join(dir, name);
	await fs.writeFile(file, `${lines.join("\n")}\n`);
	return file;
}

let listings = 0;
/** One listing of the journal: its size now and a stamp no earlier listing had. */
async function listed(file: string): Promise<string | undefined> {
	const { size } = await fs.stat(file);
	return listedAutoTitle(file, size, `${++listings}:${size}`);
}

describe("the automatic title a session list row shows beside a typed name", () => {
	it("is the newest automatic title while the name is typed, and follows entries appended later", async () => {
		const file = await journal("a.jsonl", [
			slot("My name", "user"),
			header,
			change("Fix login bug", "auto"),
			message("x".repeat(70_000)),
			change("My name", "user"),
		]);
		expect(await listed(file)).toBe("Fix login bug");
		await fs.appendFile(file, `${message("more")}\n${beside("Migrate build to Vite")}\n`);
		expect(await listed(file)).toBe("Migrate build to Vite");
		// A line still being written is not read yet.
		await fs.appendFile(file, beside("Ship the release notes").slice(0, 30));
		expect(await listed(file)).toBe("Migrate build to Vite");
		await fs.appendFile(file, `${beside("Ship the release notes").slice(30)}\n`);
		expect(await listed(file)).toBe("Ship the release notes");
	});

	it("is none without a typed name, when it equals the name, and once the title is automatic again", async () => {
		const automatic = await journal("b.jsonl", [
			slot("Fix login bug", "auto"),
			header,
			change("Fix login bug", "auto"),
		]);
		expect(await listed(automatic)).toBeUndefined();

		const same = await journal("c.jsonl", [
			slot("Fix login bug", "user"),
			header,
			change("Fix login bug", "auto"),
			change("Fix login bug", "user"),
		]);
		expect(await listed(same)).toBeUndefined();

		const regenerated = await journal("d.jsonl", [
			slot("Fresh", "user"),
			header,
			change("Fix login bug", "auto"),
			change("Typed", "user"),
			change("Fresh", "user", TITLE_TRIGGER),
		]);
		expect(await listed(regenerated)).toBeUndefined();
	});

	it("reads a journal rewritten shorter from its start again", async () => {
		const file = await journal("e.jsonl", [
			slot("Mine", "user"),
			header,
			change("Old auto", "auto"),
			change("Mine", "user"),
			beside("Later auto"),
		]);
		expect(await listed(file)).toBe("Later auto");
		await fs.writeFile(
			file,
			`${[slot("Mine", "user"), header, change("Other", "auto"), change("Mine", "user")].join("\n")}\n`,
		);
		expect(await listed(file)).toBe("Other");
	});
});
