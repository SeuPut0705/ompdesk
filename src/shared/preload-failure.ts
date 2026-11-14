/**
 * What the shell's page script (`src/preload/shell.ts`) reports when its own body throws: Electron's `preload-error`
 * carries an `Error`, the shell's event the same two fields as plain text (`message`, `stack`). Anything can be thrown,
 * so a value that is not an `Error` is turned into text without ever throwing itself.
 */
export function describePreloadFailure(error: unknown): { message: string; stack: string } {
	if (error instanceof Error) {
		const message = String(error.message);
		return {
			message,
			stack: typeof error.stack === "string" && error.stack ? error.stack : `${error.name}: ${message}`,
		};
	}
	let message: string;
	try {
		message = String(error);
	} catch {
		message = "unprintable value thrown";
	}
	return { message, stack: message };
}
