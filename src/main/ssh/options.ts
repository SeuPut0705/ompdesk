/**
 * How OMPdesk's own ssh processes (port forwards, port watch) connect: one
 * generated config (`-F`) whose first `Host *` block pins OMPdesk's private
 * known_hosts with `StrictHostKeyChecking ask` and no connection sharing, then
 * includes the user's ~/.ssh/config for everything else (HostName, User,
 * IdentityFile, ProxyJump). OpenSSH keeps the first value it reads, so the
 * user's file cannot loosen those options, and it hands `-F` to the ssh it
 * runs for each ProxyJump hop, so every hop is checked the same way (C150).
 * Unknown keys arrive as askpass questions (C147, main/ssh/askpass.ts).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SshPromptKind, SshTarget } from "../../shared/ssh-tools";

/** `ssh`, `ssh-add`, `ssh-keygen`: from PATH, or beside `OMP_GUI_SSH` (tests point it at a fake ssh). */
export function sshTool(name: "ssh" | "ssh-add" | "ssh-keygen"): string {
	const override = process.env.OMP_GUI_SSH;
	if (!override) return name;
	return name === "ssh" ? override : path.join(path.dirname(override), name);
}

const quote = (value: string) => `"${value.replace(/\\/g, "/")}"`;

/** Write `<dir>/config` and return its path and the known_hosts it pins. */
export async function writeSshConfig(dir: string, home: string): Promise<{ config: string; knownHosts: string }> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const knownHosts = path.join(dir, "known_hosts");
	const config = path.join(dir, "config");
	const userConfig = path.join(home, ".ssh", "config");
	await fs.writeFile(
		config,
		[
			"# Written by OMPdesk for its own port forwards; edits are overwritten.",
			"Host *",
			`  UserKnownHostsFile ${quote(knownHosts)}`,
			`  GlobalKnownHostsFile ${quote(knownHosts)}`,
			"  StrictHostKeyChecking ask",
			"  UpdateHostKeys no",
			"  ControlMaster no",
			"  ControlPath none",
			"  ServerAliveInterval 15",
			"  ServerAliveCountMax 3",
			"  ConnectTimeout 15",
			"  NumberOfPasswordPrompts 3",
			`Include ${quote(userConfig)}`,
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	return { config, knownHosts };
}

/** The destination arguments for a saved host (after `-F <config>`). */
export function targetArgs(target: SshTarget): string[] {
	return [
		...(target.port ? ["-p", String(target.port)] : []),
		...(target.username ? ["-l", target.username] : []),
		...(target.keyPath ? ["-i", target.keyPath] : []),
		"--",
		target.host,
	];
}

/** The listening TCP ports in one `ss -ltnH` / `netstat -ltn` / `lsof -iTCP -sTCP:LISTEN` listing, ascending. */
export function parseListeningPorts(listing: string): number[] {
	const ports = new Set<number>();
	for (const line of listing.split("\n")) {
		if (!line.trim() || /^(Proto|Active|COMMAND|State|Netid)\b/i.test(line.trim())) continue;
		for (const token of line.trim().split(/\s+/)) {
			const match = /^(?:\[[^\]]*\]|[\w.*%-]*)[:.](\d{1,5})$/.exec(token);
			if (!match) continue;
			const port = Number(match[1]);
			if (port > 0 && port < 65536) ports.add(port);
			break;
		}
	}
	return [...ports].sort((a, b) => a - b);
}

/** What one askpass question from ssh asks for. */
export function classifyPrompt(text: string): {
	kind: SshPromptKind;
	fingerprint: string | null;
	host: string | null;
} {
	if (/authenticity of host|continue connecting/i.test(text)) {
		return {
			kind: "hostKey",
			fingerprint: /\b(SHA256:[A-Za-z0-9+/=]+|MD5(?::[0-9a-f]{2})+)/.exec(text)?.[1] ?? null,
			host: /authenticity of host '([^']+)'/i.exec(text)?.[1] ?? null,
		};
	}
	const kind: SshPromptKind = /passphrase/i.test(text)
		? "passphrase"
		: /verification code|one-time|otp|token|authenticator/i.test(text)
			? "code"
			: /password/i.test(text)
				? "password"
				: "other";
	return { kind, fingerprint: null, host: null };
}

/** Why an ssh process ended, from its stderr: retrying cannot help with a changed key or refused login. */
export function classifyFailure(stderr: string): { kind: "hostKeyChanged" | "refused" | "dropped"; message: string } {
	const lines = stderr
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line && !line.startsWith("@") && !/^debug\d?:/.test(line));
	const message = lines.at(-1) ?? "ssh exited";
	if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(stderr))
		return { kind: "hostKeyChanged", message: lines.find(line => /fingerprint/i.test(line)) ?? message };
	if (
		/Permission denied|Host key verification failed|Too many authentication failures|bind.*Address already in use|cannot listen to port/i.test(
			stderr,
		)
	)
		return { kind: "refused", message };
	return { kind: "dropped", message };
}

/** The hostnames ssh would check keys for: the target's `hostname` and every ProxyJump hop's (`ssh -G` output). */
export function knownHostNames(resolved: string): { hostname: string | null; port: number; jumps: string[] } {
	const value = (key: string) => new RegExp(`^${key} (.+)$`, "m").exec(resolved)?.[1]?.trim() ?? null;
	const jump = value("proxyjump");
	return {
		hostname: value("hostname"),
		port: Number(value("port") ?? 22) || 22,
		jumps:
			jump && jump !== "none"
				? jump.split(",").map(hop =>
						hop
							.trim()
							.replace(/^ssh:\/\//, "")
							.replace(/^[^@]*@/, ""),
					)
				: [],
	};
}
