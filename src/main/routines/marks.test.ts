import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import { FileMarks } from "./marks";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, RM_TEMP);
});

async function file(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "routine-marks-"));
	dirs.push(dir);
	return join(dir, "routine-marks.json");
}

describe("FileMarks", () => {
	it("hands the next launch the marks this one kept, for the trigger as it was set only", async () => {
		const path = await file();
		const first = new FileMarks(path);
		first.set("r1", "git main", { head: "aaa" });
		first.set("r2", "files /p", { listing: null });
		first.drop(["r2"]);
		first.dispose();

		const next = new FileMarks(path);
		expect(next.get("r1", "git main")).toEqual({ head: "aaa" });
		expect(next.get("r1", "git dev")).toBeUndefined();
		expect(next.ids()).toEqual(["r1"]);
		next.dispose();
	});

	it("starts empty from a file that does not parse", async () => {
		const path = await file();
		await writeFile(path, "{not json");
		const marks = new FileMarks(path);
		expect(marks.ids()).toEqual([]);
		marks.dispose();
	});
});
