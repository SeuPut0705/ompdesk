/** Where the scripts that build the repository's Rust (native/memory, native/ompdesk) find cargo. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const win = process.platform === "win32";

function findExe(name: string, extra: string[] = []): string | null {
	const exe = win ? `${name}.exe` : name;
	const candidates = [
		...(process.env.PATH ?? "").split(path.delimiter).map(dir => (dir ? path.join(dir, exe) : "")),
		...extra.map(dir => path.join(dir, exe)),
		path.join(os.homedir(), ".cargo", "bin", exe),
	];
	return candidates.find(file => file && fs.existsSync(file)) ?? null;
}

/**
 * `cargo` for the build folder `cwd` (the folder holding rust-toolchain.toml). When rustup is reachable the
 * toolchain file is honoured by asking rustup for the real binary (a non-rustup cargo first on PATH, such as
 * Homebrew's, ignores the file). Without rustup: `cargo` on PATH, else `~/.cargo/bin`.
 */
export function cargoPath(cwd?: string): string | null {
	const plain = findExe("cargo");
	const rustup = findExe("rustup", plain ? [path.dirname(plain)] : []);
	if (!rustup) return plain;
	try {
		const out = execFileSync(rustup, ["which", "cargo"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		const found = out.split(/\r?\n/).pop() ?? "";
		if (found && fs.existsSync(found)) return found;
	} catch (error) {
		const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
		throw new Error(
			`rustup could not resolve cargo for ${cwd ?? process.cwd()} (the toolchain pinned in its rust-toolchain.toml is probably not installed). ` +
				`Install it yourself with \`rustup toolchain install\` there; this script does not install toolchains.${stderr ? `\n${stderr}` : ""}`,
		);
	}
	return plain;
}

/** The `rustc` beside `cargo`. */
export function rustcPath(cargo: string): string {
	return path.join(path.dirname(cargo), win ? "rustc.exe" : "rustc");
}

/** The environment to run `cargo` with: its own folder first on PATH, so a toolchain binary found through rustup reaches its rustc. */
export function cargoEnv(cargo: string): NodeJS.ProcessEnv {
	return { ...process.env, PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ""}` };
}
