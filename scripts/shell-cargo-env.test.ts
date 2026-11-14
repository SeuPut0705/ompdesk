import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { shellCargoEnv } from "./build-shell";

it("does not let an ambient executable shadow a resolved toolchain child", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-toolchain-child-"));
	const previous = process.env.PATH;
	try {
		const work = path.join(dir, "work");
		fs.mkdirSync(work);
		const name = path.basename(process.execPath).replace(/\.exe$/i, "");
		fs.writeFileSync(
			path.join(dir, process.platform === "win32" ? `${name}.cmd` : name),
			process.platform === "win32" ? "@echo stale-toolchain\r\n" : "#!/bin/sh\nprintf 'stale-toolchain\\n'\n",
			{ mode: 0o755 },
		);
		process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
		const env = shellCargoEnv(process.execPath);
		const expected = execFileSync(process.execPath, ["--version"], { encoding: "utf8" });
		const actual = execFileSync(
			process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
			process.platform === "win32" ? ["/d", "/s", "/c", `"${name}" --version`] : ["-c", `"${name}" --version`],
			{ cwd: work, env, encoding: "utf8" },
		);
		expect(actual).toBe(expected);
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
