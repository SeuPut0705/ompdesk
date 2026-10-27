/**
 * No xd:// device twice in a request (rules and the measurement: xdev-notice-core.ts). Stock's mount notice names the
 * devices the system prompt already lists as soon as an extension returns a `systemPrompt` from `before_agent_start`,
 * which OMPdesk's sections do on every turn; this drops such a notice from what the model is sent (the journal keeps
 * it) through the public `context` hook, reading the outgoing prompt with the context's `getSystemPrompt()`. Without
 * that function the notice stays. The hook leaves the request path while the session holds no notice (context-hook.ts).
 */
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { installContextHook } from "./context-hook";
import { guard } from "./health";
import { dropCoveredNotices, XDEV_NOTICE_TYPE } from "./xdev-notice-core";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	installContextHook(pi, XDEV_NOTICE_TYPE, (event: ContextEvent, ctx: ExtensionContext) => {
		if (typeof ctx.getSystemPrompt !== "function") return undefined;
		const messages = dropCoveredNotices(event.messages, ctx.getSystemPrompt());
		return messages === event.messages ? undefined : { messages: [...messages] };
	});
}

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("xdevNotice", {});
