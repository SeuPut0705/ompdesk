/**
 * The conversations the bot ended (its daily renewal, a full one, New conversation), as a section of its board: one
 * row each, newest first (absent while there is none), from the session list of the computer the bot runs on
 * (`bot: "past"`). A row opens it read-only, with `EndedConversationNote` in the composer's place
 * (`ended-conversation.tsx`). Main deletes each with its files 7 days after it ended.
 */
import { History } from "lucide-react";
import { useMemo } from "react";
import { useStore } from "zustand";
import { uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ensureBotPath, useBotStore } from "../../stores/bot";
import { sessionListFeed } from "../../stores/session-list";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { LinkButton } from "../common";
import { BoardRow, BoardSection, KindMark } from "../layout/work-board/board-parts";

const WHEN: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

function openPast(sessionPath: string, device: string | undefined): void {
	const tabs = useTabsStore.getState();
	const held = tabs.tabs.find(tab => tab.sessionPath === sessionPath && tab.device === device);
	if (held) void tabs.switchTab(held.id);
	else void tabs.openTab({ sessionPath, kind: "chat", ...(device === undefined ? {} : { device }) });
}

export function BotPastConversationsSection({ device }: { device?: string }) {
	const t = useT();
	// The pane holds the list (`useEndedBotConversation` beside the composer, `HostBotPane` for a host's bot).
	const sessions = useStore(sessionListFeed("global", device).store, state => state.sessions);
	const past = useMemo(
		() => sessions.filter(row => row.bot === "past").toSorted((a, b) => b.modified.localeCompare(a.modified)),
		[sessions],
	);
	const when = (iso: string) => new Date(iso).toLocaleString(uiLocale(), WHEN);
	if (past.length === 0) return null;
	return (
		<BoardSection
			count={past.length > 0 ? past.length : undefined}
			id="pastConversations"
			summary={{
				lead: past[0]
					? t("botHome.past.row", { start: when(past[0].created), end: when(past[0].modified) })
					: t("botHome.past.none"),
				count: past.length > 0 ? past.length : undefined,
			}}
			title={t("botHome.past.title")}
		>
			{past.map(row => {
				const label = t("botHome.past.row", { start: when(row.created), end: when(row.modified) });
				return (
					<BoardRow
						data={{ "data-bot-past": row.path }}
						key={row.path}
						label={
							<LinkButton data-bot-past-open={row.path} onClick={() => openPast(row.path, device)}>
								{label}
							</LinkButton>
						}
						lead={<KindMark icon={History} tone="muted" />}
						title={label}
					/>
				);
			})}
		</BoardSection>
	);
}

/** Its tab when one holds it, else a new tab on it: this computer's bot, or the paired host's (its list's `on` row). */
async function openCurrentBot(device: string | undefined): Promise<void> {
	let path: string | null | undefined;
	if (device === undefined) {
		ensureBotPath();
		path = useBotStore.getState().path ?? (await window.omp.sessions.ensureBot());
	} else
		path = sessionListFeed("global", device)
			.store.getState()
			.sessions.find(row => row.bot === "on")?.path;
	if (!path) return;
	const tabs = useTabsStore.getState();
	const held = tabs.tabs.find(tab => tab.sessionPath === path && tab.device === device);
	if (held) await tabs.switchTab(held.id);
	else await tabs.openTab({ sessionPath: path, kind: "chat", ...(device === undefined ? {} : { device }) });
}

/** Where the composer would be in a conversation the bot ended (`ended-conversation.tsx`). */
export function EndedConversationNote({ device }: { device?: string }) {
	const t = useT();
	return (
		<div
			className="omp-composer-shell flex flex-wrap items-center gap-x-2 gap-y-1 py-3 text-sc-sm text-(--sc-text-muted)"
			data-bot-ended-note=""
		>
			<span>{t("botHome.ended.note")}</span>
			<LinkButton
				data-bot-ended-open-current=""
				onClick={() =>
					void openCurrentBot(device).catch((error: unknown) =>
						toastError({ title: t("sidebar.openFailed"), error }),
					)
				}
			>
				{t("botHome.ended.openCurrent")}
			</LinkButton>
		</div>
	);
}
