import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SHELL_DIR, shellCargoEnv, shellCargoMount } from "./build-shell";
import { cargoPath, rustcPath } from "./cargo";

const cargo = cargoPath(SHELL_DIR);
if (!cargo) throw new Error("The shell smoke requires the already installed pinned toolchain.");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-cargo-smoke-"));
try {
	const crates = path.join(dir, "original", "crates");
	const shell = path.join(crates, "shell");
	const contract = path.join(crates, "app-contract");
	fs.mkdirSync(path.dirname(crates), { recursive: true });
	fs.copyFileSync(path.resolve(SHELL_DIR, "..", "..", "Cargo.toml"), path.join(path.dirname(crates), "Cargo.toml"));
	for (const crate of [shell, contract]) fs.mkdirSync(path.join(crate, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(shell, "Cargo.toml"),
		'[workspace]\n[package]\nname="shell-mount-fixture"\nversion="0.1.0"\nedition="2024"\n[dependencies]\nompdesk-app-contract={path="../app-contract"}\n',
	);
	fs.writeFileSync(path.join(shell, "src", "lib.rs"), "pub use ompdesk_app_contract::Owner;\n");
	fs.copyFileSync(path.resolve(SHELL_DIR, "..", "app-contract", "Cargo.toml"), path.join(contract, "Cargo.toml"));
	fs.copyFileSync(
		path.resolve(SHELL_DIR, "..", "app-contract", "src", "lib.rs"),
		path.join(contract, "src", "lib.rs"),
	);
	const mount = shellCargoMount(shell);
	const short = path.join(dir, "short");
	fs.cpSync(mount.root, short, { recursive: true });
	const env = shellCargoEnv(cargo);
	env.CARGO_TARGET_DIR = path.join(dir, "target");
	env.RUSTUP_TOOLCHAIN = "ompdesk-toolchain-proxy-must-not-run";
	env.RUSTUP_AUTO_INSTALL = "0";
	const metadata = JSON.parse(
		execFileSync(cargo, ["metadata", "--offline", "--format-version", "1", "--no-deps"], {
			cwd: path.join(short, mount.cwd),
			encoding: "utf8",
			env,
		}),
	) as { packages: Array<{ dependencies: Array<{ name: string; path?: string }> }> };
	const dependency = metadata.packages[0].dependencies.find(dependency => dependency.name === "ompdesk-app-contract");
	assert.ok(dependency?.path);
	assert.equal(
		fs.realpathSync(dependency.path),
		fs.realpathSync(path.join(short, path.relative(mount.root, contract))),
	);
	for (const [name, tool] of [
		["rustc", rustcPath(cargo)],
		["rustdoc", path.join(path.dirname(cargo), process.platform === "win32" ? "rustdoc.exe" : "rustdoc")],
	]) {
		const expected = execFileSync(tool, ["--version"], { encoding: "utf8" });
		const actual = execFileSync(name, ["--version"], { cwd: path.join(short, mount.cwd), env, encoding: "utf8" });
		assert.equal(actual, expected);
		console.log(`[shell-cargo-smoke] ${actual.trim()}`);
	}
	console.log("[shell-cargo-smoke] workspace inheritance and resolved toolchain children passed");
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
