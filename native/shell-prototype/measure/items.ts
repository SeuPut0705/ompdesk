// bun measure/items.ts <candidate>: the pass-list items an outside observer can check on a running shell, once each:
// --selftest (scheme, ranges, video seek, Preview CDP evaluate/capture/input/PDF, external CDP), Playwright attached
// over the debugging port, the title bar's WM_NCHITTEST map, the tray, and a deep link through the OS shell to the
// running instance. Results: results/items/<candidate>.json.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const proto = resolve(import.meta.dir, "..");
const candidate = process.argv[2];
const COMMANDS: Record<string, string[]> = {
	a: [join(proto, "cef/target/release/shell-cef.exe")],
	b: [join(proto, "tauri2/target/release/shell-tauri2.exe"), "--preview-mode", "webview2"],
	c: [join(proto, "tauri2/target/release/shell-tauri2.exe"), "--preview-mode", "cef-child"],
	cs: [join(proto, "tauri2/target/release/shell-tauri2.exe"), "--preview-mode", "cef-stream"],
};
const base = COMMANDS[candidate];
const port = 9311;
const out = join(proto, "results", "items");
mkdirSync(out, { recursive: true });
const userData = join(out, `${candidate}-userData`);
rmSync(userData, { recursive: true, force: true });
const log = join(out, `${candidate}.log.jsonl`);
rmSync(log, { force: true });
const lines = () =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line))
		: [];
const waitFor = async (test: (line: Record<string, unknown>) => boolean, ms: number) => {
	for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(250)) if (lines().some(test)) return true;
	return false;
};
const result: Record<string, unknown> = { candidate };

process.env.OMPDESK_PROTO_USER_DATA = userData;
await Bun.$`${base[0]} --register-protocol`.quiet().nothrow();
result.protocolKey = (await Bun.$`reg query ${"HKCU\\Software\\Classes\\ompdesk-proto\\shell\\open\\command"}`.nothrow().text()).trim();
const child = Bun.spawn(
	[...base, "--log", log, "--debug-port", String(port), "--selftest", "--query", "selftest=1",
		"--preview", "app://ompdesk/__shell/preview-test.html"],
	{ stdout: "ignore", stderr: "ignore", env: { ...process.env } },
);
result.settled = await waitFor(l => l.event === "page.report" && l.kind === "page.settled", 90_000);
await waitFor(l => l.event === "selftest.pdf", 30_000);
await Bun.sleep(3000);

result.playwright = (await Bun.$`bun ${join(import.meta.dir, "playwright-attach.ts")} ${port} ${join(out, `${candidate}-playwright.png`)}`.nothrow().text()).trim();
result.hittest = (
	await Bun.$`powershell -NoProfile -File ${join(import.meta.dir, "hittest.ps1")} -ProcessId ${child.pid}`
		.env({ ...process.env, HIT_SCAN: "1" })
		.nothrow()
		.text()
).trim();
await Bun.$`cmd /c start "" "ompdesk-proto://probe/${candidate}?x=1"`.env({ ...process.env }).nothrow();
result.deeplink = await waitFor(l => l.event === "deeplink" && String(l.url).includes(`probe/${candidate}`), 15_000);

const all = lines();
result.events = all
	.filter(l => /^(start|page\.url|page\.loaded|preview\.loaded|tray\.|deeplink|selftest\.)/.test(String(l.event)) || l.kind === "selftest.video_seek")
	.map(({ t, ...rest }) => rest);
result.rangeRequests = all.filter(l => l.event === "scheme.range").length;
await Bun.$`taskkill /T /F /PID ${child.pid}`.quiet().nothrow();
await child.exited;
await Bun.$`reg delete ${"HKCU\\Software\\Classes\\ompdesk-proto"} /f`.quiet().nothrow();
await Bun.write(join(out, `${candidate}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1).slice(0, 6000));
