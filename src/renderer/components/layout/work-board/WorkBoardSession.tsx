/**
 * The work board's session rows, one line each: what the checkout changed since the session started, the session's
 * newest check (a failed one is its own section at the top), the dev servers running, the other sessions in the
 * checkout and the memory the turn used. `useSessionBoard` reads them all once; the sections draw what it found.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcGitChanges } from "../../../../shared/rpc-types";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { formatDuration, formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { backgroundJobVerdicts } from "../../chat/completion-events";
import { revealStep } from "../../chat/work/reveal-step";
import { useRunStores } from "../../chat/work/use-work-run";
import { BoardRow, BoardSection, Dot } from "./board-parts";
import {
	type ChangesSummary,
	type DevServer,
	devServers,
	type LastCheck,
	lastCheck,
	type PeersSummary,
	recallTitles,
	summarizeChanges,
	summarizePeers,
} from "./session-board";

export type SessionRowModel =
	| ({ kind: "changes" } & ChangesSummary)
	| { kind: "check"; check: LastCheck }
	| ({ kind: "dev-server" } & DevServer)
	| ({ kind: "peers" } & PeersSummary)
	| { kind: "recall"; titles: string[] };

export interface SessionBoard {
	/** The newest check when it failed: the board's own section. */
	failedCheck: LastCheck | null;
	/** Changed, last check (passed or running), dev servers, same checkout, memory: only those with something to say. */
	rows: SessionRowModel[];
}

/**
 * What the checkout changed since the session started, its own commits included (`get_git_session_changes`: git from
 * the newest commit before the session's first entry to the working tree), read through this tab's runtime (a paired
 * host's tab reads its host) once on mount and once each time a turn settles: no timer.
 */
function useChanges(): ChangesSummary | null {
	const rpc = useTabRpc();
	const turnActive = useTodoStore(state => state.turnActive);
	const [changes, setChanges] = useState<ChangesSummary | null>(null);
	const read = useCallback(() => {
		let current = true;
		void rpc
			.getGitSessionChanges()
			.then(response => {
				if (current) setChanges(response.success ? summarizeChanges(response.data as RpcGitChanges) : null);
			})
			.catch(() => {
				if (current) setChanges(null);
			});
		return () => {
			current = false;
		};
	}, [rpc]);
	useEffect(() => read(), [read]);
	const wasActive = useRef(turnActive);
	useEffect(() => {
		const settled = wasActive.current && !turnActive;
		wasActive.current = turnActive;
		return settled ? read() : undefined;
	}, [turnActive, read]);
	return changes;
}

/** The session's newest check over its finished and live calls, with the verdicts of backgrounded ones. */
export function useLastCheck(): LastCheck | null {
	const { tools } = useRunStores();
	const cwd = useSessionStore(state => state.cwd);
	const live = useToolsStore(state => state.liveTools);
	const finishedVersion = useToolsStore(state => state.finishedVersion);
	const messages = useMessagesStore(state => state.messages);
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishedVersion marks the finished map changing in place.
	return useMemo(
		() => lastCheck([...tools.getState().finishedTools, ...live], cwd, backgroundJobVerdicts(messages)),
		[tools, live, finishedVersion, cwd, messages],
	);
}

export function useSessionBoard(): SessionBoard {
	const changes = useChanges();
	const check = useLastCheck();
	const jobs = useBackgroundJobs();
	const peers = useSessionStore(state => state.checkoutPeers);
	const messages = useMessagesStore(state => state.messages);
	const servers = useMemo(() => devServers(jobs), [jobs]);
	const titles = useMemo(() => recallTitles(messages), [messages]);
	return useMemo(() => {
		const rows: SessionRowModel[] = [];
		if (changes) rows.push({ kind: "changes", ...changes });
		if (check && check.state !== "failed") rows.push({ kind: "check", check });
		for (const server of servers) rows.push({ kind: "dev-server", ...server });
		const company = summarizePeers(peers);
		if (company) rows.push({ kind: "peers", ...company });
		if (titles.length > 0) rows.push({ kind: "recall", titles });
		return { failedCheck: check?.state === "failed" ? check : null, rows };
	}, [changes, check, servers, peers, titles]);
}

const plural = (count: number) => (count === 1 ? "" : "s");

function CheckRow({ check }: { check: LastCheck }) {
	const t = useT();
	const running = check.state === "running";
	const now = useNowTick(running);
	const verdict = check.state === "passed" ? "passed" : "failed";
	const label = running
		? t(`workBoard.session.check.${check.kind}.running`)
		: check.count !== undefined
			? t(`chat.work.check.${check.kind}.${verdict}Count`, { count: check.count })
			: t(`chat.work.check.${check.kind}.${verdict}`);
	const meta = running
		? formatElapsed(now - check.startedAt)
		: check.durationMs !== undefined
			? formatDuration(check.durationMs)
			: undefined;
	return (
		<BoardRow
			data={{ "data-board-session": "check", "data-state": check.state }}
			label={label}
			lead={<Dot tone={running ? "info" : check.state === "passed" ? "success" : "danger"} />}
			meta={meta}
			onClick={check.state === "failed" ? () => revealStep(document, check.key) : undefined}
			title={check.command}
		/>
	);
}

function ChangesRow({ files, added, removed }: ChangesSummary) {
	const t = useT();
	return (
		<BoardRow
			data={{ "data-board-session": "changes" }}
			label={t("chat.work.filesChanged", { count: files, plural: plural(files) })}
			lead={<Dot tone="muted" />}
			meta={
				added + removed > 0 ? (
					<span className="tabular-nums">
						<span className="text-(--sc-success)">+{added}</span>{" "}
						<span className="text-(--sc-danger)">−{removed}</span>
					</span>
				) : undefined
			}
			onClick={() => useUiStore.getState().setPanelTab("diff")}
		/>
	);
}

function DevServerRow({ url, host, command }: DevServer) {
	return (
		<BoardRow
			data={{ "data-board-session": "dev-server" }}
			label={host}
			lead={<Dot tone="success" />}
			onClick={() => useUiStore.getState().openPreview(url)}
			title={command}
		/>
	);
}

function PeersRow({ scope, peers }: PeersSummary) {
	const t = useT();
	const tabs = useTabsStore(state => state.tabs);
	const names = peers.map(peer => {
		const name = peer.title || t("workBoard.session.peers.hidden");
		return peer.device ? `${name} (${peer.device})` : name;
	});
	const only = peers.length === 1 ? peers[0] : undefined;
	const tabId = only?.id && tabs.some(tab => tab.id === only.id) ? only.id : null;
	return (
		<BoardRow
			data={{ "data-board-session": "peers" }}
			label={t(`workBoard.session.peers.${scope}`, { count: peers.length, plural: plural(peers.length) })}
			lead={<Dot tone="muted" />}
			onClick={tabId ? () => void useTabsStore.getState().switchTab(tabId) : undefined}
			title={names.join("\n")}
		/>
	);
}

function RecallRow({ titles }: { titles: string[] }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [first, ...rest] = titles;
	return (
		<>
			<BoardRow
				data={{ "data-board-session": "recall", "data-open": String(open), "data-board-expands": "" }}
				label={t("workBoard.session.recall.label", { title: first ?? "" })}
				lead={<Dot tone="muted" />}
				meta={rest.length > 0 ? `+${rest.length}` : undefined}
				onClick={rest.length > 0 ? () => setOpen(!open) : undefined}
				title={[
					...titles,
					rest.length > 0
						? t(open ? "workBoard.session.recall.collapse" : "workBoard.session.recall.expand")
						: null,
				]
					.filter(Boolean)
					.join("\n")}
			/>
			{open
				? rest.map((title, index) => (
						<BoardRow
							data={{ "data-board-session": "recall-item" }}
							key={`${index}:${title}`}
							label={<span className="text-(--sc-text-muted)">{title}</span>}
							lead={null}
							title={title}
						/>
					))
				: null}
		</>
	);
}

function SessionRow({ row }: { row: SessionRowModel }) {
	switch (row.kind) {
		case "changes":
			return <ChangesRow added={row.added} files={row.files} removed={row.removed} />;
		case "check":
			return <CheckRow check={row.check} />;
		case "dev-server":
			return <DevServerRow command={row.command} host={row.host} url={row.url} />;
		case "peers":
			return <PeersRow peers={row.peers} scope={row.scope} />;
		case "recall":
			return <RecallRow titles={row.titles} />;
	}
}

/** The newest check failed: its own section at the top of the board, tap shows the call in the transcript. */
export function FailedCheckSection({ check }: { check: LastCheck }) {
	const t = useT();
	return (
		<BoardSection id="check" title={t("workBoard.session.checkFailed")} tone="danger">
			<CheckRow check={check} />
		</BoardSection>
	);
}

export function SessionSection({ rows }: { rows: SessionRowModel[] }) {
	const t = useT();
	if (rows.length === 0) return null;
	return (
		<BoardSection id="session" title={t("workBoard.session.title")}>
			{rows.map(row => (
				<SessionRow key={row.kind === "dev-server" ? `dev-server:${row.url}` : row.kind} row={row} />
			))}
		</BoardSection>
	);
}

/**
 * The board mounts these from a lazy chunk (the phone's first screen has no room for the rows' code): the failed
 * check at its top, the session section near its foot, and a watcher that tells the strip a check failed.
 */
export function FailedCheckSlot() {
	const check = useLastCheck();
	return check?.state === "failed" ? <FailedCheckSection check={check} /> : null;
}

export function SessionSlot() {
	return <SessionSection rows={useSessionBoard().rows} />;
}

export function FailedCheckWatch({ onChange }: { onChange: (failed: boolean) => void }) {
	const failed = useLastCheck()?.state === "failed";
	useEffect(() => onChange(failed), [failed, onChange]);
	return null;
}
