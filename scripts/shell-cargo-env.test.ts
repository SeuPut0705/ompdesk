import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { SHELL_DIR, shellCargoEnv } from "./build-shell";
import { cargoPath, rustcPath } from "./cargo";

it("runs resolved compiler children without entering dependency rustup proxies", () => {
	const cargo = cargoPath(SHELL_DIR);
	if (!cargo) throw new Error("The shell compiler regression requires the pinned Cargo.");
	const ext = process.platform === "win32" ? ".exe" : "";
	const rustup = (process.env.PATH ?? "")
		.split(path.delimiter)
		.map(dir => path.join(dir, `rustup${ext}`))
		.find(file => fs.existsSync(file));
	if (!rustup) throw new Error("This regression requires the installed rustup executable.");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-compiler-child-"));
	const previous = { PATH: process.env.PATH, RUSTC: process.env.RUSTC, RUSTDOC: process.env.RUSTDOC };
	try {
		const proxy = path.join(dir, "proxy");
		fs.mkdirSync(proxy);
		for (const name of ["rustc", "rustdoc"]) {
			const target = path.join(proxy, `${name}${ext}`);
			try {
				fs.linkSync(fs.realpathSync(rustup), target);
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "EXDEV") throw error;
				fs.copyFileSync(rustup, target, fs.constants.COPYFILE_FICLONE);
			}
		}
		// quote/proc-macro2 request this component from their own build-script working directories.
		fs.writeFileSync(path.join(dir, "rust-toolchain.toml"), '[toolchain]\ncomponents = ["rust-src"]\n');
		process.env.PATH = `${proxy}${path.delimiter}${previous.PATH ?? ""}`;
		delete process.env.RUSTC;
		delete process.env.RUSTDOC;
		const env = shellCargoEnv(cargo);
		// A custom, unavailable toolchain makes a proxy fail without any download or component install.
		env.RUSTUP_TOOLCHAIN = "ompdesk-toolchain-proxy-must-not-run";
		env.RUSTUP_AUTO_INSTALL = "0";
		for (const [name, tool] of [
			["rustc", rustcPath(cargo)],
			["rustdoc", path.join(path.dirname(cargo), `rustdoc${ext}`)],
		]) {
			const expected = execFileSync(tool, ["--version"], { encoding: "utf8" });
			const actual = execFileSync(name, ["--version"], { cwd: dir, env, encoding: "utf8" });
			expect(actual).toBe(expected);
		}
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
