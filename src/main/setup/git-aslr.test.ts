import { describe, expect, it } from "vitest";
import {
	gitAslrOverridden,
	gitAslrSpawn,
	parseFixOutput,
	parseGitAslrRecord,
	parseUndoOutput,
	recordedImages,
	undoInput,
	withFixed,
	withRestored,
} from "./git-aslr";

const decode = (encoded: string) => Buffer.from(encoded, "base64").toString("utf16le");

/** The outer script (run by setup) and the script it elevates. */
function scripts(args: string[]): { outer: string; elevated: string } {
	const outer = decode(args[args.indexOf("-EncodedCommand") + 1] ?? "");
	return { outer, elevated: decode(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(outer)?.[1] ?? "") };
}

describe("gitAslrSpawn", () => {
	const root = "C:\\Program Files\\Git";
	const files = { input: "C:\\u\\ompdesk\\git-aslr-in.json", output: "C:\\u\\ompdesk\\git-aslr-out.json" };

	it("elevates one step that turns only ForceRelocateImages off on that Git's MSYS images and reports the prior state", () => {
		const spec = gitAslrSpawn("C:\\Windows", root, "fix", files);
		expect(spec.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		const { outer, elevated } = scripts(spec.args);
		expect(outer).toContain("-Verb RunAs");
		expect(elevated).toContain(
			"Get-ChildItem -LiteralPath 'C:\\Program Files\\Git\\usr' -Recurse -File -Filter *.exe",
		);
		expect(elevated).toContain("if ($prior -eq 2) { continue }");
		expect(elevated).toContain("Set-Relocate $entry $options 2");
		expect(elevated).toContain("($options[1] -band 0xF0)");
		expect(elevated).toContain(`Set-Content -LiteralPath '${files.output}'`);
		// Set-ProcessMitigation rewrites the whole entry (DEP, CFG lost), and nothing system-wide.
		expect(elevated).not.toContain("Set-ProcessMitigation");
		expect(elevated).not.toMatch(/-System|-Remove|Remove-Item/);
	});

	it("undoes only the recorded images' ForceRelocateImages bits, never a whole entry", () => {
		const { elevated } = scripts(gitAslrSpawn("C:\\Windows", root, "undo", files).args);
		expect(elevated).toContain(`Get-Content -LiteralPath '${files.input}'`);
		expect(elevated).toContain("-eq 2) { Set-Relocate $entry $options ([int]$e.prior) }");
		expect(elevated).not.toContain("Get-ChildItem -LiteralPath 'C:\\Program Files\\Git\\usr'");
		expect(elevated).not.toContain("Set-ProcessMitigation");
		expect(elevated).not.toMatch(/-Remove|Remove-Item/);
	});

	it("quotes a path with a quote in it", () => {
		const { elevated } = scripts(gitAslrSpawn("C:\\Windows", "C:\\O'Brien\\Git", "fix", files).args);
		expect(elevated).toContain("'C:\\O''Brien\\Git\\usr'");
	});
});

describe("the record of what Fix changed", () => {
	const root = "C:\\Program Files\\Git";
	const sh = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
	const ls = "C:\\Program Files\\Git\\usr\\bin\\ls.exe";

	it("reads the step's output: prior nibble 0/1/3 as notset/on/on-require-relocs, anything else dropped", () => {
		const output = `\uFEFF[{"path":"${sh.replaceAll("\\", "\\\\")}","prior":0},{"path":"a","prior":1},{"path":"b","prior":3},{"path":"c","prior":2}]`;
		expect(parseFixOutput(output)).toEqual([
			{ path: sh, prior: "notset" },
			{ path: "a", prior: "on" },
			{ path: "b", prior: "on-require-relocs" },
		]);
		// Windows PowerShell writes a one-element array as the element.
		expect(parseFixOutput('{"path":"a","prior":1}')).toEqual([{ path: "a", prior: "on" }]);
		expect(parseFixOutput("")).toEqual([]);
		expect(parseUndoOutput('["a","b"]')).toEqual(["a", "b"]);
		expect(parseUndoOutput('"a"')).toEqual(["a"]);
	});

	it("keeps the state before OMPdesk across a second Fix and drops only what Undo restored", () => {
		const first = withFixed({ version: 1, roots: {} }, root, [{ path: sh, prior: "on" }]);
		const second = withFixed(first, "c:\\program files\\git\\", [
			{ path: sh.toUpperCase(), prior: "notset" },
			{ path: ls, prior: "notset" },
		]);
		expect(recordedImages(second, root)).toEqual([
			{ path: sh, prior: "on" },
			{ path: ls, prior: "notset" },
		]);
		const round = parseGitAslrRecord(JSON.stringify(second));
		expect(round).toEqual(second);
		expect(JSON.parse(undoInput(recordedImages(round, root)))).toEqual([
			{ path: sh, prior: 1 },
			{ path: ls, prior: 0 },
		]);
		const partly = withRestored(round, root, [sh]);
		expect(recordedImages(partly, root)).toEqual([{ path: ls, prior: "notset" }]);
		expect(withRestored(partly, root, [ls]).roots).toEqual({});
	});

	it("reads a missing or damaged record as empty, so Undo is not offered", () => {
		expect(parseGitAslrRecord("").roots).toEqual({});
		expect(parseGitAslrRecord('{"version":2,"roots":{}}').roots).toEqual({});
		expect(parseGitAslrRecord('{"version":1,"roots":{"x":[{"path":"a","prior":"off"}]}}').roots).toEqual({});
	});
});

describe("gitAslrOverridden", () => {
	const query = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\sh.exe
    UseFilter    REG_DWORD    0x1

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\sh.exe\\{7a215fff-e151-d290-08ca-af287bbaf5fb}
    FilterFullPath    REG_SZ    C:\\Program Files\\Git\\usr\\bin\\sh.exe
    MitigationOptions    REG_BINARY    010200000000000000000000000000000000000000000000
`;

	it("finds the override on that Git's sh.exe only, with Force randomization off whatever else is set", () => {
		expect(gitAslrOverridden(query, "C:\\Program Files\\Git")).toBe(true);
		expect(gitAslrOverridden(query, "c:\\program files\\git")).toBe(true);
		expect(gitAslrOverridden(query, "D:\\PortableGit")).toBe(false);
		expect(gitAslrOverridden(query.replace("0102", "0101"), "C:\\Program Files\\Git")).toBe(false);
		expect(gitAslrOverridden("", "C:\\Program Files\\Git")).toBe(false);
	});
});
