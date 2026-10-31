/**
 * An assistant reply's text. In the bot's pane its trailing `Sources:` line becomes chips, or, for the reply's last
 * text block when it named none, the sources its turn read (`BotSources`, part of the bot's lazy chunk, so a paired
 * phone's first screen carries none of it); everywhere else, and until the chunk is there, the plain Markdown.
 */
import type { AgentMessage } from "../../../shared/rpc-types";
import { MarkdownRenderer } from "../../lib/markdown";
import { useBotDeskModule, useBotTab } from "./bot-tab";

export function AssistantMarkdown({ text, message }: { text: string; message?: AgentMessage }) {
	const bot = useBotTab();
	const desk = useBotDeskModule(bot !== null);
	return bot && desk ? (
		<desk.AssistantText text={text} {...(message ? { message } : {})} />
	) : (
		<MarkdownRenderer content={text} />
	);
}
