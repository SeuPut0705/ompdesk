/**
 * The work board's "Current work" rows, one line each: what the turn's own edit tools and the sessions it opened
 * changed (the last turn's while idle), what the session's branch has not landed in main yet, the session's newest
 * check (a failed one is its own section at the top), the dev servers running, the other sessions in the checkout,
 * and the memory and skills the turn used. `useSessionBoard` reads them all once; the section draws what it found.
 */
import { BookOpen, Brain, FileDiff, FlaskConical, GitBranch, Globe, Shield, Users } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { READ_ONLY_TOOLS } from "../../../../shared/agent-definition";
import type { RpcGitUnlanded } from "../../../../shared/rpc-types";
import type { FamilyEdits, FamilyMemberEdits } from "../../../../shared/turn-edits";
import { useBackgroundJobs } from "../../../hooks/use-background-jobs";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { formatDuration } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId, useTabCommand } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { transcriptToolEntries, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { backgroundJobVerdicts } from "../../chat/completion-events";
import { requestRevealStep } from "../../chat/work/reveal-step";
import { useRunOutcome, useRunStores } from "../../chat/work/use-work-run";
import {
	mergeSkills,
	type WorkOutcomes,
	type WorkProtection,
	type WorkSkillOutcome,
	workOutcomes,
} from "../../chat/work/work-view";
import { BoardRow, BoardSection, elapsedLabel, KindMark } from "./board-parts";
import { openPeer, peerOpen } from "./open-peer";
import {
	type ChangesSummary,
	type DevServer,
	devServers,
	type FamilyChangesSummary,
	type FamilyPart,
	familyChanges,
	type KeyedFileChange,
	keyedFiles,
	type LastCheck,
	lastCheck,
	type PeersSummary,
	recallTitles,
	type ScopedPeer,
	summarizePeers,
	summarizeUnlanded,
	turnSkills,
	type UnlandedSummary,
} from "./session-board";

export type SessionRowModel =
	| ({ kind: "changes" } & FamilyChangesSummary)
	| ({ kind: "unlanded" } & UnlandedSummary)
	| { kind: "check"; check: LastCheck }
	| ({ kind: "dev-server" } & DevServer)
	| ({ kind: "peers" } & PeersSummary)
	| { kind: "recall"; titles: string[] }
	| { kind: "skills"; skills: WorkSkillOutcome[] }
	| { kind: "protected"; protections: WorkProtection[] };

export interface SessionBoard {
	/** Changed, not in main yet, last check (passed, failed or running), dev servers, same checkout, memory, skills
	 * read: only those with something to say. */
	rows: SessionRowModel[];
}

/** The turn the "Changed" row counts: the running one, else the last that ended (its `end`). */
export interface TurnWindow {
	start: number;
	end: number | null;
}

/** Calls may be stamped a little before the turn's own start (one clock, two events). */
const TURN_CLOCK_SLACK_MS = 500;

/** The tab the board belongs to: its runtime's, else the window's active one. */
function useBoardTabId(): string | null {
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	return runtimeTabId ?? activeTabId;
}

/**
 * What the turn's own edit tools changed (write, edit, ast_edit, apply_patch, as the work card counts them), live while
 * it runs. Never git: in a checkout other sessions share, git cannot tell this session's edits from theirs.
 */
function useTurnFiles(turn: TurnWindow | null): KeyedFileChange[] {
	const { tools } = useRunStores();
	const cwd = useSessionStore(state => state.cwd);
	const tabId = useBoardTabId();
	const device = useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.device);
	const finishedVersion = useToolsStore(state => state.finishedVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishedVersion marks the finished map changing in place.
	return useMemo(() => {
		if (!turn) return [];
		const entries = [...tools.getState().finishedTools.values()].filter(
			entry =>
				entry.startTime >= turn.start - TURN_CLOCK_SLACK_MS &&
				(turn.end === null || entry.startTime <= turn.end + TURN_CLOCK_SLACK_MS),
		);
		return keyedFiles(workOutcomes(entries, undefined, cwd).files, cwd, device);
	}, [turn?.start, turn?.end, tools, cwd, device, finishedVersion]);
}

/** A running child's step moves often: the family is read again at most this often. */
const FAMILY_REREAD_MS = 5_000;

/**
 * One family member's share: what its worktree branch has not landed, else what its newest turn's own edit tools
 * changed, counted by the work card's rule. Null when it cannot say (an older host, an omp starting).
 */
function memberShare(member: FamilyMemberEdits): Omit<FamilyPart, "title"> | null {
	const cwd = member.edits?.cwd ?? "";
	const branch = member.unlanded;
	if (branch && branch.files.length > 0)
		return { files: keyedFiles(branch.files, cwd, member.device), capped: branch.truncated };
	if (!member.edits) return null;
	const files = workOutcomes(transcriptToolEntries(member.edits.messages), undefined, cwd).files;
	return { files: keyedFiles(files, cwd, member.device), capped: false };
}

/**
 * The family's shares of the "Changed" row, read through main (`agent_control_family_edits`): every session the
 * board's session opened, an Autopilot run's cycle children included, on any computer and in any window, and those
 * closed after their work landed since this turn began. A member counts while it runs or waits, or when its turn
 * ended after this session's turn began. Read on mount and whenever the family's rows move (main's review push
 * carries a running child's step and state), at most every {@link FAMILY_REREAD_MS}: no timer of its own beyond that.
 */
function useFamilyParts(turn: TurnWindow | null): FamilyPart[] {
	const tabId = useBoardTabId();
	const command = useTabCommand();
	const { rows } = useOpenedChildren(tabId);
	const since = turn?.start;
	const signature = useMemo(
		() =>
			rows.length === 0
				? ""
				: `${since ?? ""}\n${rows.map(row => `${row.key}|${row.status}|${row.since ?? ""}|${row.step ?? ""}`).join("\n")}`,
		[rows, since],
	);
	const [members, setMembers] = useState<readonly FamilyMemberEdits[]>([]);
	const latest = useRef({ command, since, signature });
	latest.current = { command, since, signature };
	const last = useRef<{ signature: string; at: number } | null>(null);
	const due = useRef<number | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			window.clearTimeout(due.current ?? undefined);
			due.current = null;
		};
	}, []);
	useEffect(() => {
		if (!signature) {
			setMembers([]);
			return;
		}
		if (last.current?.signature === signature || due.current !== null) return;
		const read = () => {
			due.current = null;
			// A read the wait held back asks with what is newest by then.
			const { command: send, since: start, signature: current } = latest.current;
			last.current = { signature: current, at: Date.now() };
			void Promise.resolve()
				.then(() => send({ type: "agent_control_family_edits", ...(start === undefined ? {} : { since: start }) }))
				.then(response => {
					const data = response.success ? (response.data as FamilyEdits | null) : null;
					if (alive.current && Array.isArray(data?.members)) setMembers(data.members);
				})
				.catch(() => {});
		};
		const wait = last.current ? last.current.at + FAMILY_REREAD_MS - Date.now() : 0;
		if (wait <= 0) read();
		else due.current = window.setTimeout(read, wait);
	}, [signature]);
	return useMemo(
		() =>
			members.flatMap(member => {
				const endedAt = member.edits?.endedAt ?? null;
				const counts =
					member.live || (turn !== null && endedAt !== null && endedAt >= turn.start - TURN_CLOCK_SLACK_MS);
				const share = counts ? memberShare(member) : null;
				return share ? [{ title: member.title, ...share }] : [];
			}),
		[members, turn],
	);
}

/** While a turn runs, a finished call (a commit, an edit) reads the branch again at most this often. */
const UNLANDED_REREAD_MS = 5_000;

/**
 * Calls that only read: one finishing never makes the branch read again (a research turn read it every 5 s). Not
 * `lsp`, which the agent-template table counts as reading: its rename, file move and code actions write files.
 */
const LOOKS_ONLY: ReadonlySet<string> = new Set([
	...READ_ONLY_TOOLS.filter(name => name !== "lsp"),
	"todo",
	"ask",
	"fetch",
	"wait",
]);

/**
 * What the session's branch has not landed in main yet (`get_git_unlanded`; null on main itself), read through this
 * tab's runtime (a paired host's tab reads its host) on mount, each time a turn settles, and while one runs at most
 * every {@link UNLANDED_REREAD_MS} after a call that can touch the checkout finished (a commit mid-turn): no timer of
 * its own.
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
	const { tools } = useRunStores();
	const reread = useRef<number | null>(null);
	const seenVersion = useRef(finishedVersion);
	// The calls finished before the board mounted are history: only a call that finishes after it counts.
	const [mountedCalls] = useState(() => new Set(tools.getState().finishedTools.keys()));
	const seenCalls = useRef(mountedCalls);
	const seenHydration = useRef(tools.getState().hydrationVersion);
	useEffect(() => {
		if (finishedVersion === seenVersion.current) return;
		seenVersion.current = finishedVersion;
		// Only a call that can touch the checkout (an edit, a shell command, a subagent) moves what is unlanded.
		// A transcript hydration replaces the map with history: those calls are seen, not new.
		const { finishedTools, hydrationVersion } = tools.getState();
		const history = hydrationVersion !== seenHydration.current;
		seenHydration.current = hydrationVersion;
		let touched = false;
		const seen = seenCalls.current;
		for (const [key, entry] of finishedTools) {
			if (seen.has(key)) continue;
			seen.add(key);
			if (!history && !LOOKS_ONLY.has(entry.toolName)) touched = true;
		}
		if (!touched || !turnActive || reread.current) return;
		reread.current = window.setTimeout(() => {
			reread.current = null;
			read();
		}, UNLANDED_REREAD_MS);
	}, [finishedVersion, turnActive, read, tools]);
	useEffect(() => () => window.clearTimeout(reread.current ?? undefined), []);
	const wasActive = useRef(turnActive);
	useEffect(() => {
		const settled = wasActive.current && !turnActive;
		wasActive.current = turnActive;
		return settled ? read() : undefined;
	}, [turnActive, read]);
	return unlanded;
}

/**
 * The finished calls of the newest turn (the running one, else the last that ended, else, in a reloaded tab, everything
 * since the last prompt): a card's verdict needs its calls settled, and a stream that finishes no call reads nothing.
 */
function useNewestTurnCalls(): readonly string[] {
	const { tools } = useRunStores();
	const start = useTodoStore(state => (state.turnActive ? state.turnStartedAt : (state.lastTurn?.start ?? null)));
	const prompted = useMessagesStore(state => {
		const at = state.messages.findLast(message => message.role === "user")?.timestamp;
		return typeof at === "number" ? at : null;
	});
	const finishedVersion = useToolsStore(state => state.finishedVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishedVersion marks the finished map changing in place.
	return useMemo(() => {
		const from = (start ?? prompted ?? 0) - TURN_CLOCK_SLACK_MS;
		const keys: string[] = [];
		for (const [key, entry] of tools.getState().finishedTools) if (entry.startTime >= from) keys.push(key);
		return keys;
	}, [start, prompted, tools, finishedVersion]);
}

/** The newest turn's outcome as its work card reads it (`useRunOutcome`, subagents' calls included). */
function useNewestOutcome(): WorkOutcomes {
	return useRunOutcome(useNewestTurnCalls()).outcome;
}

/** The check the board names, as the newest work card reads it; the session's finished and live calls give the newest run. */
function useLastCheck(outcome: WorkOutcomes): LastCheck | null {
	const { tools } = useRunStores();
	const cwd = useSessionStore(state => state.cwd);
	const live = useToolsStore(state => state.liveTools);
	const finishedVersion = useToolsStore(state => state.finishedVersion);
	const messages = useMessagesStore(state => state.messages);
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishedVersion marks the finished map changing in place.
	return useMemo(
		() =>
			lastCheck(
				[...tools.getState().finishedTools, ...live],
				outcome.commands,
				cwd,
				backgroundJobVerdicts(messages),
			),
		[tools, live, finishedVersion, cwd, messages, outcome],
	);
}

export function useSessionBoard(turn: TurnWindow | null = null): SessionBoard {
	const own = useTurnFiles(turn);
	const family = useFamilyParts(turn);
	const changes = useMemo(() => familyChanges([{ title: null, files: own }, ...family]), [own, family]);
	const unlanded = useUnlanded();
	const outcome = useNewestOutcome();
	const check = useLastCheck(outcome);
	const jobs = useBackgroundJobs();
	const peers = useSessionStore(state => state.checkoutPeers);
	const messages = useMessagesStore(state => state.messages);
	const servers = useMemo(() => devServers(jobs), [jobs]);
	const titles = useMemo(() => recallTitles(messages), [messages]);
	const skills = useMemo(
		() =>
			mergeSkills(
				turnSkills(messages).map(name => ({ name })),
				outcome.skills,
			),
		[messages, outcome.skills],
	);
	const protections = outcome.protections;
	return useMemo(() => {
		const rows: SessionRowModel[] = [];
		// Only what changed: a turn (or a family) that changed nothing draws no line.
		if (changes.files > 0) rows.push({ kind: "changes", ...changes });
		if (unlanded) rows.push({ kind: "unlanded", ...unlanded });
		if (check) rows.push({ kind: "check", check });
		for (const server of servers) rows.push({ kind: "dev-server", ...server });
		const company = summarizePeers(peers);
		if (company) rows.push({ kind: "peers", ...company });
		if (protections.length > 0) rows.push({ kind: "protected", protections });
		if (titles.length > 0) rows.push({ kind: "recall", titles });
		if (skills.length > 0) rows.push({ kind: "skills", skills });
		return { rows };
	}, [changes, unlanded, check, servers, peers, protections, titles, skills]);
}

const plural = (count: number) => (count === 1 ? "" : "s");

function checkWords(t: (key: string, params?: Record<string, string | number>) => string, check: LastCheck): string {
	if (check.state === "running") return t(`workBoard.session.check.${check.kind}.running`);
	const verdict = check.state === "passed" ? "passed" : "failed";
	return check.count !== undefined
		? t(`chat.work.check.${check.kind}.${verdict}Count`, { count: check.count })
		: t(`chat.work.check.${check.kind}.${verdict}`);
}

function rowWords(t: (key: string, params?: Record<string, string | number>) => string, row: SessionRowModel): string {
	switch (row.kind) {
		case "changes": {
			const files = t("chat.work.filesChanged", {
				count: row.capped ? `${row.files}+` : row.files,
				plural: plural(row.files),
			});
			return row.capped ? files : `${files} +${row.added} −${row.removed}`;
		}
		case "unlanded":
			return t("workBoard.current.unlanded", {
				target: row.target,
				count: row.capped ? `${row.files}+` : row.files,
				plural: plural(row.files),
			});
		case "check":
			return checkWords(t, row.check);
		case "dev-server":
			return row.host;
		case "peers": {
			const count =
				row.worktree > 0 && row.repo > 0
					? t("workBoard.session.peers.both", {
							count: row.worktree,
							plural: plural(row.worktree),
							repo: row.repo,
						})
					: t(`workBoard.session.peers.${row.worktree > 0 ? "worktree" : "repo"}`, {
							count: row.peers.length,
							plural: plural(row.peers.length),
						});
			return row.shared > 0
				? `${count} ${t("workBoard.session.peers.shared", { count: row.shared, plural: plural(row.shared) })}`
				: count;
		}
		case "recall":
			return t("workBoard.session.recall.label", { title: row.titles[0] ?? "" });
		case "skills":
			return t("workBoard.session.skills.label", { names: row.skills.map(skill => skill.name).join(" · ") });
		case "protected":
			return t("workBoard.session.protected", {
				count: row.protections.length,
				plural: plural(row.protections.length),
			});
	}
}

function CheckRow({ check }: { check: LastCheck }) {
	const t = useT();
	// The transcript of the board's own tab opens the card holding the call (a collapsed or unmounted one too).
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const running = check.state === "running";
	const key = check.key;
	const now = useNowTick(running);
	const label = checkWords(t, check);
	const meta = running
		? elapsedLabel(now - check.startedAt)
		: check.durationMs !== undefined
			? formatDuration(check.durationMs)
			: undefined;
	return (
		<BoardRow
			data={{ "data-board-session": "check", "data-state": check.state }}
			label={label}
			lead={
				<KindMark icon={FlaskConical} tone={running ? "info" : check.state === "passed" ? "success" : "danger"} />
			}
			meta={meta}
			onClick={check.state === "failed" && tabId && key ? () => requestRevealStep({ tabId, key }) : undefined}
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

function ChangesRow(summary: FamilyChangesSummary) {
	const t = useT();
	const { count, meta } = changesText(summary);
	// Each session's own share, one line each, when the sessions it opened changed files too.
	const title = summary.parts
		.map(({ title: name, summary: part }) => {
			const files = t("chat.work.filesChanged", {
				count: part.capped ? `${part.files}+` : part.files,
				plural: plural(part.files),
			});
			const lines = part.capped ? "" : ` +${part.added} −${part.removed}`;
			return `${name ?? t("workBoard.current.thisSession")}: ${files}${lines}`;
		})
		.join("\n");
	return (
		<BoardRow
			data={{ "data-board-session": "changes", ...(summary.parts.length > 0 ? { "data-board-family": "" } : {}) }}
			label={t("chat.work.filesChanged", { count, plural: plural(summary.files) })}
			lead={<KindMark icon={FileDiff} tone="muted" />}
			meta={meta}
			onClick={() => useUiStore.getState().setPanelTab("diff")}
			title={title || undefined}
		/>
	);
}

function UnlandedRow(summary: UnlandedSummary) {
	const t = useT();
	const { meta } = changesText(summary);
	return (
		<BoardRow
			data={{ "data-board-session": "unlanded" }}
			label={rowWords(t, { kind: "unlanded", ...summary })}
			lead={<KindMark icon={GitBranch} tone="muted" />}
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
			lead={<KindMark icon={Globe} tone="success" />}
			onClick={() => useUiStore.getState().openPreview(url)}
			title={command}
		/>
	);
}

/**
 * One line naming how many sessions share the checkout; a tap lists each on its own line (title, its device), and a
 * tap on one shows that session. The row expands in place (`data-board-expands`): the phone's strip stays open.
 */
function PeersRow({ worktree, repo, shared, peers }: PeersSummary) {
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
				label={rowWords(t, { kind: "peers", worktree, repo, shared, peers })}
				lead={<KindMark icon={Users} tone="muted" />}
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
										{peer.task ? <span className="text-(--sc-text-subtle)"> · {peer.task}</span> : null}
									</span>
								}
								lead={null}
								onClick={target ? () => void openPeer(target) : undefined}
								title={[
									name(peer),
									peer.task,
									peer.worktree,
									...(peer.shared ?? []).map(file => file.slice(file.lastIndexOf("/") + 1)),
								]
									.filter(Boolean)
									.join("\n")}
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
	const [, ...rest] = titles;
	return (
		<>
			<BoardRow
				data={{ "data-board-session": "recall", "data-open": String(open), "data-board-expands": "" }}
				label={rowWords(t, { kind: "recall", titles })}
				lead={<KindMark icon={Brain} tone="muted" />}
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

/** "Skills · how · tdd": the skills the newest turn read, its subagents' too; a tap shows the first one's read. */
function SkillsRow({ skills }: { skills: WorkSkillOutcome[] }) {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const key = skills.find(skill => skill.toolCallId)?.toolCallId;
	return (
		<BoardRow
			data={{ "data-board-session": "skills" }}
			label={rowWords(t, { kind: "skills", skills })}
			lead={<KindMark icon={BookOpen} tone="muted" />}
			onClick={tabId && key ? () => requestRevealStep({ tabId, key }) : undefined}
			title={skills.map(skill => (skill.agentName ? `${skill.name} (${skill.agentName})` : skill.name)).join("\n")}
		/>
	);
}

/** "Held back N steps for other sessions": the turn's calls the shared-checkout guard refused; a tap shows the first. */
function ProtectedRow({ protections }: { protections: WorkProtection[] }) {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const key = protections.find(protection => protection.toolCallId)?.toolCallId;
	return (
		<BoardRow
			data={{ "data-board-session": "protected" }}
			label={rowWords(t, { kind: "protected", protections })}
			lead={<KindMark icon={Shield} tone="muted" />}
			onClick={tabId && key ? () => requestRevealStep({ tabId, key }) : undefined}
			title={protections.map(({ what, agentName }) => (agentName ? `${what} (${agentName})` : what)).join("\n")}
		/>
	);
}

function SessionRow({ row }: { row: SessionRowModel }) {
	switch (row.kind) {
		case "changes":
			return (
				<ChangesRow
					added={row.added}
					capped={row.capped}
					files={row.files}
					parts={row.parts}
					removed={row.removed}
				/>
			);
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
			return <PeersRow peers={row.peers} repo={row.repo} shared={row.shared} worktree={row.worktree} />;
		case "recall":
			return <RecallRow titles={row.titles} />;
		case "skills":
			return <SkillsRow skills={row.skills} />;
		case "protected":
			return <ProtectedRow protections={row.protections} />;
	}
}

export function CurrentSection({ rows, aside }: { rows: SessionRowModel[]; aside?: string }) {
	const t = useT();
	const lead = rows[0];
	if (!lead) return null;
	return (
		<BoardSection aside={aside} id="current" summary={{ lead: rowWords(t, lead) }} title={t("workBoard.current")}>
			{rows.map(row => (
				<SessionRow key={row.kind === "dev-server" ? `dev-server:${row.url}` : row.kind} row={row} />
			))}
		</BoardSection>
	);
}

/**
 * What a quiet board's head says the last turn left, in one phrase: the files it changed with their lines, else its
 * passing check, else what its branch has not landed; null when there is nothing to say (the head reads "Idle").
 */
export function quietOutcome(
	t: (key: string, params?: Record<string, string | number>) => string,
	rows: readonly SessionRowModel[],
): string | null {
	const lead =
		rows.find(row => row.kind === "changes") ??
		rows.find(row => row.kind === "check" && row.check.state === "passed") ??
		rows.find(row => row.kind === "unlanded");
	return lead ? rowWords(t, lead) : null;
}

/**
 * The board mounts the session slot from a lazy chunk (the phone's first screen has no room for the rows' code): the
 * "Current work" section near its foot, which also tells the head what the last turn left.
 */
export function SessionSlot({
	turn,
	aside,
	onOutcome,
}: {
	turn: TurnWindow | null;
	aside?: string;
	onOutcome: (outcome: string | null) => void;
}) {
	const t = useT();
	const { rows } = useSessionBoard(turn);
	const outcome = quietOutcome(t, rows);
	useEffect(() => {
		onOutcome(outcome);
		return () => onOutcome(null);
	}, [outcome, onOutcome]);
	return <CurrentSection aside={aside} rows={rows} />;
}
