/**
 * The launch timing marks main writes to `gui-runtime.jsonl` (src/main/startup-timing.ts),
 * in the order a first launch reaches them. Renderer marks come over `runtime:startup-mark`.
 * - `app-ready`: Electron's `whenReady`.
 * - `window-created`: the first window exists (its renderer starts loading).
 * - `setup-detected`: machine setup's first detection finished.
 * - `omp-resolved`: the first tab knows its omp (`details.ok`; on Windows `omp --version` runs through cmd.exe).
 * - `bridge-connected`: the first tab's omp booted and its GUI bridge answered.
 * - `sidecar-ready`: the first tab's session takes commands (protocol negotiated, start gate passed).
 * - `omp-ready`: machine setup installed omp in this launch.
 * - `renderer-mounted`: the first window's React tree committed.
 * - `first-run-check`: the first-run gate asked whether any provider can serve.
 * - `first-run-visible`: the first-run provider step is on screen.
 */
export const STARTUP_MARKS = [
	"app-ready",
	"window-created",
	"setup-detected",
	"omp-resolved",
	"bridge-connected",
	"sidecar-ready",
	"omp-ready",
	"renderer-mounted",
	"first-run-check",
	"first-run-visible",
] as const;

export type StartupMark = (typeof STARTUP_MARKS)[number];

/** The marks a renderer may send. */
export const RENDERER_STARTUP_MARKS: readonly StartupMark[] = [
	"renderer-mounted",
	"first-run-check",
	"first-run-visible",
];

export function isRendererStartupMark(value: unknown): value is StartupMark {
	return typeof value === "string" && (RENDERER_STARTUP_MARKS as readonly string[]).includes(value);
}
