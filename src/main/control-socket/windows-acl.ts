/**
 * Windows access control for the control socket. Node's `net` (libuv) creates a named pipe with the default security
 * descriptor (other accounts may read, anonymous included) and cannot set a DACL or `PIPE_REJECT_REMOTE_CLIENTS`. So
 * after the pipe listens, Windows PowerShell (.NET's `PipeSecurity`, no native module and no P/Invoke) opens it as its
 * owner and replaces its DACL with one ACE for this user and a deny for NETWORK (S-1-5-2), which every remote logon
 * carries: the access-check equivalent of rejecting remote clients. The DACL is the pipe's, shared by every instance
 * libuv makes. The control folder gets the POSIX rules' counterpart: owned by this user (or Administrators/SYSTEM),
 * no allow ACE for anyone else, else made private (protected, this user and SYSTEM) and reported, so the token is
 * replaced.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { powershellScript, psQuote } from "../setup/plans";

const run = promisify(execFile);

/** Runs a PowerShell script and resolves with its standard output. */
export type PowerShell = (script: string) => Promise<string>;

/**
 * Windows PowerShell 5.1 with no cmdlet module in play (the scripts use .NET alone): a `PSModulePath` inherited from
 * PowerShell 7 makes 5.1 fail to load its own modules ("Get-Acl … could not be loaded", seen on the CI runner), so it
 * is dropped. A failure rejects with what PowerShell wrote to stderr, never the encoded script.
 */
export const runPowerShell: PowerShell = async script => {
	const spec = powershellScript({ systemRoot: process.env.SystemRoot ?? "C:\\Windows" }, script);
	const { PSModulePath: _modules, ...env } = process.env;
	try {
		const { stdout } = await run(spec.file, spec.args, { encoding: "utf8", windowsHide: true, timeout: 30_000, env });
		return stdout;
	} catch (error) {
		const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
		const text = stderr
			.replace(/^#< CLIXML\s*/, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/_x000D__x000A_/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		throw new Error(
			`PowerShell failed: ${text || (error instanceof Error ? error.message.split("\n")[0] : String(error))}`,
		);
	}
};

const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const NETWORK = "S-1-5-2";

/** The pipe's name as .NET wants it: without `\\.\pipe\`. */
function pipeName(path: string): string {
	const match = /^\\\\\.\\pipe\\(.+)$/.exec(path);
	if (!match?.[1]) throw new Error(`${path} is no local named pipe`);
	return match[1];
}

/** The pipe's access section as SDDL, then `|<this user's SID>`; `apply` first replaces it. */
function pipeScript(path: string, apply: boolean): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		"$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
		"$rights = [System.IO.Pipes.PipeAccessRights]'ReadData, ReadPermissions, ChangePermissions'",
		`$client = [System.IO.Pipes.NamedPipeClientStream]::new('.', ${psQuote(pipeName(path))}, $rights, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::None, [System.IO.HandleInheritability]::None)`,
		"$client.Connect(10000)",
		"try {",
		...(apply
			? [
					"  $security = [System.IO.Pipes.PipeSecurity]::new()",
					`  $security.SetSecurityDescriptorSddlForm("D:P(D;;GA;;;${NETWORK})(A;;GA;;;$me)", 'Access')`,
					"  $client.SetAccessControl($security)",
				]
			: []),
		"  [Console]::Out.WriteLine($client.GetAccessControl().GetSecurityDescriptorSddlForm('Access') + '|' + $me)",
		"} finally { $client.Dispose() }",
	].join("\n");
}

/** The ACEs of an SDDL access section: allow (`A`) or deny (`D`) and the SID or SDDL alias they name. */
function aces(sddl: string): { type: string; sid: string }[] {
	return [...sddl.matchAll(/\((A|D);[^;]*;[^;]*;[^;]*;[^;]*;([^);]+)\)/g)].map(match => ({
		type: match[1] ?? "",
		sid: match[2] ?? "",
	}));
}

/**
 * What is wrong with a pipe's DACL for the control socket, or null: protected (no inherited ACE), an allow ACE for
 * `me` alone, and a deny for NETWORK.
 */
export function pipeDaclProblem(sddl: string, me: string): string | null {
	if (!/^D:P/.test(sddl)) return `the pipe's DACL is not protected (${sddl})`;
	const list = aces(sddl);
	const others = list.filter(ace => ace.type === "A" && ace.sid !== me);
	if (others.length > 0) return `the pipe allows ${others.map(ace => ace.sid).join(", ")}`;
	if (!list.some(ace => ace.type === "A" && ace.sid === me)) return "the pipe does not allow this user";
	if (!list.some(ace => ace.type === "D" && (ace.sid === "NU" || ace.sid === NETWORK)))
		return "the pipe does not refuse network logons";
	return null;
}

/** The pipe's access section and this user's SID, read as its owner. */
export async function readPipeDacl(path: string, powershell: PowerShell = runPowerShell) {
	const [sddl = "", me = ""] = (await powershell(pipeScript(path, false))).trim().split("|");
	return { sddl, me };
}

/** Makes the pipe this user's alone, local only; rejects unless the DACL read back says so. */
export async function securePipe(path: string, powershell: PowerShell = runPowerShell): Promise<void> {
	const [sddl = "", me = ""] = (await powershell(pipeScript(path, true))).trim().split("|");
	const problem = pipeDaclProblem(sddl, me);
	if (problem) throw new Error(`Securing ${path} failed: ${problem}`);
}

/** `ok`, `repaired` (it was open to others: replace what it holds), or `foreign` (another user owns it). */
export type FolderVerdict = "ok" | "repaired" | "foreign";

function folderScript(dir: string, file: string): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		`$dir = ${psQuote(dir)}`,
		`$file = ${psQuote(file)}`,
		"$sid = [System.Security.Principal.SecurityIdentifier]",
		"$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
		`$trusted = @($me, '${SYSTEM}', '${ADMINISTRATORS}')`,
		"function Loose($acl) {",
		"  foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {",
		"    if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) { return $true }",
		"  }",
		"  return $false",
		"}",
		"$folder = [System.IO.DirectoryInfo]::new($dir)",
		"if ($trusted -notcontains $folder.GetAccessControl().GetOwner($sid).Value) { 'foreign'; return }",
		"$loose = (Loose $folder.GetAccessControl()) -or ([System.IO.File]::Exists($file) -and (Loose ([System.IO.FileInfo]::new($file).GetAccessControl())))",
		"if (-not $loose) { 'ok'; return }",
		"$closed = [System.Security.AccessControl.DirectorySecurity]::new()",
		"$closed.SetAccessRuleProtection($true, $false)",
		`foreach ($who in @($me, '${SYSTEM}')) {`,
		"  $closed.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($who), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))",
		"}",
		"$folder.SetAccessControl($closed)",
		"'repaired'",
	].join("\n");
}

/**
 * Checks the control folder (and the token file in it) on Windows: another user's folder is `foreign`; one that
 * allows anyone but this user, SYSTEM and Administrators is made private and `repaired`.
 */
export async function secureFolder(
	dir: string,
	tokenFile: string,
	powershell: PowerShell = runPowerShell,
): Promise<FolderVerdict> {
	const verdict = (await powershell(folderScript(dir, tokenFile))).trim();
	if (verdict === "ok" || verdict === "repaired" || verdict === "foreign") return verdict;
	throw new Error(`Checking ${dir} failed: ${verdict || "no answer"}`);
}
