import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLoginShellEnvCache } from "../../shell-env";
import { resolveBin } from "./exec";

const made: string[] = [];
const savedEnv = { PATH: process.env.PATH, SHELL: process.env.SHELL };
afterEach(async () => {
	delete process.env.OMP_GUI_TEST_BREW_DIRS;
	process.env.PATH = savedEnv.PATH;
	process.env.SHELL = savedEnv.SHELL;
	resetLoginShellEnvCache();
	await Promise.all(made.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	made.push(dir);
	return dir;
}

describe.skipIf(process.platform !== "darwin")("a Homebrew gh outside the login shell's PATH", () => {
	it("is found in Homebrew's bin dir, and a Mac without it still answers null", async () => {
		const shellDir = await tempDir("omp-brew-shell-");
		const brewBin = await tempDir("omp-brew-bin-");
		// A login shell whose PATH omits Homebrew's bin dir (and holds no gh at all).
		const shell = path.join(shellDir, "fake-shell");
		await fs.writeFile(shell, `#!/bin/sh\nexec /usr/bin/env -i PATH=${shellDir}:/usr/bin:/bin /bin/sh -c "$2"\n`, {
			mode: 0o755,
		});
		process.env.SHELL = shell;
		process.env.PATH = `${shellDir}:/usr/bin:/bin`;
		resetLoginShellEnvCache();

		process.env.OMP_GUI_TEST_BREW_DIRS = brewBin;
		expect(await resolveBin("gh")).toBeNull();

		await fs.writeFile(path.join(brewBin, "gh"), "#!/bin/sh\necho gh\n", { mode: 0o755 });
		expect(await resolveBin("gh")).toBe(path.join(brewBin, "gh"));
	});
});
