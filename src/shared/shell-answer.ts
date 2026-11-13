/** The body of the shell's `__ipc/invoke` answer, or a named failure when there is none: an empty body (a shell that
 *  answered nothing) must read as that, never as a JSON parse error that hides which call failed. */
export function invokeAnswerText(text: string, channel: string, status: number): string {
	if (text.trim() === "") throw new Error(`shell answered nothing for ${channel} (HTTP ${status})`);
	return text;
}
