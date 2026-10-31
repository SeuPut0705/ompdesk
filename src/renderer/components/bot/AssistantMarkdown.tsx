/**
 * An assistant reply's text. In the bot's pane its trailing `Sources:` line becomes chips (`BotSources`, part of the
 * bot's lazy chunk, so a paired phone's first screen carries none of it); everywhere else, and until the chunk is
 * there, the plain Markdown.
 */
import { MarkdownRenderer } from "../../lib/markdown";
import { useBotDeskModule, useBotTab } from "./bot-tab";

export function AssistantMarkdown({ text }: { text: string }) {
	const bot = useBotTab();
	const desk = useBotDeskModule(bot !== null);
	return bot && desk ? <desk.AssistantText text={text} /> : <MarkdownRenderer content={text} />;
}
