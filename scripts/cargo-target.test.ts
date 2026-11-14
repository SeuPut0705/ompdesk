import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { cargoEnv, cargoPath, cargoTargetDir } from "./cargo";

const native = path.resolve("native/ompdesk");

test("staging finds the same target directory that Cargo actually produces", () => {
	const folder = mkdtempSync(path.join(os.tmpdir(), "native-target-"));
	try {
		mkdirSync(path.join(folder, "src"));
		writeFileSync(
			path.join(folder, "Cargo.toml"),
			'[package]\nname="target_probe"\nversion="0.1.0"\nedition="2024"\n',
		);
		writeFileSync(path.join(folder, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
		const cargo = cargoPath(native);
		if (!cargo) throw new Error("The target-directory regression requires the pinned Cargo.");
		for (const target of [undefined, "relative-target", path.join(folder, "absolute-target")]) {
			const env = cargoEnv(cargo);
			delete env.CARGO_TARGET_DIR;
			if (target !== undefined) env.CARGO_TARGET_DIR = target;
			const actual = JSON.parse(
				execFileSync(cargo, ["metadata", "--offline", "--no-deps", "--format-version", "1"], {
					cwd: folder,
					env,
					encoding: "utf8",
				}),
			) as { target_directory: string };
			expect(cargoTargetDir(folder, env)).toBe(actual.target_directory);
		}
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
