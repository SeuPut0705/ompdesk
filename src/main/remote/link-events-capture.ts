/**
 * Test-only: records what the link's event encoding gives for every call a test makes, as rows the Rust port
 * (`native/ompdesk/crates/core/src/remote/events/`) replays both in its own tests and through the real core binary
 * (`link-events-core.test.ts`). A test file wraps the modules with `vi.mock(…, captureModule)` and writes its rows in
 * `afterAll(writeCaptured)`; both do nothing unless `OMPDESK_LINK_EVENTS_CAPTURE=write`, so the tests run on the
 * modules as they are.
 *
 * Write the rows again: `OMPDESK_LINK_EVENTS_CAPTURE=write bunx vitest run --project=node
 * src/main/remote/link-events.test.ts src/main/message-update-slim.test.ts src/main/subagent-frames.test.ts
 * src/main/frame-bookkeeping.test.ts src/main/remote/link-events-stock.test.ts
 * src/main/remote/link-traffic-report.test.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect } from "vitest";

export const CAPTURING = process.env.OMPDESK_LINK_EVENTS_CAPTURE === "write";

export const CAPTURED_DIR = join(__dirname, "../../../native/ompdesk/crates/core/src/remote/events/captured");

/** One call: its input as JSON read back, and its output as `JSON.stringify` spelled it (null for `undefined`). */
interface Op {
	op: string;
	in?: unknown;
	fresh?: boolean;
	out?: string | null;
	/** What a sender sent during the call: each tab event's name, its argument as JSON text, and what `send` answered. */
	sends?: Array<{ name: string; arg: string; ok: boolean }>;
}

export interface Row {
	kind: string;
	test: string;
	options?: unknown;
	epoch?: string;
	ops: Op[];
}

const rows: Row[] = [];

const json = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const text = (value: unknown): string | null => JSON.stringify(value) ?? null;

function row(kind: string, options?: unknown): Row {
	const made: Row = { kind, test: expect.getState().currentTestName ?? "", ops: [] };
	if (options !== undefined) made.options = json(options);
	rows.push(made);
	return made;
}

/** A function of the wrapped modules, as the wrapper sees it: whatever it takes and gives crosses as JSON. */
type Fn = (...args: unknown[]) => unknown;

function recorded(target: Row, op: string, call: Fn): Fn {
	return (...args) => {
		const entry: Op = { op, in: json(args[0]) };
		const out = call(...args);
		entry.out = text(out);
		target.ops.push(entry);
		return out;
	};
}

/** The module with each function the Rust port replaces wrapped to record its calls; the module itself when not capturing. */
export function captureModule<T extends object>(module: T): T {
	if (!CAPTURING) return module;
	const original: Record<string, Fn> = Object.fromEntries(Object.entries(module));
	const wrapped: Record<string, unknown> = { ...original };
	/** What a factory made: an object of methods (an encoder, a decoder, a sender) or one function. */
	const methods = (made: unknown): Record<string, Fn> => Object.fromEntries(Object.entries(made as object));
	const pure = (name: string) => {
		wrapped[name] = (...args: unknown[]) => recorded(row("pure"), name, original[name] as Fn)(...args);
	};
	if ("createLinkEventEncoder" in module) {
		for (const [factory, kind] of [
			["createLinkEventEncoder", "encoder"],
			["createLinkEventDecoder", "decoder"],
		] as const) {
			wrapped[factory] = (options?: object) => {
				const target = kind === "encoder" ? row(kind, options ?? {}) : row(kind);
				const made = methods((original[factory] as Fn)(options));
				return {
					events: recorded(target, "events", made.events as Fn),
					subagentFrame: recorded(target, "subagentFrame", made.subagentFrame as Fn),
				};
			};
		}
		wrapped.createLinkEventSender = (options: { slim: object; send: (name: string, arg: unknown) => boolean }) => {
			const target = row("sender", options.slim);
			let current: Op | null = null;
			const sender = methods(
				(original.createLinkEventSender as Fn)({
					slim: options.slim,
					send: (name: string, arg: unknown) => {
						const ok = options.send(name, arg);
						// A send outside any call is the batch timer's.
						const op = current ?? { op: "timer" };
						if (!current) target.ops.push(op);
						op.sends ??= [];
						op.sends.push({ name, arg: JSON.stringify(arg), ok });
						return ok;
					},
				}),
			);
			const during =
				(op: "events" | "subagentFrame" | "flush" | "dispose") =>
				(arg?: unknown): void => {
					current = { op, ...(arg === undefined ? {} : { in: json(arg) }) };
					target.ops.push(current);
					try {
						(sender[op] as Fn)(arg);
					} finally {
						current = null;
					}
				};
			return {
				events: during("events"),
				subagentFrame: during("subagentFrame"),
				flush: during("flush"),
				dispose: during("dispose"),
			};
		};
		wrapped.createReadEncoder = (shifts = false, fields = false) => {
			const target = row("readEncoder", { shifts, fields });
			const encode = (original.createReadEncoder as Fn)(shifts, fields) as Fn;
			return (status: unknown, fresh: boolean) => {
				const entry: Op = { op: "call", in: json(status), fresh };
				const out = encode(status, fresh);
				const id = typeof out === "object" && out !== null && "~read" in out ? String(out["~read"]) : "";
				target.epoch ??= id.slice(0, id.lastIndexOf("."));
				entry.out = text(out);
				target.ops.push(entry);
				return out;
			};
		};
		wrapped.createReadDecoder = () =>
			recorded(row("readDecoder"), "call", (original.createReadDecoder as Fn)() as Fn);
		pure("encodedReadKey");
	}
	if ("createMessageUpdateSlimmer" in module) {
		wrapped.createMessageUpdateSlimmer = () =>
			recorded(row("slimmer"), "events", (original.createMessageUpdateSlimmer as Fn)() as Fn);
		pure("slimMessageUpdate");
	}
	if ("slimSubagentFrame" in module) pure("slimSubagentFrame");
	if ("withoutFrameBookkeeping" in module) pure("withoutFrameBookkeeping");
	return wrapped as T;
}

/** Writes the rows this test file recorded as `captured/<name>.json.gz`. */
export function writeCaptured(name: string): void {
	if (!CAPTURING) return;
	mkdirSync(CAPTURED_DIR, { recursive: true });
	// Pure calls of one test go in one row: the file stays small enough to read.
	const merged: Row[] = [];
	for (const entry of rows) {
		const last = merged.at(-1);
		if (entry.kind === "pure" && last?.kind === "pure" && last.test === entry.test) last.ops.push(...entry.ops);
		else if (entry.ops.length > 0) merged.push(entry);
	}
	writeFileSync(join(CAPTURED_DIR, `${name}.json.gz`), gzipSync(JSON.stringify({ rows: merged }), { level: 9 }));
}
