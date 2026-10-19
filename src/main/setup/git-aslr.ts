/**
 * Windows' Mandatory ASLR (Exploit protection › System settings › Force randomization for images) kills every
 * MSYS fork with 0xC0000142, so Git for Windows' sh cannot start a child (detect.ts `probeGitShell`). The fix the
 * user may choose is a per-image override, for exactly the MSYS executables under `<git>\usr` of the Git OMPdesk
 * uses: `Set-ProcessMitigation -Name <absolute exe> -Disable ForceRelocateImages`, stored by Windows as an
 * Image File Execution Options entry with `FilterFullPath`. Undo removes those entries. The system-wide setting
 * and every other program stay as they are. Both need elevation: one UAC prompt.
 */
import { execFile } from "node:child_process";
import { win32 } from "node:path";
import type { GitAslrAction } from "../../shared/setup";
import { powershellScript, psQuote, type SpawnSpec } from "./plans";

/**
 * The elevated step: list `<root>\usr`'s executables, set (or remove) each one's override, write the list to
 * `log`. The outer script only elevates it and fails when it failed; a refused UAC prompt fails too.
 */
export function gitAslrSpawn(systemRoot: string, root: string, action: GitAslrAction, log: string): SpawnSpec {
	const change =
		action === "fix"
			? "Set-ProcessMitigation -Name $image -Disable ForceRelocateImages"
			: "Set-ProcessMitigation -Name $image -Remove";
	const elevated = [
		"$ErrorActionPreference = 'Stop'",
		`$images = @(Get-ChildItem -LiteralPath ${psQuote(win32.join(root, "usr"))} -Recurse -File -Filter *.exe | ForEach-Object { $_.FullName })`,
		`foreach ($image in $images) { ${change} }`,
		`$images | Set-Content -LiteralPath ${psQuote(log)} -Encoding UTF8`,
	].join("\n");
	const encoded = Buffer.from(elevated, "utf16le").toString("base64");
	const outer = [
		"$ErrorActionPreference = 'Stop'",
		`$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${encoded}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
		"if ($proc.ExitCode -ne 0) { throw ('The elevated step exited with ' + $proc.ExitCode) }",
	].join("\n");
	return powershellScript({ systemRoot }, outer);
}

const IFEO = String.raw`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\sh.exe`;

/**
 * Whether `reg query <IFEO>\sh.exe /s` output holds an override for `<root>\usr\bin\sh.exe` with Force
 * randomization always off (MitigationOptions bits 8–9 = 2, PROCESS_CREATION_MITIGATION_POLICY_FORCE_RELOCATE_IMAGES_ALWAYS_OFF).
 */
export function gitAslrOverridden(query: string, root: string): boolean {
	const target = win32.join(root, "usr", "bin", "sh.exe").toLowerCase();
	for (const block of query.split(/\r?\n\s*\r?\n/)) {
		const path = /FilterFullPath\s+REG_SZ\s+(.+)/.exec(block)?.[1]?.trim().toLowerCase();
		const options = /MitigationOptions\s+REG_BINARY\s+([0-9A-Fa-f]+)/.exec(block)?.[1];
		if (path !== target || !options) continue;
		return (Number.parseInt(options.slice(2, 4), 16) & 0x3) === 2;
	}
	return false;
}

/** Reads the override's state from the registry (no elevation needed to read). */
export function readGitAslrOverride(root: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	execFile("reg.exe", ["query", IFEO, "/s"], { windowsHide: true, timeout: 15_000 }, (error, stdout) =>
		resolve(!error && gitAslrOverridden(stdout, root)),
	);
	return promise;
}
