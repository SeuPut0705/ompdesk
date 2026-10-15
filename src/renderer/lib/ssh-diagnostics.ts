/**
 * The text "Copy diagnostics" puts on the clipboard after a failed SSH test:
 * the error and OpenSSH's `-v` trace with everything that names the server or
 * the person replaced, so it can be pasted into an issue or a chat.
 */
import type { RpcSshTestResult } from "../../shared/rpc-types";

export interface SshDiagnosticsTarget {
	name: string;
	host: string;
	username?: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSshText(text: string, target: SshDiagnosticsTarget): string {
	const words: Array<[string, string]> = [
		[target.host, "<server>"],
		[target.name, "<server>"],
		...(target.username ? ([[target.username, "<user>"]] as Array<[string, string]>) : []),
	];
	let out = text
		// Home folders name the local account (key paths, known_hosts).
		.replace(/\/Users\/[^/\s"']+/g, "~")
		.replace(/\/home\/[^/\s"']+/g, "~")
		.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, "~");
	// Longest first, so a host that contains the alias is replaced whole. Whole tokens only: an alias
	// like "ssh" must not turn "OpenSSH" into "Open<server>".
	for (const [word, mask] of words
		.filter(([word]) => word.trim().length > 0)
		.sort((a, b) => b[0].length - a[0].length)) {
		out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(word)}(?![\\w-]|\\.\\w)`, "gi"), mask);
	}
	return (
		out
			// The resolved address ssh prints ("Connecting to <server> [203.0.113.7] port 22").
			.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<address>")
			.replace(/\[[0-9a-f]*:[0-9a-f:]+(?:%[\w.]+)?\]/gi, "[<address>]")
			// Server key fingerprints identify the machine.
			.replace(/SHA256:[A-Za-z0-9+/]{20,}=*/g, "SHA256:<fingerprint>")
	);
}

export function sshDiagnostics(result: RpcSshTestResult, target: SshDiagnosticsTarget): string {
	const lines = [
		`SSH connection test: ${result.ok ? "succeeded" : "failed"} at ${result.checkedAt}`,
		...(result.error ? [`Error: ${result.error}`] : []),
		...(result.log ? ["", result.log] : []),
	];
	return redactSshText(lines.join("\n"), target);
}
