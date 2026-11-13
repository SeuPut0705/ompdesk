// Rewrites the @code tags of tla/StockLane.tla to the line ranges the functions they name have now in the core's
// stock/mod.rs (the tool resolves a Rust location by lines only). Run from the repository root after editing that
// file: bun formal/stock-lane/retag.ts
import * as fs from "node:fs";

const CODE = "native/ompdesk/crates/core/src/stock/mod.rs";
const SPEC = "formal/stock-lane/tla/StockLane.tla";
const code = fs.readFileSync(CODE, "utf8").split("\n");

/** The 1-based lines from the one that starts with `opener` to the next that is exactly `closer`. */
function range(opener: string, closer: string): string {
	const start = code.findIndex(line => line.startsWith(opener));
	if (start < 0) throw new Error(`${CODE} has no line starting with "${opener}"`);
	const end = code.findIndex((line, index) => index > start && line === closer);
	return `${start + 1}-${end + 1}`;
}

const free: Record<string, string> = {
	wait: range("async fn wait(", "}"),
	read_lines: range("fn read_lines(", "}"),
};
let tags = 0;
const tag = new RegExp(`@code ${CODE.replaceAll(".", "\\.")}:[\\d-]+ (?:Lane::(\\w+)|(\\w+))`, "g");
const spec = fs.readFileSync(SPEC, "utf8").replace(tag, (_, method: string | undefined, name: string) => {
	tags++;
	if (method) return `@code ${CODE}:${range(`    fn ${method}(`, "    }")} Lane::${method}`;
	const lines = free[name];
	if (!lines) throw new Error(`a tag names ${name}, which this script does not know`);
	return `@code ${CODE}:${lines} ${name}`;
});
fs.writeFileSync(SPEC, spec);
console.log(`${tags} tags`);
