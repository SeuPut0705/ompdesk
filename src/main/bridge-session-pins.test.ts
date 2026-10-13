/**
 * gui-bridge session pins (resources/gui-bridge/session-pins.ts) against stock
 * session/session-pins.ts: the same pins file bytes and mode as stock's writer,
 * stock reads every state it writes, it shares stock's cross-process lock with
 * concurrent `toggleSessionPin` calls, and a repeated request keeps its state
 * where stock's toggle would flip it back (why the copy exists).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-coding-agent");

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(stockRoot))("gui-bridge session pins against stock", () => {
	it("writes stock's pins file, under stock's lock, and assigns instead of toggling", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-pins-"));
		fs.chmodSync(dir, 0o700);
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "dir");
			fs.copyFileSync("resources/gui-bridge/session-pins.ts", path.join(dir, "session-pins.ts"));
			const script = `
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadPinnedSessionIds, toggleSessionPin } from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { setSessionPinned } from "./session-pins.ts";
const root = process.argv[2];
const gui = path.join(root, "gui");
const stock = path.join(root, "stock");
const file = dir => path.join(dir, "session-pins.json");

assert.equal(await setSessionPinned("a", true, gui), true);
assert.equal(await toggleSessionPin("a", stock), true);
assert.equal(fs.readFileSync(file(gui), "utf8"), fs.readFileSync(file(stock), "utf8"));
assert.equal(fs.statSync(file(gui)).mode & 0o777, fs.statSync(file(stock)).mode & 0o777);
assert.deepEqual([...(await loadPinnedSessionIds(gui))], ["a"]);

const before = fs.readFileSync(file(gui), "utf8");
assert.equal(await setSessionPinned("a", true, gui), true);
assert.equal(fs.readFileSync(file(gui), "utf8"), before);
assert.equal(await toggleSessionPin("a", stock), false);

assert.equal(await toggleSessionPin("b", gui), true);
assert.equal(await setSessionPinned("a", false, gui), false);
assert.deepEqual([...(await loadPinnedSessionIds(gui))], ["b"]);
assert.equal(await setSessionPinned("a", false, gui), false);
assert.deepEqual([...(await loadPinnedSessionIds(gui))], ["b"]);

const ids = Array.from({ length: 12 }, (_, index) => "s" + index);
await Promise.all(ids.map((id, index) => (index % 2 ? toggleSessionPin(id, gui) : setSessionPinned(id, true, gui))));
assert.deepEqual([...(await loadPinnedSessionIds(gui))].sort(), ["b", ...ids].sort());
assert.deepEqual(fs.readdirSync(gui).filter(name => name.endsWith(".tmp")), []);
console.log("stock pin assertions passed");
`;
			fs.writeFileSync(path.join(dir, "check.ts"), script);
			expect(
				execFileSync("bun", [path.join(dir, "check.ts"), dir], {
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			).toContain("stock pin assertions passed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
