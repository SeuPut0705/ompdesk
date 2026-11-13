/**
 * Captures the Preview's TypeScript rules as `crates/shell/src/preview_core/captured.json` (PROTOCOL.md §15.3), headed
 * by the commit they were read from. Run from the repository root while the TypeScript still exists:
 *   bun scripts/shell-port/capture-preview.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
// Dynamic on purpose: the slice deletes these modules once captured, and this script must still compile after.
const imp = (p: string) => import(path.join(root, p));
const tables: Record<string, unknown> = {
	commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
};
const save = (name: string, value: unknown) => {
	tables[name] = value;
};
// JSON has no NaN/Infinity: numbers that are not finite travel as strings.
const num = (v: number) => (Number.isFinite(v) ? v : String(v));

const shared = await imp("src/shared/preview.ts");
const nav = await imp("src/main/preview/visual-navigation.ts");
const relay = await imp("src/main/preview/agent-relay.ts");
const input = await imp("src/main/web/preview-input.ts");
const pacerMod = await imp("src/main/web/preview-pacer.ts");
const dialog = await imp("src/main/web/preview-dialog.ts");
const scripts = await imp("src/main/preview/page-scripts.ts");
const { applyPreviewLayout, fitPreviewFrame } = await imp("src/main/preview/layout.ts");

// --- layout
{
	const coords = [-50.6, -1, 0, 0.4, 0.5, 1.5, 12.49, 12.5, 100, 333.3, 1999.5, Number.NaN, Number.POSITIVE_INFINITY];
	const sizes = [-10, 0, 0.4, 390, 768.2, 5000, Number.NaN];
	const frames = Object.values(shared.PREVIEW_VIEWPORTS) as Array<{ width: number; height: number } | null>;
	const windows = [
		{ width: 0, height: 0 },
		{ width: 800, height: 600 },
		{ width: 1920, height: 1080 },
	];
	const fit: unknown[] = [];
	const apply: unknown[] = [];
	for (const x of [coords[0], coords[6], coords[11]])
		for (const y of [coords[3], coords[7]])
			for (const width of sizes)
				for (const height of [sizes[1], sizes[2], sizes[3], sizes[5], sizes[6]]) {
					const bounds = { x, y, width, height };
					for (const frame of frames) {
						const r = fitPreviewFrame(bounds, frame);
						fit.push({
							bounds: [num(x), num(y), num(width), num(height)],
							frame: frame ? [frame.width, frame.height] : null,
							out: [num(r.bounds.x), num(r.bounds.y), num(r.bounds.width), num(r.bounds.height)],
							scale: num(r.scale),
						});
					}
					for (const viewport of windows)
						for (const visible of [true, false]) {
							const calls: unknown[] = [];
							applyPreviewLayout(
								{
									setBounds: b => calls.push({ setBounds: [b.x, b.y, b.width, b.height] }),
									setVisible: v => calls.push({ setVisible: v }),
								},
								bounds,
								visible,
								viewport,
							);
							apply.push({
								bounds: [num(x), num(y), num(width), num(height)],
								visible,
								window: [viewport.width, viewport.height],
								calls,
							});
						}
				}
	save("layout", { fit, apply });
}

// --- urls
{
	const corpus = [
		"",
		" ",
		"http://example.com",
		"HTTP://EXAMPLE.COM/A?b#c",
		"https://example.com:443/",
		"https://example.com:8443/x/../y",
		"http://user@example.com/",
		"http://user:pw@example.com/",
		"http://:pw@example.com/",
		"https://münchen.de/ä",
		"https://xn--mnchen-3ya.de/",
		"http://127.0.0.1:3000/",
		"http://127.1/",
		"http://0x7f.0.0.1/",
		"http://2130706433/",
		"http://localhost/",
		"http://LOCALHOST:8080/",
		"http://localhost./",
		"http://[::1]/",
		"http://[0:0:0:0:0:0:0:1]:9/",
		"http://[::ffff:127.0.0.1]/",
		"http://sub.localhost/",
		"  https://example.com/path with space  ",
		"https://example.com/%zz",
		"https://example.com/\u0000",
		"https://exa mple.com/",
		"https://example.com\\path\\x",
		"http:example.com",
		"https:/example.com",
		"//example.com",
		"example.com",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"file://localhost/c:/x",
		"data:text/html,hi",
		"blob:https://example.com/uuid",
		"about:blank",
		"about:blank#x",
		"about:blank?x",
		"about:BLANK",
		"about:srcdoc",
		"about:srcdoc?x#y",
		"about:srcdoc/x",
		"about:config",
		"chrome://settings",
		"ws://127.0.0.1:1/",
		"omp-visual://v3-0123456789abcdef/index.html",
		"omp-visual://V3-0123456789ABCDEF/index.html",
		"OMP-VISUAL://v3-0123456789abcdef/a%20b/c.png",
		"omp-visual://v03-0123456789abcdef/",
		"omp-visual://v0-0123456789abcdef/",
		"omp-visual://v99999999999999999999-0123456789abcdef/",
		"omp-visual://v3-0123456789abcde/",
		"omp-visual://v3-0123456789abcdefa/",
		"omp-visual://v3-0123456789abcdeg/",
		"omp-visual://v3-0123456789abcdef:80/",
		"omp-visual://user@v3-0123456789abcdef/",
		"omp-visual://v3-fedcba9876543210/x?y#z",
		"omp-visual:v3-0123456789abcdef/x",
		"omp-visual:///v3-0123456789abcdef/x",
		"https://v3-0123456789abcdef/",
	];
	const shownIds = [null, "0123456789abcdef", "fedcba9876543210"];
	const rows = corpus.map(url => ({
		url,
		previewUrl: shared.previewUrl(url),
		isLoopback: shared.isLoopbackUrl(url),
		parseVisual: nav.parseVisualUrl(url),
		mayNavigate: shownIds.map(shown => nav.visualMayNavigate(shown, url)),
	}));
	const relayUrls = [
		"http://127.0.0.1:41234",
		"http://127.0.0.1:41234/",
		"http://127.0.0.1:41234//",
		"http://127.0.0.1:41234/x",
		"http://127.0.0.1:41234/?a",
		"http://127.0.0.1:41234/#a",
		"http://127.0.0.1",
		"http://127.0.0.1:80",
		"http://127.0.0.1:0",
		"https://127.0.0.1:41234",
		"ws://127.0.0.1:41234",
		"http://localhost:41234",
		"http://127.0.0.2:41234",
		"http://u@127.0.0.1:41234",
		"http://u:p@127.0.0.1:41234",
		"http://127.1:41234",
		"http://0x7f000001:41234",
		"HTTP://127.0.0.1:041234",
		"not a url",
	];
	const tokens = [
		"abcdefghijklmnop",
		"abcdefghijklmno",
		"abc_def-ghijklmnopqrstuvwxyz0123",
		"abcdefghijklmnop!",
		"",
		"ébcdefghijklmnop",
	];
	const relayRows = relayUrls.flatMap(url =>
		tokens.map(token => ({ url, token, out: relay.relayExtensionUrl(url, token) })),
	);
	save("urls", { rows, relay: relayRows });
}

// --- relay commands
{
	const domains = [
		"Accessibility",
		"Animation",
		"Audits",
		"CSS",
		"Console",
		"DOM",
		"DOMDebugger",
		"DOMSnapshot",
		"DOMStorage",
		"Debugger",
		"Emulation",
		"Fetch",
		"HeapProfiler",
		"IO",
		"Input",
		"Inspector",
		"Log",
		"Media",
		"Network",
		"Overlay",
		"Page",
		"Performance",
		"PerformanceTimeline",
		"Profiler",
		"Runtime",
		"Security",
		"ServiceWorker",
		"Storage",
		"Browser",
		"SystemInfo",
		"Tethering",
		"Tracing",
		"Memory",
		"Target",
		"Schema",
		"",
	];
	const methods = [
		...domains.map(d => `${d}.enable`),
		"Target.setAutoAttach",
		"Target.detachFromTarget",
		"Target.getTargets",
		"Target.attachToTarget",
		"Target.createTarget",
		"DOM.setFileInputFiles",
		"Input.setInterceptDrags",
		"Page.close",
		"Page.crash",
		"Page.setDownloadBehavior",
		"Page.setInterceptFileChooserDialog",
		"Security.handleCertificateError",
		"Security.setIgnoreCertificateErrors",
		"Security.setOverrideCertificateErrors",
		"Tracing.start",
		"Page",
		"Page.",
		".enable",
		"page.navigate",
		"Runtime.evaluate",
	];
	const rows: unknown[] = [];
	for (const method of methods)
		for (const block of [false, true])
			rows.push({ method, params: null, block, out: relay.refusedCommand(method, undefined, block) });
	const navUrls = [
		undefined,
		3,
		"about:blank",
		"about:blank#x",
		"https://example.com/",
		"http://localhost:3000/",
		"http://[::1]/",
		"file:///x",
		"javascript:1",
		"chrome://gpu",
		"",
	];
	for (const url of navUrls)
		for (const block of [false, true]) {
			const params = url === undefined ? {} : { url };
			rows.push({
				method: "Page.navigate",
				params,
				block,
				out: relay.refusedCommand("Page.navigate", params, block),
			});
		}
	for (const url of [undefined, "https://example.com/a.map", "http://localhost/x", "file:///etc/hosts", "data:,x", 5])
		for (const params of [url === undefined ? {} : { url }, null, "str"]) {
			rows.push({
				method: "Network.loadNetworkResource",
				params,
				block: false,
				out: relay.refusedCommand("Network.loadNetworkResource", params, false),
			});
		}
	for (const params of [{}, { entryId: 3 }, { entryId: 3.5 }, { entryId: "3" }, null])
		rows.push({
			method: "Page.navigateToHistoryEntry",
			params,
			block: false,
			out: relay.refusedCommand("Page.navigateToHistoryEntry", params, false),
		});
	const drags = [
		undefined,
		{},
		{ files: [] },
		{ files: ["/etc/passwd"] },
		{ files: null },
		{ files: "x" },
		{ items: [] },
		{ items: [{ mimeType: "text/plain", data: "hello" }] },
		{ items: [{ mimeType: "text/uri-list", data: "file:///etc/passwd" }] },
		{ items: [{ mimeType: "text/uri-list", data: "  FILE:///x" }] },
		{ items: [{ mimeType: "text/plain", data: "a\nfile:///x" }] },
		{ items: [{ mimeType: "text/plain", data: "https://x/file:" }] },
		{ items: [null, 3, { n: 1 }] },
		{ items: "file:///x" },
	];
	for (const data of drags) {
		const params = data === undefined ? {} : { type: "drop", data };
		rows.push({
			method: "Input.dispatchDragEvent",
			params,
			block: false,
			out: relay.refusedCommand("Input.dispatchDragEvent", params, false),
		});
	}
	save("relay-commands", rows);
}

// --- input
{
	const surfaces = [
		{ width: 390, height: 844, scale: 1 },
		{ width: 1, height: 1, scale: 2 },
		{ width: 0, height: 0, scale: 0.75 },
		{ width: 780, height: 1688, scale: 1.333 },
	];
	const points = [
		[0, 0],
		[0.5, 0.5],
		[1, 1],
		[-0.2, 1.7],
		[0.12345, 0.98765],
		[0.4999, 0.5001],
	];
	const singles: unknown[] = [
		...points.flatMap(([x, y]) => [
			{ t: "tap", x, y },
			{ t: "tap", x, y, count: 2 },
			{ t: "tap", x, y, count: 3 },
			{ t: "context", x, y },
			{ t: "hover", x, y },
		]),
		...[
			[0, 0],
			[10, -20],
			[-5000.4, 5000.6],
			[7000, -7000],
			[0.4, -0.6],
			[-0, 0],
		].map(([dx, dy]) => ({ t: "wheel", x: 0.5, y: 0.5, dx, dy })),
		...[0.1, 0.5, 1, 1.25, 2, 9].map(scale => ({ t: "pinch", scale })),
		{ t: "text", text: "한글 text" },
		...[
			"a",
			"A",
			"é",
			"😀",
			"Enter",
			" ",
			"ArrowLeft",
			"ArrowRight",
			"ArrowUp",
			"ArrowDown",
			"Backspace",
			"Delete",
			"Tab",
			"Escape",
			"Home",
			"End",
			"PageUp",
			"PageDown",
			"Insert",
			"F1",
			"F9",
			"F10",
			"F24",
			"F25",
			"F0",
			"Shift",
			"Unidentified",
			"ab",
		].flatMap(key => [
			{ t: "key", key },
			{ t: "key", key, mods: ["shift"] },
			{ t: "key", key, mods: ["control"] },
			{ t: "key", key, mods: ["meta", "alt"] },
			{ t: "key", key, mods: [] },
		]),
	];
	const sequences: unknown[][] = [
		[{ t: "drag", phase: "move", x: 0.5, y: 0.5 }],
		[{ t: "drag", phase: "end", x: 0.5, y: 0.5 }],
		[
			{ t: "drag", phase: "start", x: 0.1, y: 0.1 },
			{ t: "hover", x: 0.2, y: 0.2 },
			{ t: "drag", phase: "move", x: 0.3, y: 0.3 },
			{ t: "drag", phase: "end", x: 0.4, y: 0.4 },
			{ t: "drag", phase: "move", x: 0.5, y: 0.5 },
			{ t: "hover", x: 0.6, y: 0.6 },
		],
	];
	const mapRows: unknown[] = [];
	for (const surface of surfaces) {
		for (const one of singles)
			mapRows.push({ surface, inputs: [one], ops: new input.InputMapper().map(one, surface) });
		for (const seq of sequences) {
			const mapper = new input.InputMapper();
			mapRows.push({ surface, inputs: seq, ops: seq.map(i => mapper.map(i, surface)) });
		}
	}
	const schemaCases: unknown[] = [
		{ t: "tap", x: 0.5, y: 0.5 },
		{ t: "tap", x: 0.5, y: 0.5, count: 4 },
		{ t: "tap", x: "0.5", y: 0.5 },
		{ t: "tap", x: 0.5 },
		{ t: "tap", x: 0.5, y: 0.5, extra: 1 },
		{ t: "context", x: 2, y: -1 },
		{ t: "drag", phase: "middle", x: 0, y: 0 },
		{ t: "wheel", x: 0, y: 0, dx: 1, dy: 2 },
		{ t: "pinch", scale: 0 },
		{ t: "pinch", scale: -1 },
		{ t: "key", key: "" },
		{ t: "key", key: "x".repeat(32) },
		{ t: "key", key: "x".repeat(33) },
		{ t: "key", key: "a", mods: ["shift", "shift", "alt", "meta"] },
		{ t: "key", key: "a", mods: ["shift", "shift", "alt", "meta", "control"] },
		{ t: "key", key: "a", mods: ["super"] },
		{ t: "text", text: "" },
		{ t: "text", text: "x".repeat(10000) },
		{ t: "text", text: "x".repeat(10001) },
		{ t: "nope" },
		null,
		[],
	];
	const schema = schemaCases.map(value => ({ value, ok: input.previewStreamInputSchema.safeParse(value).success }));
	const batch = [0, 1, 64, 65].map(n => ({
		n,
		ok: input.previewStreamBatchSchema.safeParse(Array.from({ length: n }, () => ({ t: "hover", x: 0, y: 0 })))
			.success,
	}));
	save("input", { map: mapRows, schema, batch });
}

// --- pacer
{
	type Step = { at: number; op: string; arg?: unknown };
	const scripts: Array<{ maxFps: number; steps: Step[] }> = [
		{
			maxFps: 12,
			steps: [
				{ at: 0, op: "readiness" },
				{ at: 0, op: "markDirty" },
				{ at: 0, op: "readiness" },
				{ at: 0, op: "sent" },
				{ at: 10, op: "markDirty" },
				{ at: 10, op: "readiness" },
				{ at: 50, op: "ack", arg: 1 },
				{ at: 50, op: "readiness" },
				{ at: 90, op: "readiness" },
				{ at: 90, op: "quality" },
			],
		},
		{
			maxFps: 12,
			steps: [
				{ at: 0, op: "markDirty" },
				{ at: 0, op: "sent" },
				{ at: 1, op: "markDirty" },
				{ at: 1, op: "markDirty" },
				{ at: 3001, op: "readiness" },
				{ at: 3001, op: "skipped" },
				{ at: 3001, op: "sent" },
				{ at: 3200, op: "ack", arg: 2 },
				{ at: 3200, op: "quality" },
				{ at: 3200, op: "roundTrip" },
			],
		},
		{
			maxFps: 12,
			steps: [
				{ at: 0, op: "markUrgent" },
				{ at: 0, op: "sent" },
				{ at: 5, op: "ack", arg: null },
				{ at: 5, op: "markUrgent" },
				{ at: 5, op: "readiness" },
				{ at: 5, op: "sent" },
				{ at: 700, op: "ack", arg: 5 },
				{ at: 700, op: "quality" },
				{ at: 700, op: "markDirty" },
				{ at: 700, op: "readiness" },
			],
		},
		{
			maxFps: 0.5,
			steps: [
				{ at: 0, op: "setMaxFps", arg: 0 },
				{ at: 0, op: "markDirty" },
				{ at: 0, op: "sent" },
				{ at: 1, op: "ack", arg: 0 },
				{ at: 1, op: "ack", arg: 1 },
				{ at: 2, op: "markDirty" },
				{ at: 2, op: "readiness" },
				{ at: 999, op: "readiness" },
				{ at: 1001, op: "readiness" },
			],
		},
		{
			maxFps: 30,
			steps: [100, 250, 400, 650, 50, 30].flatMap((rtt, i) => {
				const at = i * 5000;
				return [
					{ at, op: "markDirty" },
					{ at, op: "sent" },
					{ at: at + rtt, op: "ack", arg: i + 1 },
					{ at: at + rtt, op: "quality" },
					{ at: at + rtt, op: "roundTrip" },
				];
			}),
		},
	];
	const rows = scripts.map(({ maxFps, steps }) => {
		let now = 0;
		const p = new pacerMod.FramePacer({ maxFps, now: () => now });
		const results = steps.map(step => {
			now = step.at;
			switch (step.op) {
				case "readiness":
					return p.readiness();
				case "markDirty":
					p.markDirty();
					return null;
				case "markUrgent":
					p.markUrgent();
					return null;
				case "sent":
					return p.sent();
				case "ack":
					p.ack(step.arg as number | null);
					return null;
				case "quality":
					return p.quality();
				case "skipped":
					return p.skipped;
				case "roundTrip":
					return p.roundTrip;
				case "setMaxFps":
					p.setMaxFps(step.arg as number);
					return null;
			}
			throw new Error(step.op);
		});
		return { maxFps, steps, results };
	});
	const profiles = [0, 320, 599, 599.9, 600, 1024].flatMap(width =>
		[Number.NaN, -1, 0, 0.5, 1, 1.5, 2, 3].map(dpr => ({
			width,
			dpr: num(dpr),
			out: pacerMod.streamProfile(width, dpr),
		})),
	);
	save("pacer", { rows, profiles });
}

// --- dialog, page tools, pdf names
{
	const answers = [
		{ accept: true, text: "typed" },
		{ accept: true, text: null },
		{ accept: false, text: "typed" },
		{ accept: true, text: "" },
	];
	const requests = [
		{ kind: "alert", message: "m", initial: null },
		{ kind: "confirm", message: "m", initial: null },
		{ kind: "prompt", message: "m", initial: "init" },
		{ kind: "prompt", message: "m", initial: null },
	];
	const returns = requests.flatMap(request =>
		answers.map(answer => ({ request, answer, out: dialog.dialogReturnValue(request, answer) })),
	);
	const schema = [
		{ kind: "alert", message: "", initial: null },
		{ kind: "prompt", message: "x".repeat(2000), initial: "x".repeat(2000) },
		{ kind: "prompt", message: "x".repeat(2001), initial: null },
		{ kind: "prompt", message: "m" },
		{ kind: "beforeunload", message: "m", initial: null },
	].map(value => ({ value, ok: dialog.dialogRequestSchema.safeParse(value).success }));
	save("dialog", { returns, schema, channel: dialog.DIALOG_CHANNEL, preload: dialog.DIALOG_PRELOAD_SOURCE });
	const calls = [
		["pick"],
		["region"],
		["cancel"],
		["tweaks"],
		["clearVariables"],
		["choose"],
		["parent", "#a > b"],
		["highlight", "div:nth-of-type(2)"],
		["pins", [{ n: 1, selector: "#x" }]],
		["setVariable", "--accent", "red; }</script>\u2028"],
	];
	const prelude = scripts.pageCall("x").slice(0, -'\nglobalThis.__ompdesk["x"](...[])'.length);
	save("page-tools", {
		prelude,
		calls: calls.map(([method, ...args]) => ({
			method,
			args,
			call: scripts.pageCall(method as string, ...args).slice(prelude.length),
		})),
	});
}

const out = path.join(root, "native/ompdesk/crates/shell/src/preview_core/captured.json");
writeFileSync(out, `${JSON.stringify(tables)}\n`);
console.log(`captured into ${out}`);
