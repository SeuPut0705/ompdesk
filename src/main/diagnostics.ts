/**
 * "Copy diagnostics" (Settings › Updates & about): one redacted text report of this computer's
 * OMPdesk (versions, machine setup state, the last lines of the runtime log), built on demand
 * in main and handed to the renderer for a preview and a copy. Nothing is uploaded or written
 * anywhere; the report is the only thing that leaves, as the user's own clipboard paste.
 * Electron-free: the app's facts come in as `DiagnosticsSystem`, so tests need no app.
 */
import { IPC_COMMANDS } from "../shared/ipc-types";
import type { SetupItemState, SetupPresence, SetupState } from "../shared/setup";
import { redactDiagnosticsText } from "./redactor";
import { tailLogLines } from "./runtime-log-core";
import type { IpcRegistry } from "./web/ipc-registry";

/** Runtime-log lines in a report, newest last. */
export const DIAGNOSTICS_LOG_LINES = 100;
/** One log line is cut here: a stack can run to tens of kilobytes. */
const MAX_LINE_CHARS = 3_000;
const MAX_DETAIL_CHARS = 300;
/** The read window of a log tail: room for DIAGNOSTICS_LOG_LINES lines of stacks. */
const LOG_TAIL_BYTES = 512 * 1024;

export interface DiagnosticsSystem {
	appVersion: string;
	packaged: boolean;
	electron: string;
	chrome: string;
	node: string;
	platform: string;
	arch: string;
	/** `os.release()`: the kernel version. */
	osRelease: string;
	/** Electron's `process.getSystemVersion()`: the OS marketing version (macOS 15.5.0, Windows 10.0.22631). */
	osVersion: string;
	language: string | null;
}

export interface DiagnosticsInput {
	generatedAt: Date;
	system: DiagnosticsSystem;
	/** null until main's setup service exists. */
	setup: SetupState | null;
	/** Runtime-log lines, oldest first. */
	logLines: readonly string[];
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function presenceText(presence: SetupPresence | null): string {
	if (!presence) return "not checked yet";
	switch (presence.kind) {
		case "present":
			return `present${presence.version ? ` ${presence.version}` : ""}${presence.path ? ` (${presence.path})` : ""}`;
		case "missing":
			return "missing";
		case "outdated":
			return `outdated ${presence.version} < ${presence.minimum}`;
		case "broken":
			return `broken: ${clip(presence.detail, MAX_DETAIL_CHARS)}`;
	}
}

function setupItemLine(item: SetupItemState): string {
	const failure = item.failure
		? `; failed: ${item.failure.reason}${item.failure.exitCode != null ? ` exit ${item.failure.exitCode}` : ""}${item.failure.detail ? ` ${clip(item.failure.detail, MAX_DETAIL_CHARS)}` : ""}`
		: "";
	return `- ${item.id}${item.required ? " (required)" : ""}: ${item.phase}; ${presenceText(item.presence)}${failure}`;
}

function setupLines(setup: SetupState | null): string[] {
	if (!setup) return ["Machine setup: not started"];
	return [
		`Machine setup: omp ${setup.ompReady ? "ready" : "not ready"}, automatic install ${setup.automatic ? "on" : "off"}`,
		...setup.items.map(setupItemLine),
	];
}

/** The whole report, already redacted. */
export function buildDiagnosticsReport(input: DiagnosticsInput): string {
	const { system, setup } = input;
	const omp = setup?.items.find(item => item.id === "omp")?.presence;
	const ompVersion = omp?.kind === "present" ? omp.version : omp?.kind === "outdated" ? omp.version : null;
	const lines = [
		"OMPdesk diagnostics",
		"Redacted on this computer; nothing was uploaded. Check it before you share it.",
		`Generated: ${input.generatedAt.toISOString()}`,
		"",
		"## Versions",
		`OMPdesk: ${system.appVersion}${system.packaged ? "" : " (dev build)"}`,
		`omp: ${ompVersion ?? "not detected"}`,
		`Electron: ${system.electron}, Chrome ${system.chrome}, Node ${system.node}`,
		`OS: ${system.platform} ${system.osVersion} (kernel ${system.osRelease}), ${system.arch}`,
		`Language: ${system.language ?? "unknown"}`,
		"",
		"## Machine setup",
		...setupLines(setup),
		"",
		`## Runtime log (last ${DIAGNOSTICS_LOG_LINES} lines)`,
		...(input.logLines.length > 0
			? input.logLines.map(line => clip(redactDiagnosticsText(line), MAX_LINE_CHARS))
			: ["(empty)"]),
	];
	return redactDiagnosticsText(lines.join("\n"));
}

/** The newest lines across the current log and its `.1` archive, oldest first. */
export async function readDiagnosticsLog(logPath: string): Promise<string[]> {
	const current = await tailLogLines(logPath, DIAGNOSTICS_LOG_LINES, LOG_TAIL_BYTES);
	if (current.length >= DIAGNOSTICS_LOG_LINES) return current;
	const older = await tailLogLines(`${logPath}.1`, DIAGNOSTICS_LOG_LINES - current.length, LOG_TAIL_BYTES);
	return [...older, ...current];
}

export interface DiagnosticsDeps {
	system: () => DiagnosticsSystem;
	setupState: () => SetupState | null;
	runtimeLogPath: () => string;
	now?: () => Date;
}

/** The report as of now: what the preview shows and what the diagnostic bundle (diagnostic-bundle.ts) carries. */
export async function currentDiagnosticsReport(deps: DiagnosticsDeps): Promise<string> {
	return buildDiagnosticsReport({
		generatedAt: (deps.now ?? (() => new Date()))(),
		system: deps.system(),
		setup: deps.setupState(),
		logLines: await readDiagnosticsLog(deps.runtimeLogPath()),
	});
}

export function registerDiagnosticsIpc(ipc: Pick<IpcRegistry, "handle">, deps: DiagnosticsDeps): void {
	ipc.handle(IPC_COMMANDS.DIAGNOSTICS_BUILD, () => currentDiagnosticsReport(deps));
}
