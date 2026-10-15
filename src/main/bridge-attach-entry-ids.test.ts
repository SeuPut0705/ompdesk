import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "../shared/rpc-types";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-coding-agent");

interface RecordedEntry {
	type: "message" | "custom_message";
	id: string;
	timestamp: string;
	customType?: string;
}

/** Real omp 18.11 frames and journal of one session in which the advisor spoke twice and a background job finished. */
const recording: { events: AgentSessionEvent[]; entries: RecordedEntry[] } = JSON.parse(
	fs.readFileSync("e2e/fixtures/real-advisor-frames.json", "utf8"),
);

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(stockRoot))("sessions.attach_entry_ids on a recorded run", () => {
	it("gives every message of a committed agent_end its journal entry id, custom messages included", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-attach-ids-"));
		fs.chmodSync(dir, 0o700);
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "dir");
			fs.copyFileSync("resources/gui-bridge/session-display.ts", path.join(dir, "session-display.ts"));
			fs.copyFileSync("e2e/fixtures/real-advisor-frames.json", path.join(dir, "recording.json"));
			fs.writeFileSync(
				path.join(dir, "check.ts"),
				`
import { attachEntryIds } from "./session-display.ts";
const { events, entries } = JSON.parse(await Bun.file("./recording.json").text());
const stamped = events.filter(event => event.type === "agent_end").map(event => attachEntryIds(event.messages, entries));
console.log(JSON.stringify(stamped));
`,
			);
			const stamped: AgentMessage[][] = JSON.parse(
				execFileSync("bun", [path.join(dir, "check.ts")], {
					encoding: "utf8",
					cwd: dir,
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			);
			const messages = stamped.flat();
			// Stock persists every one of them: the journal has an entry for each.
			expect(messages.filter(message => message.entryId === undefined)).toEqual([]);
			const customs = messages.filter(message => message.role === "custom");
			expect(customs.map(message => message.customType)).toEqual([
				"xdev-mount-notice",
				"advisor",
				"advisor",
				"async-result",
			]);
			for (const message of customs) {
				const entry = recording.entries.find(
					candidate =>
						candidate.type === "custom_message" &&
						candidate.customType === message.customType &&
						Date.parse(candidate.timestamp) === message.timestamp,
				);
				expect(entry, `journal entry of ${message.customType}`).toBeDefined();
				expect(message.entryId).toBe(entry?.id);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
