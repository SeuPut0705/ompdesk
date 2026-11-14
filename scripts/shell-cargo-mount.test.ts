import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SHELL_DIR, shellCargoMount } from "./build-shell";
import { cargoPath } from "./cargo";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("keeps Cargo workspace inheritance and sibling dependencies inside the short shell mount", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-cargo-mount-"));
	dirs.push(dir);
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
	fs.writeFileSync(path.join(contract, "src", "lib.rs"), "pub struct Owner;\n");
	const mount = shellCargoMount(shell);
	const short = path.join(dir, "short");
	fs.cpSync(mount.root, short, { recursive: true });
	const cargo = cargoPath(SHELL_DIR);
	if (!cargo) throw new Error("Rust cargo is required for the shell path-dependency regression");
	const metadata = JSON.parse(
		execFileSync(cargo, ["metadata", "--offline", "--format-version", "1", "--no-deps"], {
			cwd: path.join(short, mount.cwd),
			encoding: "utf8",
			env: { ...process.env, CARGO_TARGET_DIR: path.join(dir, "target") },
		}),
	) as { packages: Array<{ dependencies: Array<{ name: string; path?: string }> }> };
	const dependency = metadata.packages[0].dependencies.find(dependency => dependency.name === "ompdesk-app-contract");
	expect(dependency?.path).toBeDefined();
	expect(fs.realpathSync(dependency?.path ?? "")).toBe(
		fs.realpathSync(path.join(short, path.relative(mount.root, contract))),
	);
});
