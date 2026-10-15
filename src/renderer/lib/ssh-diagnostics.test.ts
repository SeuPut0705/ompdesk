import { describe, expect, it } from "vitest";
import { redactSshText, sshDiagnostics } from "./ssh-diagnostics";

const target = { name: "builder", host: "build.example.com", username: "deploy" };

describe("SSH diagnostics", () => {
	it("hides the server, the account, addresses, home folders and host key fingerprints", () => {
		const log = [
			"debug1: Reading configuration data /Users/alice/.ssh/config",
			"debug1: Connecting to build.example.com [203.0.113.7] port 22.",
			"debug1: Connecting to build.example.com [2001:db8::1] port 22.",
			"debug1: Server host key: ssh-ed25519 SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
			"debug1: Authenticating to build.example.com:22 as 'deploy'",
			"deploy@build.example.com: Permission denied (publickey).",
			"Host builder matched",
			"C:\\Users\\Alice\\.ssh\\id_ed25519",
		].join("\n");
		const out = redactSshText(log, target);
		expect(out).not.toMatch(/alice|build\.example\.com|203\.0\.113\.7|2001:db8|deploy|builder|abcdefghij/i);
		expect(out).toContain("~/.ssh/config");
		expect(out).toContain("Connecting to <server> [<address>] port 22.");
		expect(out).toContain("SHA256:<fingerprint>");
		expect(out).toContain("<user>@<server>: Permission denied");
	});

	it("replaces whole tokens only, so a short alias never eats ordinary words", () => {
		expect(redactSshText("OpenSSH_9.6 via ssh", { name: "ssh", host: "10.0.0.2" })).toBe("OpenSSH_9.6 via <server>");
	});

	it("puts the outcome, the error and the log in one block", () => {
		const text = sshDiagnostics(
			{ name: "builder", ok: false, checkedAt: "2026-10-15T00:00:00.000Z", error: "timed out", log: "debug1: hi" },
			target,
		);
		expect(text).toBe("SSH connection test: failed at 2026-10-15T00:00:00.000Z\nError: timed out\n\ndebug1: hi");
	});
});
