import { parseAgentMessage } from "../../shared/agent-control";

/**
 * What a person reads of a user prompt: a message another session's agent sent (see `parseAgentMessage`)
 * shows its body, never the wrapper tag. What goes to omp is never passed through this.
 */
export function promptDisplayText(text: string): string {
	return parseAgentMessage(text.trim())?.body ?? text;
}
