import type { RuntimeErrorReport, RuntimeErrorSource } from "../../shared/ipc-types";

type RuntimeErrorExtras = Partial<Pick<RuntimeErrorReport, "componentStack" | "url" | "line" | "column" | "details">>;

function messageFor(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

export function createRuntimeErrorReport(
	source: RuntimeErrorSource,
	error: unknown,
	extras: RuntimeErrorExtras = {},
): RuntimeErrorReport {
	return {
		source,
		message: messageFor(error),
		stack: error instanceof Error ? error.stack : undefined,
		...extras,
	};
}

export function reportRuntimeError(source: RuntimeErrorSource, error: unknown, extras: RuntimeErrorExtras = {}): void {
	try {
		window.omp?.runtime?.report(createRuntimeErrorReport(source, error, extras));
	} catch {
		// Reporting is best effort and must never mask the original failure.
	}
}

let globalHandlersInstalled = false;

export function installGlobalRuntimeErrorHandlers(): void {
	if (globalHandlersInstalled) return;
	globalHandlersInstalled = true;

	window.addEventListener("error", event => {
		// A muted error ("Script error.", no file, no line, no error object) came from a script the browser counts as
		// cross-origin: every script of ours is same-origin and CORS-fetched (`crossorigin` on each tag), so it is a
		// script the browser or an extension injected; the user agent says which browser.
		const muted = !event.error && !event.filename && !event.lineno;
		reportRuntimeError("window-error", event.error ?? event.message, {
			url: event.filename || window.location.href,
			line: event.lineno || undefined,
			column: event.colno || undefined,
			...(muted ? { details: { muted: true, userAgent: navigator.userAgent } } : {}),
		});
	});

	window.addEventListener("unhandledrejection", event => {
		reportRuntimeError("unhandled-rejection", event.reason, { url: window.location.href });
	});
}
