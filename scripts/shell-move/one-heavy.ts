/**
 * Batch S runs one heavy job of its own at a time on this desktop (the main session's rule): every heavy command of
 * the batch (a cargo build of the shell, a setup build, a move run, Playwright) goes through here, which holds one
 * folder lock for the batch and then runs the command, usually `bun run locked -- …` for the machine-wide lock too.
 *
 *   bun scripts/shell-move/one-heavy.ts -- <command> [args…]
 *
 * The lock is `%TEMP%\ompdesk-shell-batch-heavy` (`mkdir` is atomic); its `owner` file names the holder's pid, and a
 * holder that no longer runs is taken over.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "ompdesk-shell-batch-heavy");
const args = process.argv.slice(2);
const command = args[0] === "--" ? args.slice(1) : args;
if (!command.length) throw new Error("usage: bun scripts/shell-move/one-heavy.ts -- <command> [args…]");

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

let announced = false;
for (;;) {
	try {
		mkdirSync(LOCK);
		writeFileSync(join(LOCK, "owner"), `${process.pid} ${command.join(" ")}`);
		break;
	} catch {
		let owner = "";
		try {
			owner = readFileSync(join(LOCK, "owner"), "utf8");
		} catch {}
		const pid = Number(owner.split(" ")[0]);
		if (pid && !alive(pid)) {
			rmSync(LOCK, { recursive: true, force: true });
			continue;
		}
		if (!announced) console.error(`[one-heavy] waiting for: ${owner || "a holder starting"}`);
		announced = true;
		await Bun.sleep(2000);
	}
}
const release = () => rmSync(LOCK, { recursive: true, force: true });
process.on("SIGINT", () => {
	release();
	process.exit(130);
});
const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
const code = await child.exited;
release();
process.exit(code);
