import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyProxyPreference } from "./preference-ci";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const applied = `${JSON.stringify({ event: "session.pref", name: "proxy", applied: true })}\n`;
async function log(initial = applied) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "preference-proof-"));
	dirs.push(dir);
	const file = path.join(dir, "shell.log.jsonl");
	await writeFile(file, initial);
	return file;
}

describe("CEF preference evidence", () => {
	it("rejects API success when only an earlier launch or startup readback exists", async () => {
		const file = await log();
		await expect(verifyProxyPreference(file, async () => ({ ok: true }))).rejects.toThrow("fresh");
	});
	it("accepts the new applied readback after the awaited invocation", async () => {
		const file = await log();
		await expect(verifyProxyPreference(file, () => appendFile(file, applied))).resolves.toMatchObject({
			applied: true,
			records: 1,
		});
	});
	it("rejects a failed readback even after an applied record", async () => {
		const file = await log();
		await expect(
			verifyProxyPreference(file, () =>
				appendFile(file, `${applied}{"event":"session.pref","name":"proxy","applied":false}\n`),
			),
		).rejects.toThrow("not applied");
	});
	it("does not confuse another preference with proxy readback", async () => {
		const file = await log();
		await expect(
			verifyProxyPreference(file, () =>
				appendFile(file, '{"event":"session.pref","name":"spellcheck","applied":true}\n'),
			),
		).rejects.toThrow("No fresh");
	});
	it("rejects truncated or replaced launch logs", async () => {
		const file = await log(applied + applied);
		await expect(verifyProxyPreference(file, () => writeFile(file, applied))).rejects.toThrow("replaced");
	});
	it("rejects partial JSON evidence", async () => {
		const file = await log();
		await expect(verifyProxyPreference(file, () => appendFile(file, '{"event":"session.pref"'))).rejects.toThrow(
			"complete",
		);
	});
	it("propagates invocation failure even if a readback was logged", async () => {
		const file = await log();
		await expect(
			verifyProxyPreference(file, async () => {
				await appendFile(file, applied);
				throw new Error("session operation failed");
			}),
		).rejects.toThrow("session operation failed");
	});
});
