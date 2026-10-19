/**
 * Memory › Handoffs: the notes the next session in a folder starts from, open ones first. Reading one here does not
 * claim it (the next session still gets it); Cancel discards an open one.
 */
import { X } from "lucide-react";
import { useState } from "react";
import type { AiMemoryHandoff, AiMemoryProjectRef } from "../../../../shared/ai-memory";
import { formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { Badge, Button, ConfirmDialog, MasterDetail, SettingInfo, SkeletonRows } from "../../common";
import { LIST_ROW, MemoryFrame, MutedLine, oneLine, ReadError, useMemoryAction } from "./memory-ui";
import { projectKey, useMemoryRead } from "./use-memory-read";

export function MemoryHandoffs({ project }: { project: AiMemoryProjectRef }) {
	const t = useT();
	const read = useMemoryRead<AiMemoryHandoff[]>(`handoffs/${projectKey(project)}`, () =>
		window.omp.aiMemory.handoffs(project),
	);
	const [openId, setOpenId] = useState<string | null>(null);
	const [confirm, setConfirm] = useState(false);
	const { busy, run } = useMemoryAction();
	const items = [...(read.data ?? [])].sort((a, b) => Number(b.state === "open") - Number(a.state === "open"));
	const chosen = items.find(item => item.id === openId) ?? null;

	const list = (
		<div className="flex flex-col gap-0.5" data-memory-handoffs-list>
			<p className="flex items-center gap-1 px-1 pb-1 text-sc-xs text-(--sc-text-muted)">
				{t("memory.handoffs.title")}
				<SettingInfo text={t("memory.handoffs.info")} />
			</p>
			<ReadError error={read.error} onRetry={read.refresh} />
			{read.data === undefined && !read.error && <SkeletonRows label={t("common.loading")} widths={[70, 55]} />}
			{read.data && items.length === 0 && <MutedLine data-memory-empty>{t("memory.handoffs.empty")}</MutedLine>}
			{items.map(item => (
				<button
					aria-pressed={item.id === openId}
					className={LIST_ROW}
					data-memory-handoff={item.id}
					key={item.id}
					onClick={() => setOpenId(item.id)}
					type="button"
				>
					<span className="shrink-0 font-medium">{item.agent || "?"}</span>
					<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{formatTimeAgo(item.createdAt)}</span>
					<span className="min-w-0 flex-1 truncate text-(--sc-text-secondary)">{oneLine(item.summary)}</span>
					{item.state !== "open" && (
						<Badge variant="muted">{t(`memory.handoffs.state.${stateKey(item.state)}`)}</Badge>
					)}
				</button>
			))}
		</div>
	);

	const detail = chosen ? (
		<article className="flex min-w-0 flex-col gap-2 p-3" data-memory-handoff-detail={chosen.id}>
			<header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sc-sm">
				<h3 className="font-semibold text-(--sc-text)">
					{t("memory.handoffs.from", { agent: chosen.agent || "?" })}
				</h3>
				<span className="text-sc-xs text-(--sc-text-muted)">{formatTimeAgo(chosen.createdAt)}</span>
				<Badge variant={chosen.state === "open" ? "accent" : "muted"}>
					{t(`memory.handoffs.state.${stateKey(chosen.state)}`)}
				</Badge>
				{chosen.state === "open" && (
					<Button
						className="ml-auto"
						data-memory-handoff-cancel
						icon={<X />}
						onClick={() => setConfirm(true)}
						size="sm"
						variant="danger"
					>
						{t("memory.handoffs.cancel")}
					</Button>
				)}
			</header>
			<Block label={t("memory.handoffs.summary")} text={chosen.summary} />
			{chosen.openQuestions.length > 0 && (
				<Block
					label={t("memory.handoffs.questions")}
					text={chosen.openQuestions.map(line => `• ${line}`).join("\n")}
				/>
			)}
			{chosen.nextSteps.length > 0 && (
				<Block label={t("memory.handoffs.steps")} text={chosen.nextSteps.map(line => `• ${line}`).join("\n")} />
			)}
			<ConfirmDialog
				busy={busy === "cancel"}
				confirmLabel={t("memory.handoffs.cancel")}
				message={t("memory.handoffs.cancel.message", { agent: chosen.agent || "?" })}
				onCancel={() => setConfirm(false)}
				onConfirm={() =>
					void run(
						"cancel",
						async () => {
							await window.omp.aiMemory.cancelHandoff(project, chosen.id);
							return true;
						},
						t("memory.handoffs.cancelled"),
					).then(ok => {
						setConfirm(false);
						if (ok) setOpenId(null);
					})
				}
				open={confirm}
				title={t("memory.handoffs.cancel.title")}
			/>
		</article>
	) : (
		<MutedLine data-memory-pick>{t("memory.handoffs.pick")}</MutedLine>
	);

	return (
		<MemoryFrame>
			<MasterDetail
				backLabel={t("memory.tab.handoffs")}
				detail={detail}
				label={t("memory.tab.handoffs")}
				list={list}
				onBack={() => setOpenId(null)}
				open={chosen !== null}
			/>
		</MemoryFrame>
	);
}

function stateKey(state: string): "open" | "accepted" | "expired" {
	return state === "open" || state === "accepted" ? state : "expired";
}

function Block({ label, text }: { label: string; text: string }) {
	return (
		<section className="flex flex-col gap-0.5">
			<h4 className="text-sc-xs font-semibold text-(--sc-text-muted) uppercase">{label}</h4>
			<p className="max-h-60 overflow-y-auto text-sc-sm break-words whitespace-pre-wrap text-(--sc-text-secondary)">
				{text}
			</p>
		</section>
	);
}
