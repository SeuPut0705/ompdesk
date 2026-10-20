/**
 * The work board's "Current work" rows, one line each: what the turn's own edit tools changed (the last turn's while
 * idle), what the session's branch has not landed in main yet, the session's newest check (a failed one is its own
 * section at the top), the dev servers running, the other sessions in the checkout and the memory the turn used.
 * `useSessionBoard` reads them all once; the section draws what it found.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcGitUnlanded } from "../../../../shared/rpc-types";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { routeToSessionOwner } from "../../../hooks/use-session-switch";
import { formatDuration, formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { backgroundJobVerdicts } from "../../chat/completion-events";
import { requestRevealStep } from "../../chat/work/reveal-step";
import { useRunStores } from "../../chat/work/use-work-run";
import { workOutcomes } from "../../chat/work/work-view";
import { BoardRow, BoardSection, Dot } from "./board-parts";
import {
	type ChangesSummary,
	type DevServer,
	devServers,
	type LastCheck,
	lastCheck,
	type PeerOpen,
	type PeersSummary,
	peerOpen,
	recallTitles,
	type ScopedPeer,
	summarizePeers,
	summarizeTurnFiles,
	summarizeUnlanded,
	type UnlandedSummary,
} from "./session-board";

export type SessionRowModel =
	| ({ kind: "changes" } & ChangesSummary)
	| ({ kind: "unlanded" } & UnlandedSummary)
	| { kind: "check"; check: LastCheck }
	| ({ kind: "dev-server" } & DevServer)
	| ({ kind: "peers" } & PeersSummary)
	| { kind: "recall"; titles: string[] };

export interface SessionBoard {
	/** The newest check when it failed: the board's own section. */
	failedCheck: LastCheck | null;
	/** Changed, not in main yet, last check (passed or running), dev servers, same checkout, memory: only those with
	 * something to say. */
	rows: SessionRowModel[];
}

/** The turn the "Changed" row counts: the running one, else the last that ended (its `end`). */
export interface TurnWindow {
	start: number;
	end: number | null;
}

/** Calls may be stamped a little before the turn's own start (one clock, two events). */
const TURN_CLOCK_SLACK_MS = 500;

/**
 * What the turn's own edit tools changed (write, edit, ast_edit, apply_patch, as the work card counts them), live while
 * it runs. Never git: in a checkout other sessions share, git cannot tell this session's edits from theirs.
 */
function useTurnChanges(turn: TurnWindow | null): ChangesSummary | null {
	const { tools } = useRunStores();
	const cwd = useSessionStore(state => state.cwd);
	const finishedVersion = useToolsStore(state => state.finishedVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishedVersion marks the finished map changing in place.
	return useMemo(() => {
		if (!turn) return null;
		const entries = [...tools.getState().finishedTools.values()].filter(
			entry =>
				entry.startTime >= turn.start - TURN_CLOCK_SLACK_MS &&
				(turn.end === null || entry.startTime <= turn.end + TURN_CLOCK_SLACK_MS),
		);
		return summarizeTurnFiles(workOutcomes(entries, undefined, cwd).files);
	}, [turn?.start, turn?.end, tools, cwd, finishedVersion]);
}

/** While a turn runs, a finished call (a commit, an edit) reads the branch again at most this often. */
const UNLANDED_REREAD_MS = 5_000;

/**
 * What the session's branch has not landed in main yet (`get_git_unlanded`; null on main itself), read through this
 * tab's runtime (a paired host's tab reads its host) on mount, each time a turn settles, and while one runs at most
 * every {@link UNLANDED_REREAD_MS} after one of its calls finished (a commit mid-turn): no timer of its own.
 */
function useUnlanded(): UnlandedSummary | null {
	const rpc = useTabRpc();
	const turnActive = useTodoStore(state => state.turnActive);
	const [unlanded, setUnlanded] = useState<UnlandedSummary | null>(null);
	const read = useCallback(() => {
		let current = true;
		void rpc
			.getGitUnlanded()
			.then(response => {
				if (current)
					setUnlanded(response.success ? summarizeUnlanded(response.data as RpcGitUnlanded | null) : null);
			})
			.catch(() => {
				if (current) setUnlanded(null);
			});
		return () => {
			current = false;
		};
	}, [rpc]);
	useEffect(() => read(), [read]);
	const finishedVersion = useToolsStore(state => state.finishedVersion);
	const reread = useRef<number | null>(null);
	const seenVersion = useRef(finishedVersion);
	useEffect(() => {
		if (finishedVersion === seenVersion.current) return;
		seenVersion.current = finishedVersion;
		if (!turnActive || reread.current) return;
		reread.current = window.setTimeout(() => {
			reread.current = null;
			read();
		}, UNLANDED_REREAD_MS);
	}, [finishedVersion, turnActive, read]);
	useEffect(() => () => window.clearTimeout(reread.current ?? undefined), []);
	const wasActive = useRef(turnActive);
	useEffect(() => {
		const settled = wasActive.current && !turnActive;
		wasActive.current = turnActive;
		return settled ? read() : undefined;
	}, [turnActive, read]);
	return unlanded;
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

export function useSessionBoard(turn: TurnWindow | null = null): SessionBoard {
	const changes = useTurnChanges(turn);
	const unlanded = useUnlanded();
	const check = useLastCheck();
	const jobs = useBackgroundJobs();
	const peers = useSessionStore(state => state.checkoutPeers);
	const messages = useMessagesStore(state => state.messages);
	const servers = useMemo(() => devServers(jobs), [jobs]);
	const titles = useMemo(() => recallTitles(messages), [messages]);
	return useMemo(() => {
		const rows: SessionRowModel[] = [];
		// A finished turn that changed nothing says so; a running one only once it changed something.
		if (changes && (changes.files > 0 || turn?.end != null)) rows.push({ kind: "changes", ...changes });
		if (unlanded) rows.push({ kind: "unlanded", ...unlanded });
		if (check && check.state !== "failed") rows.push({ kind: "check", check });
		for (const server of servers) rows.push({ kind: "dev-server", ...server });
		const company = summarizePeers(peers);
		if (company) rows.push({ kind: "peers", ...company });
		if (titles.length > 0) rows.push({ kind: "recall", titles });
		return { failedCheck: check?.state === "failed" ? check : null, rows };
	}, [changes, unlanded, check, servers, peers, titles, turn?.end]);
}

const plural = (count: number) => (count === 1 ? "" : "s");

function CheckRow({ check }: { check: LastCheck }) {
	const t = useT();
	// The transcript of the board's own tab opens the card holding the call (a collapsed or unmounted one too).
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
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
			onClick={check.state === "failed" && tabId ? () => requestRevealStep({ tabId, key: check.key }) : undefined}
			title={check.command}
		/>
	);
}

/** "N files changed +a −r"; a capped count reads as a floor ("1000+") and its lines are left out, never read as exact. */
function changesText(summary: ChangesSummary): { count: string | number; meta: ReactNode } {
	return {
		count: summary.capped ? `${summary.files}+` : summary.files,
		meta:
			!summary.capped && summary.added + summary.removed > 0 ? (
				<span className="tabular-nums">
					<span className="text-(--sc-success)">+{summary.added}</span>{" "}
					<span className="text-(--sc-danger)">−{summary.removed}</span>
				</span>
			) : undefined,
	};
}

function ChangesRow(summary: ChangesSummary) {
	const t = useT();
	const { count, meta } = changesText(summary);
	return (
		<BoardRow
			data={{ "data-board-session": "changes" }}
			label={
				summary.files > 0
					? t("chat.work.filesChanged", { count, plural: plural(summary.files) })
					: t("workBoard.noChanges")
			}
			lead={<Dot tone="muted" />}
			meta={meta}
			onClick={summary.files > 0 ? () => useUiStore.getState().setPanelTab("diff") : undefined}
		/>
	);
}

function UnlandedRow(summary: UnlandedSummary) {
	const t = useT();
	const { count, meta } = changesText(summary);
	return (
		<BoardRow
			data={{ "data-board-session": "unlanded" }}
			label={t("workBoard.current.unlanded", { target: summary.target, count, plural: plural(summary.files) })}
			lead={<Dot tone="muted" />}
			meta={meta}
			title={t("workBoard.current.unlandedTitle", { branch: summary.branch, target: summary.target })}
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

/** Open one peer: a tab this window holds is switched to; otherwise its file opens where it is held (`peerOpen`). */
async function openPeer(target: PeerOpen): Promise<void> {
	if (!target) return;
	const tabs = useTabsStore.getState();
	if (target.kind === "switch") {
		await tabs.switchTab(target.tabId);
		return;
	}
	// This computer's file: another window or a paired device's tab may hold it (F-OWN), so ask its owner first.
	if (!target.device) {
		const owner = await window.omp.tabs.getSessionOwner(target.sessionPath).catch(() => null);
		if (owner) {
			await routeToSessionOwner(owner, target.sessionPath);
			return;
		}
	}
	await tabs.openTab({ sessionPath: target.sessionPath, ...(target.device ? { device: target.device } : {}) });
}

/**
 * One line naming how many sessions share the checkout; a tap lists each on its own line (title, its device), and a
 * tap on one shows that session. The row expands in place (`data-board-expands`): the phone's strip stays open.
 */
function PeersRow({ worktree, repo, peers }: PeersSummary) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const tabs = useTabsStore(state => state.tabs);
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const device = tabs.find(tab => tab.id === (runtimeTabId ?? activeTabId))?.device;
	const name = (peer: ScopedPeer) => peer.title || t("workBoard.session.peers.hidden");
	return (
		<>
			<BoardRow
				data={{ "data-board-session": "peers", "data-open": String(open), "data-board-expands": "" }}
				label={
					worktree > 0 && repo > 0
						? t("workBoard.session.peers.both", { count: worktree, plural: plural(worktree), repo })
						: t(`workBoard.session.peers.${worktree > 0 ? "worktree" : "repo"}`, {
								count: peers.length,
								plural: plural(peers.length),
							})
				}
				lead={<Dot tone="muted" />}
				onClick={() => setOpen(!open)}
				title={peers.map(peer => (peer.device ? `${name(peer)} (${peer.device})` : name(peer))).join("\n")}
			/>
			{open
				? peers.map((peer, index) => {
						const target = peerOpen(peer, { tabs, device });
						return (
							<BoardRow
								data={{
									"data-board-session": "peer",
									"data-peer-index": String(index),
									"data-peer-scope": peer.scope,
								}}
								key={peer.id ?? peer.sessionPath ?? index}
								label={
									<span className="text-(--sc-text-muted)">
										{name(peer)}
										{peer.device || peer.scope === "repo" ? (
											<span className="text-(--sc-text-subtle)">
												{[
													"",
													peer.device,
													peer.scope === "repo" ? t("workBoard.session.peers.otherWorktree") : null,
												]
													.filter(part => part !== null && part !== undefined)
													.join(" · ")}
											</span>
										) : null}
									</span>
								}
								lead={null}
								onClick={target ? () => void openPeer(target) : undefined}
								title={[name(peer), peer.worktree].filter(Boolean).join("\n")}
							/>
						);
					})
				: null}
		</>
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
			return <ChangesRow added={row.added} capped={row.capped} files={row.files} removed={row.removed} />;
		case "unlanded":
			return (
				<UnlandedRow
					added={row.added}
					branch={row.branch}
					capped={row.capped}
					files={row.files}
					removed={row.removed}
					target={row.target}
				/>
			);
		case "check":
			return <CheckRow check={row.check} />;
		case "dev-server":
			return <DevServerRow command={row.command} host={row.host} url={row.url} />;
		case "peers":
			return <PeersRow peers={row.peers} repo={row.repo} worktree={row.worktree} />;
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

export function CurrentSection({ rows, aside }: { rows: SessionRowModel[]; aside?: string }) {
	const t = useT();
	if (rows.length === 0) return null;
	return (
		<BoardSection aside={aside} id="current" title={t("workBoard.current")}>
			{rows.map(row => (
				<SessionRow key={row.kind === "dev-server" ? `dev-server:${row.url}` : row.kind} row={row} />
			))}
		</BoardSection>
	);
}

/**
 * The board mounts these from a lazy chunk (the phone's first screen has no room for the rows' code): the failed
 * check at its top, the "Current work" section near its foot, and a watcher that tells the strip a check failed.
 */
export function FailedCheckSlot() {
	const check = useLastCheck();
	return check?.state === "failed" ? <FailedCheckSection check={check} /> : null;
}

export function SessionSlot({ turn, aside }: { turn: TurnWindow | null; aside?: string }) {
	return <CurrentSection aside={aside} rows={useSessionBoard(turn).rows} />;
}

export function FailedCheckWatch({ onChange }: { onChange: (failed: boolean) => void }) {
	const failed = useLastCheck()?.state === "failed";
	useEffect(() => onChange(failed), [failed, onChange]);
	return null;
}
