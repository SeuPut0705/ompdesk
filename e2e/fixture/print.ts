/// <reference types="bun" />
import * as fs from "node:fs";

/** `omp -p` (scheduled runs). */
export async function runPrint(): Promise<void> {
	// Print mode (scheduled runs): the prompt arrives on stdin; "fixture hang" keeps running until killed.
	const prompt = await Bun.stdin.text();
	if (process.env.OMP_GUI_TEST_RECORD) {
		const frame = { type: "print", argv: process.argv.slice(2), cwd: process.cwd(), prompt };
		fs.appendFileSync(process.env.OMP_GUI_TEST_RECORD, `${JSON.stringify(frame)}\n`);
	}
	console.log(`fixture print: ${prompt.trim()}`);
	if (prompt.includes("fixture hang")) setInterval(() => {}, 1000);
	else if (prompt.includes("fixture fail")) {
		console.error("fixture print failed");
		process.exit(4);
	}
}
