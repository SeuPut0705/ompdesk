import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cargoPath } from "./cargo";

const oldPath = process.env.PATH;
const oldHome = process.env.HOME;
afterEach(() => {
	process.env.PATH = oldPath;
	process.env.HOME = oldHome;
});

function exe(file: string, body: string) {
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

describe.skipIf(process.platform === "win32")("cargoPath", () => {
	it("asks rustup for the pinned toolchain, else uses PATH cargo", () => {
		const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cargo-")));
		const brew = path.join(tmp, "brew");
		const tool = path.join(tmp, "tool");
		const ru = path.join(tmp, "ru");
		for (const d of [brew, tool, ru]) fs.mkdirSync(d);
		exe(path.join(brew, "cargo"), "echo brew");
		exe(path.join(tool, "cargo"), "echo pinned");
		exe(path.join(ru, "rustup"), `[ "$1 $2" = "which cargo" ] && echo ${path.join(tool, "cargo")}`);
		process.env.HOME = tmp;
		process.env.PATH = `${brew}${path.delimiter}${ru}`;
		expect(cargoPath(tmp)).toBe(path.join(tool, "cargo"));
		process.env.PATH = brew;
		expect(cargoPath(tmp)).toBe(path.join(brew, "cargo"));
	});
});
