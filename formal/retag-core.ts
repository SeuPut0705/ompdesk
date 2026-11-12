// Rewrites the @code tags of the models whose code moved into the Rust core (batch H2: the sidecar pool, turn resume,
// the connectivity monitor, the sidecar lane) to the line ranges the functions they name have now. The tool resolves a
// Rust location by lines only, so a tag names its function after the range (`path:a-b Inst::judge: note`) and this
// script finds the function again by that name. Run from the repository root after editing one of those files:
//   bun formal/retag-core.ts
// A label that no longer finds its function stops the run (the step moved or was renamed: read the model's row).
import * as fs from "node:fs";

const CORE = "native/ompdesk/crates/core/src/";
const SPECS = [
	"formal/turn-resume/tla/TurnResume.tla",
	"formal/session-listing/tla/SessionListing.tla",
	"formal/tab-session/tla/TabSession.tla",
	"formal/session-processes/tla/SessionProcesses.tla",
];

type Find =
	| { file: string; fn: string }
	| { file: string; after: string; block: string } // the block opened by the first line (after `after`'s fn) that starts so
	| { file: string; arm: string; to?: string }; // match arms of ends.rs `applies`

const M = `${CORE}resume/machine.rs`;
const E = `${CORE}resume/ends.rs`;
const C = `${CORE}resume/connectivity.rs`;
const R = `${CORE}pool/run.rs`;
const LABELS: Record<string, Find> = {
	"Inst::launch": { file: M, fn: "launch" },
	"Inst::launch[hold-or-run]": { file: M, after: "launch", block: "for (_, tab, action) in ordered {" },
	"Inst::sync_inner[judge-all]": { file: M, after: "sync_inner", block: "for fact in &facts {" },
	"Inst::judge": { file: M, fn: "judge" },
	"Inst::judge[ends]": { file: M, after: "judge", block: "// The person's new run, Stop on a probe" },
	"Inst::verify_network": { file: M, fn: "verify_network" },
	"Inst::verified": { file: M, fn: "verified" },
	"Inst::plan_retry": { file: M, fn: "plan_retry" },
	"Inst::planned": { file: M, fn: "planned" },
	"Inst::arm": { file: M, fn: "arm" },
	"Inst::hold": { file: M, fn: "hold" },
	"Inst::watch_scheduled_retry": { file: M, fn: "watch_scheduled_retry" },
	"Inst::flush_prefix": { file: M, fn: "flush_prefix" },
	"Inst::flush": { file: M, fn: "flush" },
	"Inst::run": { file: M, fn: "run" },
	"Inst::run[end]": { file: M, after: "run", block: "Ok(self.stretch(env, |me| {" },
	"Inst::stale": { file: M, fn: "stale" },
	"Inst::settled": { file: M, fn: "settled" },
	"Inst::send": { file: M, fn: "send" },
	"Inst::not_continued": { file: M, fn: "not_continued" },
	"Inst::when_ready": { file: M, fn: "when_ready" },
	"Inst::finish_wait": { file: M, fn: "finish_wait" },
	"Inst::look_task": { file: M, fn: "look_task" },
	"Inst::await_look": { file: M, fn: "await_look" },
	"Inst::fire": { file: M, fn: "fire" },
	"Inst::drop_wait": { file: M, fn: "drop_wait" },
	"Inst::cancel_wait": { file: M, fn: "cancel_wait" },
	"facts::derive_markers": { file: `${CORE}resume/facts.rs`, fn: "derive_markers" },
	"ends::persons_run": { file: E, fn: "persons_run" },
	"ends::moved_since": { file: E, fn: "moved_since" },
	"ends::hold_end": { file: E, fn: "hold_end" },
	"ends::applies": { file: E, fn: "applies" },
	"ends::applies[personsRun..stopped]": { file: E, arm: "personsRun", to: "stopped" },
	"ends::applies[stopped]": { file: E, arm: "stopped" },
	"ends::applies[moved]": { file: E, arm: "moved" },
	"ends::applies[personsPrompt]": { file: E, arm: "personsPrompt" },
	"ends::applies[otherOutcome]": { file: E, arm: "otherOutcome" },
	"ends::applies[notRetryable]": { file: E, arm: "notRetryable" },
	"ends::applies[busy]": { file: E, arm: "busy" },
	"Tracking::track": { file: R, fn: "track" },
	"Tracking::track[agent_start]": { file: R, after: "track", block: 'Some("agent_start") => {' },
	"Tracking::track[agent_end]": { file: R, after: "track", block: 'Some("agent_end") if ended => {' },
	"RunState::settle": { file: R, fn: "settle" },
	"Ctx::note_stopped": { file: `${CORE}pool/api.rs`, fn: "note_stopped" },
	"Ctx::note_counter": { file: `${CORE}pool/api.rs`, fn: "note_counter" },
	"Ctx::release_tab": { file: `${CORE}pool/api.rs`, fn: "release_tab" },
	"Ctx::register_session_file_of": { file: `${CORE}pool/routes.rs`, fn: "register_session_file_of" },
	"Ctx::unregister_session_file_of": { file: `${CORE}pool/routes.rs`, fn: "unregister_session_file_of" },
	"Ctx::acquire_inner": { file: `${CORE}pool/windows.rs`, fn: "acquire_inner" },
	"Ctx::release_entry": { file: `${CORE}pool/windows.rs`, fn: "release_entry" },
	"Ctx::release_detached": { file: `${CORE}pool/windows.rs`, fn: "release_detached" },
	"Ctx::feed_session": { file: `${CORE}pool/listen.rs`, fn: "feed_session" },
	"Ctx::feed_session_info": { file: `${CORE}pool/listen.rs`, fn: "feed_session_info" },
	"Monitor::report": { file: C, fn: "report" },
	"Monitor::check": { file: C, fn: "check" },
	"Monitor::reachable": { file: C, fn: "reachable" },
	"Monitor::answers": { file: C, fn: "answers" },
	"Monitor::set": { file: C, fn: "set" },
	"Monitor::arm_reprobe": { file: C, fn: "arm_reprobe" },
	"Monitor::reprobe": { file: C, fn: "reprobe" },
	"Monitor::start_attempt": { file: C, fn: "start_attempt" },
	"Monitor::attempt": { file: C, fn: "attempt" },
	"launch::session_open": { file: `${CORE}sidecar/launch.rs`, fn: "session_open" },
	"Lane::launch": { file: `${CORE}sidecar/lane.rs`, fn: "launch" },
	"Lane::start_process": { file: `${CORE}sidecar/lane.rs`, fn: "start_process" },
	"Lane::handle_ready": { file: `${CORE}sidecar/lane.rs`, fn: "handle_ready" },
	"Lane::observe": { file: `${CORE}sidecar/lane.rs`, fn: "observe" },
	"Lane::on_child_exit": { file: `${CORE}sidecar/lane.rs`, fn: "on_child_exit" },
	"Lane::attempt_restart": { file: `${CORE}sidecar/lane.rs`, fn: "attempt_restart" },
	"Lane::restart": { file: `${CORE}sidecar/lane.rs`, fn: "restart" },
	"Lane::on_gated": { file: `${CORE}sidecar/lane.rs`, fn: "on_gated" },
	"Lane::dispose": { file: `${CORE}sidecar/lane.rs`, fn: "dispose" },
	"Lane::when_all_exited": { file: `${CORE}sidecar/lane.rs`, fn: "when_all_exited" },
};

const files = new Map<string, string[]>();
const lines = (file: string): string[] => {
	let text = files.get(file);
	if (!text) files.set(file, (text = fs.readFileSync(file, "utf8").split("\n")));
	return text;
};
const indent = (line: string): number => line.length - line.trimStart().length;
/** From `start` (0-based) to the next line at the same indent that starts with `}`. */
function closing(text: string[], start: number): number {
	const width = indent(text[start]!);
	for (let at = start + 1; at < text.length; at++)
		if (indent(text[at]!) === width && text[at]!.trimStart().startsWith("}")) return at;
	throw new Error(`no closing brace for line ${start + 1}`);
}
function fnStart(text: string[], name: string, from = 0): number {
	const pattern = new RegExp(`^\\s*(pub(\\([a-z]+\\))? )?(async )?fn ${name}[(<]`);
	const at = text.findIndex((line, index) => index >= from && pattern.test(line));
	if (at < 0) throw new Error(`no fn ${name}`);
	return at;
}
function resolve(label: string): string {
	const find = LABELS[label];
	if (!find) throw new Error(`unknown label ${label}`);
	const text = lines(find.file);
	let start: number;
	let end: number;
	if ("fn" in find) {
		start = fnStart(text, find.fn);
		end = closing(text, start);
	} else if ("block" in find) {
		const from = fnStart(text, find.after);
		start = text.findIndex((line, index) => index > from && line.trimStart().startsWith(find.block));
		if (start < 0) throw new Error(`${label}: no line starting "${find.block}"`);
		end = closing(text, start);
	} else {
		const arm = (name: string) => text.findIndex(line => line.trimStart().startsWith(`"${name}" =>`));
		start = arm(find.arm);
		const last = arm(find.to ?? find.arm);
		if (start < 0 || last < 0) throw new Error(`${label}: no arm`);
		const next = text.findIndex((line, index) => index > last && /^\s+("\w+"|_) =>/.test(line));
		end = next - 1;
	}
	return `${find.file}:${start + 1}-${end + 1}`;
}

let count = 0;
for (const spec of SPECS) {
	const out = fs.readFileSync(spec, "utf8").split("\n").map(line => {
		const tag = /^(\\\* @code )(native\/\S+?):\d+(?:-\d+)? (\S+?)(:?)( .*)?$/.exec(line);
		if (!tag || !(tag[3]! in LABELS)) return line;
		count++;
		return `${tag[1]}${resolve(tag[3]!)} ${tag[3]}${tag[4]}${tag[5] ?? ""}`;
	});
	fs.writeFileSync(spec, out.join("\n"));
}
console.log(`${count} tags`);
