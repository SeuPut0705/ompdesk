/**
 * The chips under a bot reply: where its figures came from, as the reply's closing `Sources:` line named them
 * (shared/bot-sources.ts). A web address opens in the browser, a file in the viewer, a session opens when the list
 * knows it, a commit hash or unknown session id is copied; plain text is a chip that does nothing.
 */

import { FileText, GitCommit, Globe, MessageSquare, Quote } from "lucide-react";
import type { ReactNode } from "react";
import { type BotSource, type BotSourceKind, parseBotSources } from "../../../shared/bot-sources";
import { switchSessionNow } from "../../hooks/use-session-switch";
import { copyText, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { openLocalPath, pathLocation } from "../../lib/markdown-path-link";
import { openExternal } from "../../lib/open-external";
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

export function BotSources({ sources }: { sources: BotSource[] }) {
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
		<div aria-label={t("botSources.label")} className="mt-2 flex flex-wrap items-center gap-1.5" role="group">
			<span className="text-xs text-(--sc-text-muted)">{t("botSources.label")}</span>
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

/** An assistant text block: in the bot's pane its body without the sources line, chips under it; elsewhere untouched. */
export function AssistantText({ text }: { text: string }) {
	const bot = useBotTab();
	const split = bot ? parseBotSources(text) : null;
	if (!split) return <MarkdownRenderer content={text} />;
	return (
		<>
			{split.body && <MarkdownRenderer content={split.body} />}
			<BotSources sources={split.sources} />
		</>
	);
}
