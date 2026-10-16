/**
 * The work card's silent-abort rule (work-turn.ts `isSilentAbort`) against stock's own
 * `isSilentAbort` (pi-tui chat/messages.ts): stock runs in Bun over every error flag it
 * defines, alone and with the silent-abort flag, and over its abort texts; the renderer
 * copy must give the same answer for each.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isSilentAbort } from "./work/work-turn";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(path.join(stockModules, "@oh-my-pi/pi-tui")))("silent abort against stock", () => {
	it("tells a silent abort exactly as stock does", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-silent-abort-"));
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "dir");
			fs.writeFileSync(
				path.join(dir, "check.ts"),
				`
import { Flag } from "@oh-my-pi/pi-ai/error";
import { isSilentAbort, SILENT_ABORT_MARKER, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-tui/chat/messages";
const ids = [undefined, 0, ...Object.values(Flag).flatMap(flag => [flag, flag | Flag.SilentAbort])];
const texts = [undefined, "", SILENT_ABORT_MARKER, USER_INTERRUPT_LABEL, "Request was aborted"];
const cases = ids.flatMap(errorId => texts.map(errorMessage => ({ errorId, errorMessage })));
console.log(JSON.stringify(cases.map(message => ({ ...message, silent: isSilentAbort(message) }))));
`,
			);
			const cases = JSON.parse(
				execFileSync("bun", [path.join(dir, "check.ts")], {
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			) as { errorId?: number; errorMessage?: string; silent: boolean }[];
			expect(cases.filter(entry => entry.silent).length).toBeGreaterThan(0);
			expect(cases.filter(entry => !entry.silent).length).toBeGreaterThan(0);
			for (const { silent, ...message } of cases)
				expect(isSilentAbort(message), JSON.stringify(message)).toBe(silent);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
