// bun native/shell-prototype/cef/test/preview-host-offscreen.ts
// Starts preview-host --offscreen, checks /json/list, a Page.startScreencast frame, a CDP click on #target, exit on stdin close.
import { spawn } from "bun";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dir;
const exe = resolve(here, "../target/release/preview-host.exe");
const html = pathToFileURL(resolve(here, "../../shell-assets/preview-test.html")).href;
const port = 9303;
const t0 = Date.now();
const out: Record<string, unknown> = {};
const proc = spawn([exe, "--url", html, "--cdp-port", String(port), "--offscreen", "--size", "800,600", "--log", resolve(here, "../target/preview-host-offscreen.log.jsonl")], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const lines: string[] = [];
const waiters: { pred: (o: any) => boolean; res: (o: any) => void }[] = [];
(async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout as any) {
    buf += dec.decode(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!l) continue;
      lines.push(l);
      let o: any;
      try { o = JSON.parse(l); } catch { continue; }
      for (const w of [...waiters]) if (w.pred(o)) { waiters.splice(waiters.indexOf(w), 1); w.res(o); }
    }
  }
})();
const waitEvent = (name: string, ms = 20000) =>
  new Promise<any>((res, rej) => {
    const prior = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o?.event === name);
    if (prior) return res(prior);
    const t = setTimeout(() => rej(new Error("timeout waiting for " + name)), ms);
    waiters.push({ pred: (o) => o.event === name, res: (o) => { clearTimeout(t); res(o); } });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = true;
try {
  out.ready = await waitEvent("ready");
  out.loaded = await waitEvent("loaded");
  out.msToLoaded = Date.now() - t0;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  out.jsonList = list.map((x: any) => ({ type: x.type, url: x.url, title: x.title }));
  out.jsonVersion = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
  const page = list.find((x: any) => x.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = () => res(null); ws.onerror = (e) => rej(new Error("ws error")); });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const frames: { t: number; bytes: number; sig: string }[] = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); }
    if (d.method === "Page.screencastFrame") {
      frames.push({ t: Date.now() - t0, bytes: d.params.data.length, sig: d.params.data.slice(200, 260) });
      send("Page.screencastFrameAck", { sessionId: d.params.sessionId });
    }
  };
  const send = (method: string, params: any = {}) =>
    new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });
  for (let i = 0; i < 40 && frames.length < 1; i++) await sleep(100);
  out.firstFrame = frames[0] ?? null;
  const before = frames.length;
  const r = await send("Runtime.evaluate", { expression: "(()=>{const r=document.querySelector('#target').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()", returnByValue: true });
  const pt = JSON.parse(r.result.result.value);
  const ev = (type: string, buttons: number) => ({ type, x: pt.x, y: pt.y, button: "left", buttons, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
  await send("Input.dispatchMouseEvent", ev("mousePressed", 1));
  await send("Input.dispatchMouseEvent", ev("mouseReleased", 0));
  await sleep(600);
  const clicks = (await send("Runtime.evaluate", { expression: "window.__clicks", returnByValue: true })).result.result.value;
  out.click = { x: pt.x, y: pt.y, clicks };
  out.framesBeforeClick = before;
  out.framesAfterClick = frames.length;
  out.distinctFrameSigs = new Set(frames.map((f) => f.sig)).size;
  ok = ok && frames.length > 0 && clicks === 1;
  await send("Page.stopScreencast");
  ws.close();
} catch (e) {
  ok = false;
  out.error = String(e);
}
// exit when stdin closes
const tClose = Date.now();
proc.stdin.end();
const exitCode = await Promise.race([proc.exited, sleep(8000).then(() => "timeout")]);
out.exitOnStdinClose = { exitCode, ms: Date.now() - tClose };
if (exitCode === "timeout") { proc.kill(); ok = false; }
out.ok = ok;
out.stdout = lines;
console.log(JSON.stringify(out, null, 1));
process.exit(ok ? 0 : 1);
