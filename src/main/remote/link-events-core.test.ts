/**
 * The link's event encoding in the real ompdesk-core binary (native-rust ledger R4, `crates/core/src/remote/events/`)
 * against the TypeScript in `link-events.ts`: every call the TypeScript tests made (`link-events.test.ts`,
 * `message-update-slim.test.ts`, `subagent-frames.test.ts`, `frame-bookkeeping.test.ts`, the installed omp's run of
 * `link-events-stock.test.ts` and the traffic rig's streams of `link-traffic-report.test.ts`, captured by
 * `link-events-capture.ts`) is made again on the core, which must answer the very JSON text the TypeScript gave and
 * send the very tab events. `OMP_GUI_LINK_EVENTS_COST=1` also prints what the TypeScript sender costs per event on the
 * rig's streamed replies (450, 900 and 1 800 tokens), beside the Rust test `remote::events::tests::cost`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, SubagentFrame } from "../../shared/rpc-types";
import { core } from "../core/process";
import { withoutFrameBookkeeping } from "../frame-bookkeeping";
import { createMessageUpdateSlimmer, slimMessageUpdate } from "../message-update-slim";
import { slimSubagentFrame } from "../subagent-frames";
import {
	createLinkEventDecoder,
	createLinkEventEncoder,
	createLinkEventSender,
	createReadDecoder,
	createReadEncoder,
	encodedReadKey,
	type WireSubagentFrame,
} from "./link-events";
import { CAPTURED_DIR, type Row } from "./link-events-capture";

const FILES = [
	"link-events",
	"message-update-slim",
	"subagent-frames",
	"frame-bookkeeping",
	"link-events-stock",
	"link-traffic-report",
];

const rowsOf = (name: string): Row[] =>
	(JSON.parse(gunzipSync(readFileSync(join(CAPTURED_DIR, `${name}.json.gz`))).toString("utf8")) as { rows: Row[] })
		.rows;

interface Answer {
	out: string | null;
	sends: Array<{ name: string; arg: string }>;
}

type Event = AgentSessionEvent;

/** What the TypeScript as it is now gives for a row's calls, as the capture spelled it. */
function typeScript(row: Row): Answer[] {
	const text = (value: unknown): string | null => JSON.stringify(value) ?? null;
	const answers: Answer[] = [];
	const options = (row.options ?? {}) as Record<string, boolean>;
	let sends: Answer["sends"] = [];
	let oks: boolean[] = [];
	const encoder = row.kind === "encoder" ? createLinkEventEncoder(options) : null;
	const decoder = row.kind === "decoder" ? createLinkEventDecoder() : null;
	const slimmer = row.kind === "slimmer" ? createMessageUpdateSlimmer() : null;
	const readEncoder = row.kind === "readEncoder" ? createReadEncoder(options.shifts, options.fields) : null;
	const readDecoder = row.kind === "readDecoder" ? createReadDecoder() : null;
	const sender =
		row.kind === "sender"
			? createLinkEventSender({
					slim: options,
					send: (name, arg) => {
						sends.push({ name, arg: JSON.stringify(arg) });
						return oks.shift() ?? true;
					},
				})
			: null;
	let epoch: string | undefined;
	for (const op of row.ops) {
		sends = [];
		oks = (op.sends ?? []).map(send => send.ok);
		const input = op.in;
		let out: string | null = null;
		if (encoder)
			out = text(
				op.op === "events" ? encoder.events(input as Event[]) : encoder.subagentFrame(input as SubagentFrame),
			);
		else if (decoder)
			out = text(
				op.op === "events" ? decoder.events(input as Event[]) : decoder.subagentFrame(input as WireSubagentFrame),
			);
		else if (slimmer) out = text(slimmer(input as Event[]));
		else if (readDecoder) out = text(readDecoder(input));
		else if (readEncoder) {
			// Each encoder numbers its answers under its own random epoch; the capture's stands for it.
			const answer = text(readEncoder(input, op.fresh === true)) ?? "";
			epoch ??= /"~read":"([^"]+)\.\d+"/.exec(answer)?.[1];
			out = epoch && row.epoch ? answer.replaceAll(`"${epoch}.`, `"${row.epoch}.`) : answer;
		} else if (sender) {
			if (op.op === "events") sender.events(input as Event[]);
			else if (op.op === "subagentFrame") sender.subagentFrame(input as SubagentFrame);
			// The batch timer runs the flush it armed.
			else if (op.op === "flush" || op.op === "timer") sender.flush();
			else sender.dispose();
		} else if (op.op === "slimMessageUpdate")
			out = text(slimMessageUpdate(input as Extract<Event, { type: "message_update" }>));
		else if (op.op === "slimSubagentFrame") out = text(slimSubagentFrame(input as SubagentFrame));
		else if (op.op === "withoutFrameBookkeeping") out = text(withoutFrameBookkeeping(input as object));
		else if (op.op === "encodedReadKey") out = text(encodedReadKey(input as { type: string }));
		answers.push({ out, sends });
	}
	return answers;
}

describe("the captured rows", () => {
	it.each(FILES)("are what %s's TypeScript gives today, so the core is held to the encoding in use", name => {
		const differences: string[] = [];
		for (const row of rowsOf(name)) {
			for (const [index, answer] of typeScript(row).entries()) {
				const op = row.ops[index];
				const sends = (op?.sends ?? []).map(({ name: event, arg }) => ({ name: event, arg }));
				if (answer.out !== (op?.out ?? null) || JSON.stringify(answer.sends) !== JSON.stringify(sends))
					differences.push(`${row.test} [${row.kind}] op ${index} ${op?.op}`);
			}
		}
		// A change to the TypeScript encoding: write the rows again (link-events-capture.ts) and port it to the Rust.
		expect(differences.slice(0, 5)).toEqual([]);
	});
});

describe("the core's link event encoding", () => {
	it.each(FILES)(
		"answers every call %s's TypeScript made with the same JSON text",
		async name => {
			const differences: string[] = [];
			let calls = 0;
			for (const row of rowsOf(name)) {
				const { result } = await core().call<{ stream: number }>("remote.events.open", {
					kind: row.kind,
					options: row.options,
					epoch: row.epoch,
				});
				for (const [index, op] of row.ops.entries()) {
					const { result: answer } = await core().call<Answer>("remote.events.call", {
						stream: result.stream,
						op: op.op,
						...("in" in op ? { in: op.in } : {}),
						fresh: op.fresh === true,
						oks: (op.sends ?? []).map(send => send.ok),
					});
					calls++;
					const sends = (op.sends ?? []).map(({ name: event, arg }) => ({ name: event, arg }));
					if ((answer.out ?? null) !== (op.out ?? null) || JSON.stringify(answer.sends) !== JSON.stringify(sends))
						differences.push(`${row.test} [${row.kind}] op ${index} ${op.op}`);
				}
				await core().call("remote.events.close", { stream: result.stream });
			}
			expect(calls).toBeGreaterThan(0);
			expect(differences.slice(0, 5)).toEqual([]);
		},
		300_000,
	);
});

describe.skipIf(process.env.OMP_GUI_LINK_EVENTS_COST !== "1")("what the TypeScript sender costs", () => {
	it("per event of the rig's streamed replies", () => {
		const rows = rowsOf("link-traffic-report");
		for (const tokens of ["150 thinking + 300", "300 thinking + 600", "600 thinking + 1200"]) {
			const row = rows.find(entry => entry.kind === "sender" && entry.test.includes(tokens));
			if (!row) continue;
			const events = row.ops.reduce(
				(sum, op) =>
					sum + (op.op === "events" && Array.isArray(op.in) ? op.in.length : op.op === "subagentFrame" ? 1 : 0),
				0,
			);
			const rounds = Number(process.env.OMPDESK_EVENTS_COST_ROUNDS) || 20;
			const run = (send: (name: string, arg: unknown) => boolean): number => {
				const started = performance.now();
				for (let round = 0; round < rounds; round++) {
					const sender = createLinkEventSender({ slim: row.options as object, send });
					for (const op of row.ops) {
						if (op.op === "events") sender.events(op.in as AgentSessionEvent[]);
						else if (op.op === "subagentFrame") sender.subagentFrame(op.in as SubagentFrame);
						else if (op.op === "flush" || op.op === "timer") sender.flush();
						else sender.dispose();
					}
					sender.dispose();
				}
				return ((performance.now() - started) * 1000) / (rounds * events);
			};
			const encoding = run(() => true);
			const withText = run((_name, arg) => JSON.stringify(arg).length > 0);
			console.log(
				`${tokens} text tokens: ${events} events, ${encoding.toFixed(2)} µs an event encoding, ${withText.toFixed(2)} µs with JSON text`,
			);
		}
	});
});
