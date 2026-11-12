// bun native/shell-prototype/stand-in/build.ts → shell-assets/stand-in.js (a classic script, not a module).
import { resolve } from "node:path";

const out = resolve(import.meta.dir, "../shell-assets");
const result = await Bun.build({
	entrypoints: [resolve(import.meta.dir, "entry.ts")],
	outdir: out,
	naming: "stand-in.js",
	format: "iife",
	target: "browser",
	minify: true,
	tsconfig: resolve(import.meta.dir, "../../../tsconfig.json"),
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log(`stand-in.js ${result.outputs[0].size} bytes`);
