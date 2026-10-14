import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import { splitUrlScheme } from "@oh-my-pi/pi-tui/tools/url-scheme-host";
import { guard } from "./health";
import type { BridgeMethods } from "./types";

export function readGroupTarget(args: Record<string, unknown>): { path: string; selector?: string } | null {
	// Consult the actual host registry: rpc-ui's exported TUI namespace can have
	// no scheme host installed even while the coding-agent router is populated.
	const target = typeof args.path === "string" ? args.path : args.file_path;
	if (typeof target !== "string") return null;
	const url = splitUrlScheme(target);
	const spec = url && InternalUrlRouter.instance().spec(url.scheme);
	if (spec && spec.compactTranscript !== true) return null;
	const { path, sel } = splitPathAndSel(target);
	return { path, ...(sel === undefined ? {} : { selector: sel }) };
}

/** Decorate batches in the host: renderer never owns the URL registry or read selector grammar. */
export function decorateMessages<T extends { content?: unknown }>(messages: T[]): T[] {
	return messages.map(message => {
		if (!Array.isArray(message.content)) return message;
		return {
			...message,
			content: message.content.map(block => {
				if (block.type !== "toolCall" || block.name !== "read") return block;
				return { ...block, arguments: { ...block.arguments, __ompReadGroup: readGroupTarget(block.arguments) } };
			}),
		};
	});
}

let stop: (() => void) | undefined;
export const methods: BridgeMethods = guard("streamMetadata", {
	"stream_metadata.start": async (_params, env) => {
		stop?.();
		const session = env.session();
		let previousRate: number | null | undefined;
		const rate = () => {
			const current = session.tokenRate.rate();
			if (current === previousRate) return;
			previousRate = current;
			env.emit({ type: "token_rate", rate: current });
		};
		// At the message's end, not the call's execution start: the GUI receives the metadata with
		// the message (one batch), so live reads group as they will after the run commits.
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
				if (block.type !== "toolCall" || block.name !== "read") continue;
				env.emit({ type: "read_group_metadata", toolCallId: block.id, target: readGroupTarget(block.arguments) });
			}
		});
		const timer = setInterval(rate, 500);
		timer.unref();
		stop = () => {
			clearInterval(timer);
			unsubscribe();
		};
		rate();
		return null;
	},
});
