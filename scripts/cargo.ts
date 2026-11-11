/** Where the scripts that build the repository's Rust (native/memory, native/ompdesk) find cargo. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** `cargo` on PATH, else rustup's own folder (a GUI-launched shell often has no `~/.cargo/bin` on PATH). */
export function cargoPath(): string | null {
	const exe = process.platform === "win32" ? "cargo.exe" : "cargo";
	const candidates = [
		...(process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, exe)),
		path.join(os.homedir(), ".cargo", "bin", exe),
	];
	return candidates.find(file => file && fs.existsSync(file)) ?? null;
}

/** The `rustc` beside `cargo`. */
export function rustcPath(cargo: string): string {
	return path.join(path.dirname(cargo), process.platform === "win32" ? "rustc.exe" : "rustc");
}
