/**
 * Windows' Mandatory ASLR (Exploit protection › System settings › Force randomization for images) kills every
 * MSYS fork with 0xC0000142, so Git for Windows' sh cannot start a child (detect.ts `probeGitShell`). The fix the
 * user may choose is a per-image override, for exactly the MSYS executables under `<git>\usr` of the Git OMPdesk
 * uses: Force randomization always off in each image's Image File Execution Options entry with `FilterFullPath`
 * (the entry `Set-ProcessMitigation -Name <absolute exe>` keeps). The system-wide setting and every other
 * program stay as they are. Both directions need elevation: one UAC prompt.
 *
 * Undo puts back exactly what Fix changed: Fix reads each image's ForceRelocateImages state first (the low nibble
 * of MitigationOptions' second byte, bits 8–11: 0 not set, 1 always on, 2 always off, 3 always on and require
 * relocations), skips an image already off, and returns the ones it changed with their prior state, which
 * service.ts keeps in `git-aslr.json`. Undo edits only that nibble of only those images, and only while it still
 * says off: DEP, CFG and every other mitigation on the entry stay as they are, and no entry is ever removed.
 * Without a record (a Fix of an earlier build) there is nothing to undo exactly, so Undo is not offered.
 * Proved on a real Windows by the opt-in `git-aslr.windows.test.ts`.
 */
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { z } from "zod";
import type { GitAslrAction } from "../../shared/setup";
import { powershellScript, psQuote, type SpawnSpec } from "./plans";

/** ForceRelocateImages before Fix changed it. "off" never appears: an image already off is not changed. */
const RelocatePrior = z.enum(["notset", "on", "on-require-relocs"]);
export type RelocatePrior = z.infer<typeof RelocatePrior>;
const GitAslrImage = z.object({ path: z.string(), prior: RelocatePrior });
export type GitAslrImage = z.infer<typeof GitAslrImage>;
/** `git-aslr.json`: the images Fix changed, per Git root (as detected). */
const GitAslrRecord = z.object({ version: z.literal(1), roots: z.record(z.string(), z.array(GitAslrImage)) });
export type GitAslrRecord = z.infer<typeof GitAslrRecord>;

const PRIOR_NIBBLE: Record<RelocatePrior, number> = { notset: 0, on: 1, "on-require-relocs": 3 };
const NIBBLE_PRIOR: Record<number, RelocatePrior> = { 0: "notset", 1: "on", 3: "on-require-relocs" };
/** In userData, beside setup's state file. */
export const GIT_ASLR_RECORD = "git-aslr.json";

const rootKey = (root: string) => win32.normalize(root).replace(/\\+$/, "").toLowerCase();

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text.replace(/^\uFEFF/, "").trim());
	} catch {
		return undefined;
	}
}

export function parseGitAslrRecord(text: string): GitAslrRecord {
	const parsed = GitAslrRecord.safeParse(parseJson(text));
	if (!parsed.success) return { version: 1, roots: {} };
	const roots: GitAslrRecord["roots"] = {};
	for (const [root, images] of Object.entries(parsed.data.roots)) if (images.length > 0) roots[rootKey(root)] = images;
	return { version: 1, roots };
}

export function recordedImages(record: GitAslrRecord, root: string): GitAslrImage[] {
	return record.roots[rootKey(root)] ?? [];
}

/** Adds what a Fix changed; an image already recorded keeps its first prior state (the one before OMPdesk). */
export function withFixed(record: GitAslrRecord, root: string, changed: GitAslrImage[]): GitAslrRecord {
	const images = [...recordedImages(record, root)];
	const known = new Set(images.map(image => image.path.toLowerCase()));
	for (const image of changed) if (!known.has(image.path.toLowerCase())) images.push(image);
	return { version: 1, roots: { ...record.roots, [rootKey(root)]: images } };
}

/** Drops what an Undo restored; a root with nothing left goes. */
export function withRestored(record: GitAslrRecord, root: string, restored: string[]): GitAslrRecord {
	const done = new Set(restored.map(path => path.toLowerCase()));
	const left = recordedImages(record, root).filter(image => !done.has(image.path.toLowerCase()));
	const roots = { ...record.roots };
	if (left.length > 0) roots[rootKey(root)] = left;
	else delete roots[rootKey(root)];
	return { version: 1, roots };
}

export async function readGitAslrRecord(file: string): Promise<GitAslrRecord> {
	return parseGitAslrRecord(await readFile(file, "utf8").catch(() => ""));
}

export async function writeGitAslrRecord(file: string, record: GitAslrRecord): Promise<void> {
	if (Object.keys(record.roots).length === 0) {
		await rm(file, { force: true });
		return;
	}
	await writeFile(file, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
}

/** The elevated step's own output: Fix → `[{path, prior}]` (prior as the nibble), Undo → the restored paths. */
const FixOutput = z.array(z.object({ path: z.string(), prior: z.number() }));

export function parseFixOutput(text: string): GitAslrImage[] {
	const parsed = FixOutput.safeParse([parseJson(text) ?? []].flat());
	if (!parsed.success) return [];
	return parsed.data.flatMap(row => {
		const prior = NIBBLE_PRIOR[row.prior];
		return prior ? [{ path: row.path, prior }] : [];
	});
}

export function parseUndoOutput(text: string): string[] {
	const parsed = z.array(z.string()).safeParse([parseJson(text) ?? []].flat());
	return parsed.success ? parsed.data : [];
}

/** Undo's input file: the recorded images with their prior nibble. */
export function undoInput(images: GitAslrImage[]): string {
	return JSON.stringify(images.map(image => ({ path: image.path, prior: PRIOR_NIBBLE[image.prior] })));
}

const PS_HELPERS = [
	"$ifeo = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options'",
	"function Find-Entry([string]$image) {",
	"\t$key = Join-Path $ifeo ([System.IO.Path]::GetFileName($image))",
	"\tif (-not (Test-Path -LiteralPath $key)) { return $null }",
	"\tforeach ($sub in @(Get-ChildItem -LiteralPath $key)) { if ([string]$sub.GetValue('FilterFullPath') -ieq $image) { return $sub } }",
	"\treturn $null",
	"}",
	"function Get-Options($entry) { if (-not $entry) { return $null }; $o = $entry.GetValue('MitigationOptions'); if ($o -is [byte[]] -and $o.Length -ge 2) { return $o }; return $null }",
	"function Set-Relocate($entry, [byte[]]$options, [int]$value) {",
	"\t$options[1] = [byte](($options[1] -band 0xF0) -bor ($value -band 0x0F))",
	"\t[Microsoft.Win32.Registry]::SetValue($entry.Name, 'MitigationOptions', $options, [Microsoft.Win32.RegistryValueKind]::Binary)",
	"}",
];

/**
 * The script run elevated. Never `Set-ProcessMitigation`: on Windows 11 its `-Disable ForceRelocateImages`
 * rewrites the whole entry and drops DEP, CFG and the rest (seen on this check's real run), so both directions
 * edit only bits 8–11 of the entry's MitigationOptions. Fix: list `<root>\usr`'s executables, read each one's
 * nibble, set it to off where it is not off yet (creating the `FilterFullPath` entry as Windows does when there
 * is none) and append `{path, prior}` to `output` after every change, so a failure part way still leaves the
 * record of what changed. Undo: read `input` (`undoInput`), set each nibble back where it still says off, append
 * each handled path to `output`.
 */
export function gitAslrElevatedScript(
	root: string,
	action: GitAslrAction,
	files: { input: string; output: string },
): string {
	const write = `ConvertTo-Json -InputObject @($done) -Compress | Set-Content -LiteralPath ${psQuote(files.output)} -Encoding UTF8`;
	const body =
		action === "fix"
			? [
					`$images = @(Get-ChildItem -LiteralPath ${psQuote(win32.join(root, "usr"))} -Recurse -File -Filter *.exe | ForEach-Object { $_.FullName })`,
					"foreach ($image in $images) {",
					"\t$entry = Find-Entry $image",
					"\t$options = Get-Options $entry",
					"\t$prior = if ($options) { $options[1] -band 0x0F } else { 0 }",
					"\tif ($prior -eq 2) { continue }",
					"\tif (-not $entry) {",
					"\t\t$parent = Join-Path $ifeo ([System.IO.Path]::GetFileName($image))",
					"\t\tif (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -Path $parent -Force }",
					"\t\tSet-ItemProperty -LiteralPath $parent -Name UseFilter -Value 1 -Type DWord",
					"\t\t$entry = New-Item -Path (Join-Path $parent ('{' + [guid]::NewGuid() + '}'))",
					"\t\tSet-ItemProperty -LiteralPath $entry.PSPath -Name FilterFullPath -Value $image",
					"\t}",
					"\tif (-not $options) { $options = New-Object byte[] 24 }",
					"\tSet-Relocate $entry $options 2",
					"\t$done += [pscustomobject]@{ path = $image; prior = $prior }",
					`\t${write}`,
					"}",
				]
			: [
					// Windows PowerShell's ConvertFrom-Json emits a JSON array as one object; foreach enumerates it.
					`foreach ($e in (Get-Content -LiteralPath ${psQuote(files.input)} -Raw -Encoding UTF8 | ConvertFrom-Json)) {`,
					"\t$entry = Find-Entry ([string]$e.path)",
					"\t$options = Get-Options $entry",
					"\tif ($options -and ($options[1] -band 0x0F) -eq 2) { Set-Relocate $entry $options ([int]$e.prior) }",
					"\t$done += [string]$e.path",
					`\t${write}`,
					"}",
				];
	return ["$ErrorActionPreference = 'Stop'", ...PS_HELPERS, "$done = @()", write, ...body].join("\n");
}

/** Elevates `gitAslrElevatedScript`; the outer script fails when it failed, a refused UAC prompt too. */
export function gitAslrSpawn(
	systemRoot: string,
	root: string,
	action: GitAslrAction,
	files: { input: string; output: string },
): SpawnSpec {
	const encoded = Buffer.from(gitAslrElevatedScript(root, action, files), "utf16le").toString("base64");
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
 * randomization always off (MitigationOptions bits 8–11 = 2, PROCESS_CREATION_MITIGATION_POLICY_FORCE_RELOCATE_IMAGES_ALWAYS_OFF).
 */
export function gitAslrOverridden(query: string, root: string): boolean {
	const target = win32.join(root, "usr", "bin", "sh.exe").toLowerCase();
	for (const block of query.split(/\r?\n\s*\r?\n/)) {
		const path = /FilterFullPath\s+REG_SZ\s+(.+)/.exec(block)?.[1]?.trim().toLowerCase();
		const options = /MitigationOptions\s+REG_BINARY\s+([0-9A-Fa-f]+)/.exec(block)?.[1];
		if (path !== target || !options) continue;
		return (Number.parseInt(options.slice(2, 4), 16) & 0xf) === 2;
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
