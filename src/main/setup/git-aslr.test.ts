import { describe, expect, it } from "vitest";
import { gitAslrOverridden, gitAslrSpawn } from "./git-aslr";

const decode = (encoded: string) => Buffer.from(encoded, "base64").toString("utf16le");

/** The outer script (run by setup) and the script it elevates. */
function scripts(args: string[]): { outer: string; elevated: string } {
	const outer = decode(args[args.indexOf("-EncodedCommand") + 1] ?? "");
	return { outer, elevated: decode(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(outer)?.[1] ?? "") };
}

describe("gitAslrSpawn", () => {
	const root = "C:\\Program Files\\Git";
	const log = "C:\\Users\\a\\AppData\\Roaming\\ompdesk\\git-aslr.log";

	it("elevates one PowerShell step that sets the override on every MSYS image of that Git, and logs the list", () => {
		const spec = gitAslrSpawn("C:\\Windows", root, "fix", log);
		expect(spec.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		const { outer, elevated } = scripts(spec.args);
		expect(outer).toContain("-Verb RunAs");
		expect(elevated).toContain(
			"Get-ChildItem -LiteralPath 'C:\\Program Files\\Git\\usr' -Recurse -File -Filter *.exe",
		);
		expect(elevated).toContain("Set-ProcessMitigation -Name $image -Disable ForceRelocateImages");
		expect(elevated).toContain(`Set-Content -LiteralPath '${log}'`);
		// Never the system-wide setting.
		expect(elevated).not.toMatch(/-System/);
	});

	it("undoes exactly those images' overrides", () => {
		const { elevated } = scripts(gitAslrSpawn("C:\\Windows", root, "undo", log).args);
		expect(elevated).toContain("Set-ProcessMitigation -Name $image -Remove");
		expect(elevated).not.toContain("-Disable");
		expect(elevated).not.toMatch(/-System/);
	});

	it("quotes a path with a quote in it", () => {
		const { elevated } = scripts(gitAslrSpawn("C:\\Windows", "C:\\O'Brien\\Git", "fix", log).args);
		expect(elevated).toContain("'C:\\O''Brien\\Git\\usr'");
	});
});

describe("gitAslrOverridden", () => {
	const query = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\sh.exe
    UseFilter    REG_DWORD    0x1

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\sh.exe\\{7a215fff-e151-d290-08ca-af287bbaf5fb}
    FilterFullPath    REG_SZ    C:\\Program Files\\Git\\usr\\bin\\sh.exe
    MitigationOptions    REG_BINARY    000200000000000000000000000000000000000000000000
`;

	it("finds the override on that Git's sh.exe only, with Force randomization off", () => {
		expect(gitAslrOverridden(query, "C:\\Program Files\\Git")).toBe(true);
		expect(gitAslrOverridden(query, "c:\\program files\\git")).toBe(true);
		expect(gitAslrOverridden(query, "D:\\PortableGit")).toBe(false);
		expect(gitAslrOverridden(query.replace("0002", "0001"), "C:\\Program Files\\Git")).toBe(false);
		expect(gitAslrOverridden("", "C:\\Program Files\\Git")).toBe(false);
	});
});
