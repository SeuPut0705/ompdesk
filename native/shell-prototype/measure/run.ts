// bun measure/run.ts <candidate> [scenario…]: 3 runs per scenario, each a fresh process on one test profile.
//   idle     the app page, no Preview: memory 10 s after the page settled (stand-in's `page.settled`)
//   long     `?long=2000`: a 2 000-message transcript open
//   preview  idle plus the Preview pane on preview-test.html
// Memory is the process tree's sum (measure/mem.ps1). Results: results/measure/<candidate>.json.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const proto = resolve(import.meta.dir, "..");
const repo = resolve(proto, "../..");
const candidate = process.argv[2];
const scenarios = process.argv.slice(3).length ? process.argv.slice(3) : ["idle", "long", "preview"];
const PREVIEW: Record<string, string> = {
	a: "app://ompdesk/__shell/preview-test.html",
	b: "http://app.localhost/__shell/preview-test.html",
	c: "app://ompdesk/__shell/preview-test.html",
	e: "app://ompdesk/__shell/preview-test.html",
};
const COMMANDS: Record<string, string[]> = {
	a: [join(proto, "cef/target/release/shell-cef.exe")],
	b: [join(proto, "tauri2/target/release/shell-tauri2.exe"), "--preview-mode", "webview2"],
	c: [join(proto, "tauri2/target/release/shell-tauri2.exe"), "--preview-mode", "cef-child"],
	e: [join(repo, "node_modules/electron/dist/electron.exe"), join(proto, "measure/electron-baseline/main.cjs")],
};
const base = COMMANDS[candidate];
if (!base) throw new Error(`candidate: ${Object.keys(COMMANDS).join("|")}`);
const out = join(proto, "results", "measure");
mkdirSync(out, { recursive: true });
const userData = join(out, `${candidate}-userData`);
rmSync(userData, { recursive: true, force: true });

const readLog = (file: string) =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line))
		: [];

async function waitFor(file: string, test: (line: Record<string, unknown>) => boolean, ms: number) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const hit = readLog(file).find(test);
		if (hit) return hit;
		await Bun.sleep(250);
	}
	return null;
}

const results: Record<string, unknown[]> = {};
for (const scenario of scenarios) {
	results[scenario] = [];
	for (let run = 1; run <= 3; run++) {
		const log = join(out, `${candidate}-${scenario}-${run}.log.jsonl`);
		rmSync(log, { force: true });
		const args = [...base, "--user-data", userData, "--log", log];
		if (scenario === "long") args.push("--query", "long=2000");
		if (scenario === "preview") args.push("--preview", PREVIEW[candidate]);
		const started = Date.now();
		const child = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
		const settled = await waitFor(log, line => line.event === "page.report" && line.kind === "page.settled", 90_000);
		if (scenario === "preview") await waitFor(log, line => line.event === "preview.loaded", 30_000);
		await Bun.sleep(10_000);
		const memory = JSON.parse(
			(await Bun.$`powershell -NoProfile -File ${join(import.meta.dir, "mem.ps1")} -RootPid ${child.pid}`.text()).trim(),
		);
		const lines = readLog(log);
		const loaded = lines.find(line => line.event === "page.loaded");
		const pageLoad = lines.find(line => line.event === "page.report" && line.kind === "page.load");
		const row = {
			run,
			settled: Boolean(settled),
			nodes: settled?.nodes,
			pageLoadedMs: loaded?.ms ?? loaded?.t,
			loadEventMs: pageLoad ? Number(pageLoad.t) : undefined,
			wallToSettledMs: settled ? Number(settled.t) : undefined,
			...memory,
		};
		console.log(JSON.stringify({ candidate, scenario, ...row }));
		results[scenario].push(row);
		await Bun.$`taskkill /T /F /PID ${child.pid}`.quiet().nothrow();
		await child.exited;
		await Bun.sleep(2000);
		void started;
	}
}
await Bun.write(join(out, `${candidate}.json`), JSON.stringify(results, null, 2));
