// bun native/shell-prototype/cef/test/preview-host-child.ts
// Starts parent-window.exe (plain Win32 window), then preview-host --parent-hwnd <it> --bounds ...;
// proves the CEF window is a child of the foreign HWND (parent-window enumerates its children), that `bounds` over stdin moves it,
// that CDP works on the port, and that closing stdin ends the process.
import { spawn } from "bun";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dir;
const rel = resolve(here, "../target/release");
const html = pathToFileURL(resolve(here, "../../shell-assets/preview-test.html")).href;
const port = 9303;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, unknown> = {};

function lines(proc: ReturnType<typeof spawn>, sink: string[]) {
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l) sink.push(l);
      }
    }
  })();
}
async function until(sink: string[], pred: (l: string) => boolean, ms = 20000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const f = sink.find(pred);
    if (f) return f;
    await sleep(100);
  }
  throw new Error("timeout");
}

const parent = spawn([resolve(rel, "parent-window.exe"), "60"], { stdout: "pipe" });
const pl: string[] = [];
lines(parent, pl);
const hwnd = JSON.parse(await until(pl, (l) => l.includes('"hwnd"'))).hwnd as number;
out.parentHwnd = hwnd;

const host = spawn(
  [resolve(rel, "preview-host.exe"), "--url", html, "--cdp-port", String(port), "--parent-hwnd", String(hwnd), "--bounds", "20,40,600,400", "--log", resolve(here, "../target/preview-host-child.log.jsonl")],
  { stdin: "pipe", stdout: "pipe" },
);
const hl: string[] = [];
lines(host, hl);
let ok = true;
try {
  out.ready = await until(hl, (l) => l.includes('"ready"'));
  out.loaded = await until(hl, (l) => l.includes('"loaded"'));
  await sleep(800);
  const children = () => {
    const last = [...pl].reverse().find((l) => l.includes('"children"'));
    return last ? (JSON.parse(last).children as { hwnd: number; parent: number; class: string; pid: number; rect: number[]; visible: boolean }[]) : [];
  };
  const mine = children().filter((c) => c.pid === host.pid);
  out.childrenOfParent = mine;
  out.hostPid = host.pid;
  const top = mine.find((c) => c.parent === hwnd);
  out.cefWindowIsDirectChildOfForeignHwnd = !!top;
  out.initialRect = top?.rect;
  host.stdin.write("bounds 100 120 500 300\n");
  host.stdin.flush();
  await sleep(1000);
  const moved = children().find((c) => c.pid === host.pid && c.parent === hwnd);
  out.rectAfterBoundsCommand = moved?.rect;
  ok = ok && !!top && JSON.stringify(moved?.rect) === JSON.stringify([100, 120, 500, 300]);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  out.jsonList = list.map((x: { type: string; url: string; title: string }) => ({ type: x.type, url: x.url, title: x.title }));
  ok = ok && list.some((x: { type: string }) => x.type === "page");
  host.stdin.write(`navigate ${html}?second=1\n`);
  host.stdin.flush();
  await until(hl, (l) => l.includes("second=1"), 8000).then((l) => (out.navigateEvent = l));
} catch (e) {
  ok = false;
  out.error = String(e);
}
const t = Date.now();
host.stdin.end();
const code = await Promise.race([host.exited, sleep(8000).then(() => "timeout")]);
out.exitOnStdinClose = { code, ms: Date.now() - t };
if (code === "timeout") { host.kill(); ok = false; }
parent.kill();
out.ok = ok;
out.stdout = hl;
console.log(JSON.stringify(out, null, 1));
process.exit(ok ? 0 : 1);
