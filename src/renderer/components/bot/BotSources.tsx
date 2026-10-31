/**
 * The chips under a bot reply: where its figures came from, as the reply's closing `Sources:` line named them
 * (shared/bot-sources.ts). A web address opens in the browser, a file in the viewer, a session opens when the list
 * knows it, a commit hash or unknown session id is copied; plain text is a chip that does nothing.
 */

import { FileText, GitCommit, Globe, MessageSquare, Quote } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import {
	type BotSource,
	type BotSourceKind,
	botSourcesFromActivity,
	parseBotSources,
} from "../../../shared/bot-sources";
import { botToolActivity } from "../../../shared/bot-tool-activity";
import type { AgentMessage } from "../../../shared/rpc-types";
import { switchSessionNow } from "../../hooks/use-session-switch";
import { copyText, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { openLocalPath, pathLocation } from "../../lib/markdown-path-link";
import { openExternal } from "../../lib/open-external";
import { useMessagesStore } from "../../stores/messages";
import { sessionListFeed } from "../../stores/session-list";
import { toast } from "../../stores/toast";
import { Tooltip } from "../common";
import { useBotTab } from "./bot-tab";

const ICONS: Record<BotSourceKind, ReactNode> = {
	url: <Globe aria-hidden className="size-3 shrink-0" />,
	commit: <GitCommit aria-hidden className="size-3 shrink-0" />,
	session: <MessageSquare aria-hidden className="size-3 shrink-0" />,
	file: <FileText aria-hidden className="size-3 shrink-0" />,
	text: <Quote aria-hidden className="size-3 shrink-0" />,
};

const CHIP =
	"inline-flex max-w-full items-center gap-1 rounded-full border border-(--sc-border) px-2 py-0.5 text-xs text-(--sc-text-muted)";

export function BotSources({ sources, derived = false }: { sources: BotSource[]; derived?: boolean }) {
	const t = useT();
	const bot = useBotTab();
	const copy = (value: string) =>
		void copyText(value).then(ok =>
			toast(
				ok
					? { variant: "success", message: t("common.copied") }
					: { variant: "error", message: t("common.copyFailed") },
			),
		);
	const act = (source: BotSource): { run: () => void; tip: string } | null => {
		switch (source.kind) {
			case "url":
				return { run: () => openExternal(source.value), tip: t("botSources.openUrl") };
			case "file": {
				const { path, line } = pathLocation(source.value, source.value);
				return { run: () => void openLocalPath(path, bot?.tabId ?? null, line), tip: t("botSources.openFile") };
			}
			case "commit":
				return { run: () => copy(source.value), tip: t("botSources.copyCommit") };
			case "session": {
				const known = sessionListFeed("global", bot?.device)
					.store.getState()
					.sessions.find(row => row.id === source.value);
				return known
					? { run: () => void switchSessionNow(known), tip: t("botSources.openSession") }
					: { run: () => copy(source.value), tip: t("botSources.copySession") };
			}
			default:
				return null;
		}
	};
	return (
		<div
			aria-label={t(derived ? "botSources.derivedLabel" : "botSources.label")}
			className="mt-2 flex flex-wrap items-center gap-1.5"
			data-bot-sources={derived ? "derived" : "named"}
			role="group"
		>
			<Tooltip content={derived ? t("botSources.derivedTip") : t("botSources.label")}>
				<span className="text-xs text-(--sc-text-muted)">
					{t(derived ? "botSources.derivedLabel" : "botSources.label")}
				</span>
			</Tooltip>
			{sources.map((source, index) => {
				const action = act(source);
				const content = (
					<>
						{ICONS[source.kind]}
						<span className="truncate">{source.label}</span>
					</>
				);
				if (!action)
					return (
						<span className={CHIP} data-kind={source.kind} key={`${index}:${source.value}`}>
							{content}
						</span>
					);
				return (
					<Tooltip content={action.tip} key={`${index}:${source.value}`}>
						{/* controls-ok: a chip is a pill-shaped button whose whole box is its own style */}
						<button
							className={cx(CHIP, "cursor-pointer hover:text-(--sc-text)")}
							data-kind={source.kind}
							onClick={action.run}
							type="button"
						>
							{content}
						</button>
					</Tooltip>
				);
			})}
		</div>
	);
}

/**
 * Where a reply that named no sources got its facts, when this message is its turn's last reply with text: what the
 * turn's own tool calls read, fetched or opened, from the transcript (it is saved with the session, so a reload or any
 * amount of later activity keeps them).
 */
function useTurnSources(message: AgentMessage | undefined): BotSource[] {
	const messages = useMessagesStore(state => state.messages);
	return useMemo(() => {
		if (!message) return [];
		const index = messages.findIndex(entry => entry.role === message.role && entry.timestamp === message.timestamp);
		if (index < 0) return [];
		for (let at = index + 1; at < messages.length; at++) {
			const next = messages[at] as AgentMessage;
			if (next.role === "user") break;
			// A later reply of the same turn carries the turn's sources.
			if (next.role === "assistant" && Array.isArray(next.content) && next.content.some(isTextBlock)) return [];
		}
		const calls: { at: string; kind: string; text: string; target?: { type: string; value: string } }[] = [];
		for (let at = index; at >= 0; at--) {
			const entry = messages[at] as AgentMessage;
			if (entry.role === "user") break;
			if (entry.role !== "assistant" || !Array.isArray(entry.content)) continue;
			const own = entry.content.flatMap(block => {
				const draft = block.type === "toolCall" ? botToolActivity(block.name, block.arguments) : null;
				return draft ? [{ at: new Date(0).toISOString(), ...draft }] : [];
			});
			calls.unshift(...own);
		}
		return botSourcesFromActivity(calls, { from: 0, to: Number.POSITIVE_INFINITY });
	}, [message, messages]);
}

function isTextBlock(block: unknown): boolean {
	return (
		typeof block === "object" &&
		block !== null &&
		"type" in block &&
		block.type === "text" &&
		"text" in block &&
		typeof block.text === "string" &&
		block.text.trim() !== ""
	);
}

/**
 * An assistant text block: in the bot's pane its body without the sources line and chips under it; the reply's last
 * block, when it named no sources, shows its turn's instead (`message` set); elsewhere untouched.
 */
export function AssistantText({ text, message }: { text: string; message?: AgentMessage }) {
	const bot = useBotTab();
	const split = bot ? parseBotSources(text) : null;
	const derived = useTurnSources(split ? undefined : message);
	if (!split)
		return (
			<>
				<MarkdownRenderer content={text} />
				{derived.length > 0 && <BotSources derived sources={derived} />}
			</>
		);
	return (
		<>
			{split.body && <MarkdownRenderer content={split.body} />}
			<BotSources sources={split.sources} />
		</>
	);
}
