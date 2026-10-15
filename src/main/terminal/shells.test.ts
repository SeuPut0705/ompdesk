import { describe, expect, it } from "vitest";
import { detectShells } from "./shells";

describe("terminal shells", () => {
	it("lists the login shell first, then /etc/shells entries that exist, once each", () => {
		const present = new Set(["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"]);
		const shells = detectShells({
			platform: "darwin",
			env: { SHELL: "/opt/homebrew/bin/fish" },
			exists: file => present.has(file),
			readEtcShells: () => "# comment\n/bin/bash\n/bin/csh\n/bin/zsh\n/opt/homebrew/bin/fish\n",
		});
		expect(shells.map(shell => shell.path)).toEqual(["/opt/homebrew/bin/fish", "/bin/bash", "/bin/zsh"]);
		expect(shells[0]).toEqual({ path: "/opt/homebrew/bin/fish", name: "fish", args: ["-l"] });
	});
	it("offers Command Prompt first on Windows, then PowerShell, PowerShell 7 and Git Bash where installed", () => {
		const present = new Set([
			"C:\\Windows\\System32\\cmd.exe",
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			"C:\\Users\\a\\AppData\\Local\\ompdesk\\tools\\git\\bin\\bash.exe",
		]);
		const shells = detectShells({
			platform: "win32",
			env: {
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				SystemRoot: "C:\\Windows",
				ProgramFiles: "C:\\Program Files",
				LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
			},
			exists: file => present.has(file),
			readEtcShells: () => "",
		});
		expect(shells.map(shell => shell.name)).toEqual(["Command Prompt", "Windows PowerShell", "Git Bash"]);
		expect(shells[2].args).toEqual(["--login", "-i"]);
	});
});
