/**
 * Opt-in, Windows only, needs a person to click Yes on one UAC prompt: `OMP_GUI_GIT_ASLR_REAL=1 bunx vitest run
 * src/main/setup/git-aslr.windows.test.ts`. Runs the real Fix and Undo scripts against throwaway copies of an
 * exe in a temp "Git" (never the real Git), one with DEP and CFG set beforehand, one with ForceRelocateImages
 * on beforehand, one with nothing, and checks Undo puts back exactly the prior state. Its own entries are
 * removed at the end.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitAslrElevatedScript, parseFixOutput, parseUndoOutput, undoInput } from "./git-aslr";
import { psQuote } from "./plans";

const enabled = process.platform === "win32" && process.env.OMP_GUI_GIT_ASLR_REAL === "1";

interface Snapshot {
	path: string;
	options: string;
	audit: string;
	relocate: string;
	dep: string;
	cfg: string;
}

describe.runIf(enabled)("Git ASLR fix and undo on this Windows", () => {
	it("turns ForceRelocateImages off and back exactly, leaving DEP and CFG alone", () => {
		const root = mkdtempSync(join(tmpdir(), "ompdesk-aslr-"));
		const bin = join(root, "usr", "bin");
		mkdirSync(bin, { recursive: true });
		const stamp = `${process.pid}-${Date.now()}`;
		const [plain, depCfg, on] = ["plain", "depcfg", "on"].map(name => join(bin, `ompdesk-aslr-${name}-${stamp}.exe`));
		for (const image of [plain, depCfg, on])
			copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), image);
		const files = (name: string) => ({
			input: join(root, `${name}-in.json`),
			output: join(root, `${name}-out.json`),
		});
		const fix = files("fix");
		const undo = files("undo");
		const snaps = join(root, "snaps.json");
		const images = `@(${[plain, depCfg, on].map(psQuote).join(", ")})`;
		// Undo's input is Fix's output (both `{path, prior nibble}`, as `undoInput` writes it); one UAC prompt for all.
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"$all = @{}",
			// No entry reads as empty strings; that is the same as NOTSET.
			"function State($value) { $s = [string]$value; if ($s) { $s } else { 'NOTSET' } }",
			"function Snap([string]$label) {",
			`\t$all[$label] = @(foreach ($image in ${images}) {`,
			"\t\t$k = Join-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options' ([System.IO.Path]::GetFileName($image))",
			"\t\t$e = if (Test-Path -LiteralPath $k) { @(Get-ChildItem -LiteralPath $k) | Where-Object { [string]$_.GetValue('FilterFullPath') -ieq $image } | Select-Object -First 1 } else { $null }",
			"\t\t$o = if ($e) { $e.GetValue('MitigationOptions') } else { $null }; $a = if ($e) { $e.GetValue('MitigationAuditOptions') } else { $null }",
			"\t\t$m = Get-ProcessMitigation -Name $image",
			"\t\t[pscustomobject]@{ path = $image; options = if ($o) { [BitConverter]::ToString($o) } else { '' }; audit = if ($a) { [BitConverter]::ToString($a) } else { '' }; relocate = State $m.ASLR.ForceRelocateImages; dep = State $m.DEP.Enable; cfg = State $m.CFG.Enable }",
			"\t})",
			"}",
			"try {",
			`\tSet-ProcessMitigation -Name ${psQuote(depCfg)} -Enable DEP,CFG`,
			`\tSet-ProcessMitigation -Name ${psQuote(on)} -Enable ForceRelocateImages`,
			"\tSnap 'before'",
			`\t& ([scriptblock]::Create(${psQuote(gitAslrElevatedScript(root, "fix", fix))}))`,
			"\tSnap 'fixed'",
			`\tCopy-Item -LiteralPath ${psQuote(fix.output)} -Destination ${psQuote(undo.input)}`,
			`\t& ([scriptblock]::Create(${psQuote(gitAslrElevatedScript(root, "undo", undo))}))`,
			"\tSnap 'undone'",
			`\tConvertTo-Json -InputObject $all -Depth 5 | Set-Content -LiteralPath ${psQuote(snaps)} -Encoding UTF8`,
			`} catch { $_ | Out-String | Set-Content -LiteralPath ${psQuote(join(root, "error.txt"))}; throw } finally { foreach ($image in ${images}) { try { Set-ProcessMitigation -Name $image -Remove } catch {} } }`,
		].join("\n");
		const file = join(root, "run.ps1");
		writeFileSync(file, `\uFEFF${script}`, "utf8");
		const outer = `$p = Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${file}"') -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
		const run = spawnSync("powershell.exe", ["-NoProfile", "-Command", outer], { encoding: "utf8" });
		try {
			expect(
				run.status,
				`${run.stderr}${existsSync(join(root, "error.txt")) ? readFileSync(join(root, "error.txt"), "utf8") : ""}`,
			).toBe(0);
			const all = JSON.parse(readFileSync(snaps, "utf8").replace(/^\uFEFF/, "")) as Record<string, Snapshot[]>;
			const at = (label: string, image: string) => all[label]?.find(row => row.path === image);
			// The nibble of byte 1 (bits 8-11) is ForceRelocateImages; every other byte must be the same.
			const others = (options: string | undefined) =>
				options
					?.split("-")
					.map((byte, index) => (index === 1 ? (Number.parseInt(byte, 16) & 0xf0).toString(16) : byte))
					.join("-");
			for (const image of [plain, depCfg, on]) {
				expect(at("fixed", image)?.relocate).toBe("OFF");
				for (const label of ["fixed", "undone"]) {
					expect(at(label, image)?.dep).toBe(at("before", image)?.dep);
					expect(at(label, image)?.cfg).toBe(at("before", image)?.cfg);
					expect(at(label, image)?.audit || at("before", image)?.audit).toBe(
						at("before", image)?.audit || at(label, image)?.audit,
					);
				}
				if (at("before", image)?.options)
					expect(others(at("fixed", image)?.options)).toBe(others(at("before", image)?.options));
			}
			expect(at("before", depCfg)?.dep).toBe("ON");
			expect(at("before", depCfg)?.cfg).toBe("ON");
			expect(at("undone", plain)?.relocate).toBe("NOTSET");
			expect(at("undone", depCfg)?.relocate).toBe("NOTSET");
			expect(at("undone", depCfg)?.options).toBe(at("before", depCfg)?.options);
			expect(at("before", on)?.relocate).toBe("ON");
			expect(at("undone", on)?.relocate).toBe("ON");
			expect(at("undone", on)?.options).toBe(at("before", on)?.options);
			expect(
				parseFixOutput(readFileSync(fix.output, "utf8"))
					.map(row => row.prior)
					.sort(),
			).toEqual(["notset", "notset", "on"]);
			expect(parseUndoOutput(readFileSync(undo.output, "utf8"))).toHaveLength(3);
			expect(undoInput(parseFixOutput(readFileSync(fix.output, "utf8")))).toContain('"prior":1');
		} finally {
			if (!process.env.OMP_GUI_GIT_ASLR_KEEP) rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);
});
