// bun cef/test/cdp-eval.ts <port> <target-url-prefix> <expression>  : Runtime.evaluate (awaitPromise) on a page target, prints the JSON value.
const [port, prefix, expr] = Bun.argv.slice(2);
const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { url: string; webSocketDebuggerUrl: string }[];
const t = list.find((x) => x.url.startsWith(prefix));
if (!t) throw new Error("no target " + prefix + " in " + JSON.stringify(list.map((x) => x.url)));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = () => r(null)));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
ws.onmessage = (m) => {
  const d = JSON.parse(String(m.data));
  if (d.id === 1) {
    console.log(JSON.stringify(d.result?.result?.value ?? d, null, 1));
    process.exit(0);
  }
};
