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
		reportRuntimeError("window-error", event.error ?? event.message, {
			url: event.filename || window.location.href,
			line: event.lineno || undefined,
			column: event.colno || undefined,
		});
	});

	window.addEventListener("unhandledrejection", event => {
		reportRuntimeError("unhandled-rejection", event.reason, { url: window.location.href });
	});
}
