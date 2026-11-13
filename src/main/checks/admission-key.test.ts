import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	admissionDevice,
	keyFile,
	loadAdmissionKey,
	publishAdmissionKey,
	type RunGh,
	type SecretBox,
} from "./admission-key";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "admission-key-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

/** A keystore that marks what it encrypted, so a test sees the file never holds the key in clear. */
const box = (available = true): SecretBox => ({
	available: () => available,
	encrypt: text => Buffer.from(`sealed:${Buffer.from(text).toString("base64")}`),
	decrypt: data => {
		const text = data.toString();
		if (!text.startsWith("sealed:")) throw new Error("not this keystore's");
		return Buffer.from(text.slice("sealed:".length), "base64").toString();
	},
});

describe("this computer's admission key", () => {
	it("is made once, kept sealed, and named after this computer's device id in capitals", async () => {
		const dir = fs.mkdtempSync(path.join(temp, "u-"));
		const first = await loadAdmissionKey(dir, "0123456789abcdefghjkmnpqrs", box());
		expect(first?.device).toBe("0123456789ABCDEFGHJKMNPQRS");
		expect(first?.key).toMatch(/^[0-9a-f]{64}$/);
		const stored = fs.readFileSync(keyFile(dir), "utf8");
		expect(stored).not.toContain(first?.key ?? "?");
		if (process.platform !== "win32") expect(fs.statSync(keyFile(dir)).mode & 0o777).toBe(0o600);
		expect(await loadAdmissionKey(dir, "0123456789abcdefghjkmnpqrs", box())).toEqual(first);
	});

	it("is none without a keystore or a device id a secret can be named after", async () => {
		const dir = fs.mkdtempSync(path.join(temp, "u-"));
		expect(await loadAdmissionKey(dir, "abc", box(false))).toBeNull();
		expect(fs.existsSync(keyFile(dir))).toBe(false);
		expect(await loadAdmissionKey(dir, "", box())).toBeNull();
		expect(admissionDevice("mac-mini")).toBeNull();
	});
});

describe("publishing the key", () => {
	const admission = { device: "MACBOOK", key: "ab".repeat(32) };
	function gh(variable: { code: number; stdout?: string; stderr?: string }) {
		const calls: { args: string[]; stdin?: string }[] = [];
		const run: RunGh = async (args, stdin) => {
			calls.push({ args, stdin });
			if (args[0] === "variable" && args[1] === "get")
				return { code: variable.code, stdout: variable.stdout ?? "", stderr: variable.stderr ?? "" };
			return { code: 0, stdout: "", stderr: "" };
		};
		return { calls, run };
	}

	it("sets this computer's secret from stdin and adds it to the devices the gate checks", async () => {
		const { calls, run } = gh({ code: 0, stdout: "MINI\n" });
		expect(await publishAdmissionKey("o/r", admission, run)).toEqual(["MINI", "MACBOOK"]);
		expect(calls[0]).toEqual({
			args: ["secret", "set", "CHECKS_ADMISSION_KEY_MACBOOK", "--repo", "o/r"],
			stdin: admission.key,
		});
		expect(calls.flatMap(call => call.args).join(" ")).not.toContain(admission.key);
		expect(calls[2]?.args).toEqual([
			"variable",
			"set",
			"CHECKS_ADMISSION_DEVICES",
			"--repo",
			"o/r",
			"--body",
			"MINI MACBOOK",
		]);
	});

	it("starts the list when there is none, and never drops it on another failure", async () => {
		const missing = gh({ code: 1, stderr: "HTTP 404: Not Found" });
		expect(await publishAdmissionKey("o/r", admission, missing.run)).toEqual(["MACBOOK"]);
		const down = gh({ code: 1, stderr: "error connecting to api.github.com" });
		await expect(publishAdmissionKey("o/r", admission, down.run)).rejects.toThrow("gh variable get");
		expect(down.calls.some(call => call.args[1] === "set" && call.args[0] === "variable")).toBe(false);
	});
});
