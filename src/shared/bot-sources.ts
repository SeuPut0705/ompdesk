/**
 * The bot's replies end a figure, status or summary with one line `Sources: a · b` (resources/gui-bridge/agent-control.ts
 * `botSection`). This splits that line off a reply and names the kind of each source, so the bot's pane can draw chips.
 */

export type BotSourceKind = "url" | "commit" | "session" | "file" | "text";

export interface BotSource {
	kind: BotSourceKind;
	/** What the chip shows. */
	label: string;
	/** What a click acts on: the address, hash, id or path. */
	value: string;
}

const LABEL_LINE = /^[*_\s]*(?:sources|출처)[*_\s]*:[*_\s]*(.*)$/i;
const SEPARATOR = / · |·|;|, /;
const LINK = /^\[([^\]]*)\]\(([^)\s]+)\)$/;

function classify(label: string, raw: string): BotSource {
	const prefixed = /^(commit|session)\s+(.+)$/i.exec(raw);
	const word = prefixed?.[1].toLowerCase();
	const bare = prefixed ? prefixed[2].trim() : raw;
	if (/^https?:\/\/\S+$/i.test(bare)) return { kind: "url", label, value: bare };
	if (/^[0-9a-f]{16}$/i.test(bare) && word !== "commit") return { kind: "session", label, value: bare };
	if (/^[0-9a-f]{7,40}$/i.test(bare) && word !== "session") return { kind: "commit", label, value: bare };
	if (word === "session") return { kind: "session", label, value: bare };
	if (/[\\/]/.test(raw) || /\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?$/.test(raw)) return { kind: "file", label, value: raw };
	return { kind: "text", label, value: raw };
}

function parseItem(item: string): BotSource | null {
	let text = item.trim();
	if (!text) return null;
	const link = LINK.exec(text);
	if (link) {
		const [, label, url] = link;
		const source = classify(label || url, url);
		return { ...source, label: label || url };
	}
	text = text.replace(/^[*_`]+|[*_`]+$/g, "").trim();
	if (!text) return null;
	return classify(text, text);
}

/** The reply without its closing `Sources:` line, and the sources that line named; null when it has none. */
export function parseBotSources(text: string): { body: string; sources: BotSource[] } | null {
	const lines = text.split("\n");
	let last = lines.length - 1;
	while (last >= 0 && lines[last].trim() === "") last--;
	if (last < 0) return null;
	const match = LABEL_LINE.exec(lines[last].trim());
	if (!match) return null;
	const sources = match[1]
		.split(SEPARATOR)
		.map(parseItem)
		.filter((item): item is BotSource => item !== null);
	if (sources.length === 0) return null;
	return { body: lines.slice(0, last).join("\n").trimEnd(), sources };
}
