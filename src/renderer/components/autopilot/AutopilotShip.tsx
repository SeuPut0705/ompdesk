import { ExternalLink, GitMerge, GitPullRequest, Rocket, Upload, X } from "lucide-react";
import { useState } from "react";
import {
	type AutopilotReleaseCadence,
	DEFAULT_RELEASE_EVERY,
	type ShipQueueItem,
} from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { type TabRpc, useTabRpc } from "../../lib/tab-rpc";
import { useAutopilotStore } from "../../stores/autopilot";
import { useSessionStore } from "../../stores/session";
import { toastError } from "../../stores/toast";
import { Badge, type BadgeVariant, Button, Checkbox, ConfirmDialog, IconButton, Select, SwitchField } from "../common";
import { BoardRow, BoardSection, Dot } from "../layout/work-board/board-parts";
import { useAutopilotActions } from "./use-autopilot-actions";

const QUEUE_BADGE: Record<ShipQueueItem["state"], BadgeVariant> = {
	queued: "muted",
	running: "info",
	done: "success",
	failed: "error",
};

const EVERY_CHOICES = [3, 5, 10];

function cadenceValue(cadence: AutopilotReleaseCadence): string {
	return cadence.kind === "agent" ? "agent" : `every:${cadence.n}`;
}

function parseCadence(value: string): AutopilotReleaseCadence {
	if (value === "agent") return { kind: "agent" };
	const n = Number(value.slice("every:".length));
	return { kind: "every", n: Number.isFinite(n) && n > 0 ? n : DEFAULT_RELEASE_EVERY };
}

function QueueRow({ item, onCancel }: { item: ShipQueueItem; onCancel: () => void }) {
	const t = useT();
	return (
		<li
			className="flex min-w-0 items-center gap-2 text-sc-xs"
			data-ship-item={item.kind}
			data-ship-state={item.state}
			key={item.id}
		>
			<span className="shrink-0 font-medium">{t(`autopilot.ship.kind.${item.kind}`)}</span>
			<Badge variant={QUEUE_BADGE[item.state]}>{t(`autopilot.ship.state.${item.state}`)}</Badge>
			<span className="min-w-0 flex-1 truncate text-(--sc-text-muted)" title={item.detail}>
				{item.detail ?? ""}
			</span>
			{item.url && (
				<IconButton
					icon={<ExternalLink />}
					label={t("autopilot.ship.openLink")}
					onClick={() => openExternal(item.url as string)}
					size="sm"
				/>
			)}
			{item.state === "queued" && (
				<IconButton icon={<X />} label={t("autopilot.ship.cancel")} onClick={onCancel} size="sm" />
			)}
		</li>
	);
}

/**
 * Where a run's green cycles go, one line in its first board section: the one pull request a protected branch asked
 * for (with its link), or the shipping level (`board.ship*`). A run that simply lands on its default branch says
 * nothing (the user's call, 22 Oct 2026: "each green cycle lands" told them nothing). A run that lands has no
 * shipping section, so a release under way or its last release shows here too.
 */
export function ShipLandRow() {
	const t = useT();
	const ship = useAutopilotStore(s => s.status.ship);
	if (!ship) return null;
	const { policy, landing } = ship;
	const text = policy.land
		? landing
			? t("autopilot.ship.landPr")
			: null
		: t(
				policy.autoRelease.on
					? "autopilot.board.shipRelease"
					: policy.autoPush
						? "autopilot.board.shipPush"
						: "autopilot.board.shipLocal",
			);
	return (
		<>
			{text !== null && (
				<BoardRow
					action={
						landing?.url ? (
							<IconButton
								icon={<ExternalLink />}
								label={t("autopilot.ship.openPr")}
								onClick={() => openExternal(landing.url as string)}
								size="sm"
							/>
						) : undefined
					}
					data={landing ? { "data-ship-land": "pr" } : undefined}
					label={<span className="text-(--sc-text-muted)">{text}</span>}
					lead={<Dot tone={landing ? "warning" : "muted"} />}
					title={landing?.reason ? `${text}\n${landing.reason}` : text}
				/>
			)}
			{(policy.land || policy.automatic) && (ship.inFlight?.kind === "release" || ship.release) && (
				<li className="omp-work-board-item">
					<div className="omp-work-board-row">
						<span className="omp-work-board-lead">
							<Dot tone={ship.inFlight ? "warning" : ship.release?.state === "failure" ? "danger" : "muted"} />
						</span>
						<ReleaseStatus />
					</div>
				</li>
			)}
		</>
	);
}

/** A release under way, or the last one's version, state and run link. */
function ReleaseStatus() {
	const t = useT();
	const ship = useAutopilotStore(s => s.status.ship);
	if (ship?.inFlight?.kind === "release") {
		return (
			<span className="min-w-0 flex-1 truncate text-sc-xs text-(--sc-warning)" data-ship-inflight="release">
				{t("autopilot.ship.inFlightRelease")}
			</span>
		);
	}
	const release = ship?.release;
	if (!release) return null;
	return (
		<span
			className="flex min-w-0 flex-1 items-center gap-1.5 text-sc-xs text-(--sc-text-secondary)"
			data-ship-release={release.state}
		>
			<span className="min-w-0 truncate">{t("autopilot.ship.lastRelease", { version: release.version })}</span>
			<Badge variant={release.state === "success" ? "success" : release.state === "failure" ? "error" : "info"}>
				{t(`autopilot.ship.releaseState.${release.state}`)}
			</Badge>
			{release.runUrl && (
				<IconButton
					icon={<ExternalLink />}
					label={t("autopilot.ship.openRun")}
					onClick={() => openExternal(release.runUrl as string)}
					size="sm"
				/>
			)}
		</span>
	);
}

/**
 * The run's shipping section on the work board, for a run that does not land (a level picked at start): push, pull
 * request, merge into the base branch (each runs at the end of the turn in progress, in order), release (the agent
 * follows the repository's own procedure), automatic release and the queue's progress. A run that lands every green
 * cycle by itself has none: nothing here is the person's to do (`ShipLandRow` says where its cycles go).
 */
export function AutopilotShipSection() {
	const t = useT();
	const rpc: TabRpc = useTabRpc();
	const streaming = useSessionStore(s => s.isStreaming);
	const state = useAutopilotStore(s => s.status.state);
	const ship = useAutopilotStore(s => s.status.ship);
	const ahead = useAutopilotStore(s => s.branchStatus?.ahead);
	const base = useAutopilotStore(s => s.status.baseBranch);
	const branch = useAutopilotStore(s => s.status.branch);
	const pushTarget = useAutopilotStore(s => s.status.target);
	// A PR is opened from the branch Push moves (the target, when there is one); the base has nothing to compare with itself.
	const prOff = base !== undefined && (pushTarget ?? branch) === base;
	const { run, pending } = useAutopilotActions();
	const [merging, setMerging] = useState(false);
	const [mergeCommit, setMergeCommit] = useState(false);
	const [releasing, setReleasing] = useState(false);
	if (!ship || ship.policy.land || ship.policy.automatic) return null;
	const live = state !== undefined && state !== "ended";
	const policy = ship.policy;
	const procedure = ship.releaseProcedure;
	const releaseOff = !procedure || ship.releaseBlocked !== undefined;
	const releaseReason = releaseOff ? t("autopilot.ship.noProcedure") : undefined;
	const cadence = policy.autoRelease.cadence;
	const everyChoices =
		cadence.kind === "every" && !EVERY_CHOICES.includes(cadence.n)
			? [...EVERY_CHOICES, cadence.n].sort((a, b) => a - b)
			: EVERY_CHOICES;

	// "Release" is the user's own request in chat: the agent finishes the item in progress and follows the procedure.
	const requestRelease = async () => {
		const message = t("autopilot.ship.releaseMessage");
		const response = streaming ? await rpc.steer(message) : await rpc.prompt(message);
		if (!response.success) toastError({ title: t("autopilot.actionFailed"), error: response });
	};

	return (
		<BoardSection id="ship" title={t("autopilot.ship.title")}>
			<li className="omp-work-board-item">
				<div className="flex min-w-0 flex-col gap-2 px-1.5 pb-1.5" data-autopilot-ship>
					<div className="flex flex-wrap gap-1.5">
						<Button
							data-ship-button="push"
							icon={<Upload aria-hidden />}
							onClick={() => void run({ action: "ship", kind: "push" })}
							size="sm"
							variant="secondary"
						>
							{t("autopilot.ship.push")}
						</Button>
						<Button
							data-ship-button="pr"
							disabled={prOff}
							icon={<GitPullRequest aria-hidden />}
							onClick={() => void run({ action: "ship", kind: "pr" })}
							size="sm"
							title={prOff ? t("autopilot.ship.prOnBase", { base: base ?? "main" }) : undefined}
							variant="secondary"
						>
							{t("autopilot.ship.pr")}
						</Button>
						<Button
							data-ship-button="merge"
							icon={<GitMerge aria-hidden />}
							onClick={() => setMerging(true)}
							size="sm"
							variant="secondary"
						>
							{t("autopilot.ship.merge", { base: base ?? "main" })}
						</Button>
						<Button
							data-ship-button="release"
							disabled={releaseOff || !live}
							icon={<Rocket aria-hidden />}
							onClick={() => setReleasing(true)}
							size="sm"
							title={releaseReason}
							variant="secondary"
						>
							{t("autopilot.ship.release")}
						</Button>
					</div>
					<SwitchField
						checked={policy.autoRelease.on}
						data-ship-auto="release"
						description={releaseReason}
						disabled={releaseOff || pending === "ship"}
						label={t("autopilot.ship.autoRelease")}
						onCheckedChange={enabled => void run({ action: "ship", kind: "auto_release", enabled })}
						size="sm"
					/>
					{policy.autoRelease.on && (
						<Select
							aria-label={t("autopilot.ship.cadence")}
							controlSize="sm"
							data-ship-cadence
							onChange={event =>
								void run({
									action: "configure",
									ship: { autoRelease: { on: true, cadence: parseCadence(event.target.value) } },
								})
							}
							options={[
								...everyChoices.map(n => ({
									value: `every:${n}`,
									label: t("autopilot.ship.cadenceEvery", { n }),
								})),
								{ value: "agent", label: t("autopilot.ship.cadenceAgent") },
							]}
							value={cadenceValue(cadence)}
						/>
					)}
					{procedure && (
						<p className="text-sc-xs text-(--sc-text-muted)" data-ship-procedure>
							{t("autopilot.ship.procedure", { file: procedure.file, anchors: procedure.anchors.join(" › ") })}
						</p>
					)}
					{ship.queue.length > 0 && (
						<ul className="flex flex-col gap-1" data-ship-queue>
							{ship.queue.map(item => (
								<QueueRow
									item={item}
									key={item.id}
									onCancel={() => void run({ action: "cancel_ship", id: item.id })}
								/>
							))}
						</ul>
					)}
					{ship.inFlight && (
						<p className="text-sc-xs text-(--sc-warning)" data-ship-inflight={ship.inFlight.kind}>
							{t(
								ship.inFlight.kind === "release"
									? "autopilot.ship.inFlightRelease"
									: "autopilot.ship.inFlightPush",
							)}
						</p>
					)}
					{ship.release && ship.inFlight?.kind !== "release" && <ReleaseStatus />}
					<ConfirmDialog
						busy={pending === "ship"}
						confirmLabel={t("autopilot.ship.mergeConfirm.action")}
						message={
							<div className="flex flex-col gap-2">
								<p>{t("autopilot.ship.mergeConfirm.body", { count: ahead ?? 0, base: base ?? "main" })}</p>
								<label className="flex items-center gap-2 text-sc-sm">
									<Checkbox
										checked={mergeCommit}
										data-ship-merge-commit
										onChange={event => setMergeCommit(event.target.checked)}
									/>
									{t("autopilot.ship.mergeConfirm.commit")}
								</label>
							</div>
						}
						onCancel={() => setMerging(false)}
						onConfirm={() => {
							setMerging(false);
							void run({ action: "ship", kind: "merge", mode: mergeCommit ? "merge_commit" : "ff" });
						}}
						open={merging}
						title={t("autopilot.ship.mergeConfirm.title", { base: base ?? "main" })}
						warning={t("autopilot.ship.mergeConfirm.warning")}
					/>
					<ConfirmDialog
						confirmLabel={t("autopilot.ship.release")}
						message={t("autopilot.ship.releaseConfirm.body")}
						onCancel={() => setReleasing(false)}
						onConfirm={() => {
							setReleasing(false);
							void requestRelease();
						}}
						open={releasing}
						title={t("autopilot.ship.releaseConfirm.title")}
					/>
				</div>
			</li>
		</BoardSection>
	);
}
