import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLoginShellEnvCache } from "../shell-env";
import { detectMachine } from "./detect";

const made: string[] = [];
const savedEnv = { PATH: process.env.PATH, SHELL: process.env.SHELL };
afterEach(async () => {
	delete process.env.OMP_GUI_TEST_BREW_DIRS;
	process.env.PATH = savedEnv.PATH;
	process.env.SHELL = savedEnv.SHELL;
	resetLoginShellEnvCache();
	await Promise.all(made.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "darwin")("machine setup's GitHub CLI lookup", () => {
	it("finds a Homebrew gh although the login shell's PATH omits Homebrew's bin dir", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-setup-brew-"));
		made.push(root);
		const shellDir = path.join(root, "shell");
		const brewBin = path.join(root, "brew-bin");
		await Promise.all([fs.mkdir(shellDir), fs.mkdir(brewBin)]);
		const shell = path.join(shellDir, "fake-shell");
		await fs.writeFile(shell, `#!/bin/sh\nexec /usr/bin/env -i PATH=${shellDir}:/usr/bin:/bin /bin/sh -c "$2"\n`, {
			mode: 0o755,
		});
		await fs.writeFile(path.join(brewBin, "gh"), "#!/bin/sh\necho 'gh version 2.99.0 (2026-01-01)'\n", {
			mode: 0o755,
		});
		process.env.SHELL = shell;
		process.env.PATH = `${shellDir}:/usr/bin:/bin`;
		process.env.OMP_GUI_TEST_BREW_DIRS = brewBin;
		resetLoginShellEnvCache();
		const detection = await detectMachine("darwin", path.join(root, "bun"));
		expect(detection.presence.gh).toMatchObject({
			kind: "present",
			version: "2.99.0",
			path: path.join(brewBin, "gh"),
		});
	}, 60_000);
});
