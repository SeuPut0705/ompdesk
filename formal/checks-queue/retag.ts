// Rewrites the @code tags of tla/ChecksQueue.tla to the line ranges the methods they name have now in the core's
// checks/queue.rs (the tool resolves a Rust location by lines only). Run from the repository root after editing that
// file: bun formal/checks-queue/retag.ts
import * as fs from "node:fs";

const CODE = "native/ompdesk/crates/core/src/checks/queue.rs";
const SPEC = "formal/checks-queue/tla/ChecksQueue.tla";
const code = fs.readFileSync(CODE, "utf8").split("\n");

/** The 1-based lines of method `name` of `LandQueue`: its `fn` line to the next line that is exactly `    }`. */
function range(name: string): string {
	const start = code.findIndex(line => new RegExp(`^    (pub )?fn ${name}\\b`).test(line));
	if (start < 0) throw new Error(`${CODE} has no method ${name}`);
	const end = code.findIndex((line, index) => index > start && line === "    }");
	return `${start + 1}-${end + 1}`;
}

let tags = 0;
const tag = new RegExp(`@code ${CODE.replaceAll(".", "\\.")}:[\\d-]+ LandQueue::(\\w+)`, "g");
const spec = fs.readFileSync(SPEC, "utf8").replace(tag, (_, method: string) => {
	tags++;
	return `@code ${CODE}:${range(method)} LandQueue::${method}`;
});
fs.writeFileSync(SPEC, spec);
console.log(`${tags} tags in ${SPEC} now point at ${CODE}`);
