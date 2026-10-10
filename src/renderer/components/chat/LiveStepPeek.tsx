import { Brain, Radio } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { cx, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { type MessagesStore, useMessagesStore } from "../../stores/messages";
import { useSessionRuntime } from "../../stores/session-runtime-context";
import { selectToolEntry, type ToolsStore, useToolsStore } from "../../stores/tools";
import { getToolHeader, getToolRenderer } from "../tools/index";
import { ToolPathTarget } from "../tools/ToolCard";
import { collapseWaitSteps, selectLiveStep } from "./live-step";

/** One bounded work surface, with a replay strip rather than an accumulating log. */
export function LiveStepPeek({ thinkingLive, toolCallIds }: { thinkingLive: boolean; toolCallIds: readonly string[] }) {
	const t = useT();
	const runtime = useSessionRuntime();
	const tools = (runtime?.stores.get("tools") as StoreApi<ToolsStore> | undefined) ?? useToolsStore;
	const messages = (runtime?.stores.get("messages") as StoreApi<MessagesStore> | undefined) ?? useMessagesStore;
	const stepKey = useFrameSelector(tools, s => {
		const step = selectLiveStep(toolCallIds, { get: id => selectToolEntry(s, id) }, thinkingLive);
		return step?.kind === "tool" ? step.id : step?.kind === "thinking" ? "thinking" : "";
	});
	const stripKey = useFrameSelector(tools, s =>
		toolCallIds
			.map(id => {
				const entry = selectToolEntry(s, id);
				return entry ? `${id}:${entry.status}:${entry.toolName}` : "";
			})
			.join("|"),
	);
	const [replay, setReplay] = useState<string | null>(null);
	const selected = replay ?? stepKey;
	// Only the chosen entry/result is subscribed: unrelated partial results are ignored.
	const entry = useFrameSelector(tools, s => (selected ? selectToolEntry(s, selected) : undefined));
	const partial = useFrameSelector(tools, s => (selected ? s.partialResults.get(selected) : undefined));
	const reasoning = useFrameSelector(messages, s => (selected === "thinking" ? s.streamingThinking.slice(-600) : ""));
	const scrollRef = useRef<HTMLDivElement>(null);
	const stripRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const previousStep = useRef(selected);
	const header = entry ? getToolHeader(entry.toolName, entry.args) : null;
	const live = replay === null;
	const kind = selected === "thinking" ? "thinking" : (header?.tool ?? "thinking");
	const latest = kind === "bash" || kind === "eval" || kind === "write" || kind === "edit" || kind === "ast_edit";
	// stripKey deliberately contains only status/kind, not any tool output.
	void stripKey;
	const steps = collapseWaitSteps(toolCallIds, { get: id => selectToolEntry(tools.getState(), id) });
	const selectedStep = steps.find(step => step.ids.includes(selected));
	const startTime = selectedStep?.startedAt ?? entry?.startTime ?? 0;
	const now = useNowTick(kind === "wait" && live);
	// biome-ignore lint/correctness/useExhaustiveDependencies: streaming content must repin the nested renderer after layout.
	useLayoutEffect(() => {
		if (previousStep.current !== selected) {
			stickRef.current = true;
			previousStep.current = selected;
		}
		const element = scrollRef.current;
		if (!element) return;
		if (!latest) {
			element.scrollTop = 0;
			return;
		}
		if (stickRef.current) {
			element.scrollTop = element.scrollHeight;
			for (const child of element.querySelectorAll<HTMLElement>("pre, .overflow-y-auto, .overflow-auto")) {
				child.scrollTop = child.scrollHeight;
			}
		}
	}, [entry, partial, latest, selected]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: selected/status changes update chip geometry and aria-pressed after layout.
	useLayoutEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;
		const revealCurrent = () => {
			const current = strip.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
			if (!current) return;
			const viewport = strip.getBoundingClientRect();
			const chip = current.getBoundingClientRect();
			if (chip.right > viewport.right) strip.scrollLeft += chip.right - viewport.right;
			else if (chip.left < viewport.left) strip.scrollLeft -= viewport.left - chip.left;
		};
		revealCurrent();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(revealCurrent);
		observer.observe(strip);
		return () => observer.disconnect();
	}, [selected, stripKey]);
	const Renderer = entry ? getToolRenderer(entry.toolName) : null;
	const Icon = header?.icon ?? Brain;
	return (
		<div className="omp-live-step" data-following={live} data-surface={kind}>
			<div className="omp-live-work-heading">
				<Icon aria-hidden className="omp-live-step-icon" />
				<span>{header?.labelKey ? t(header.labelKey) : (header?.tool ?? t("chat.thinking.live"))}</span>
				{header?.path ? (
					<ToolPathTarget path={header.path} />
				) : header?.target ? (
					<span className="min-w-0 truncate font-mono" title={header.target}>
						{header.target}
					</span>
				) : null}
				<span className="omp-live-work-mode">{t(live ? "chat.work.live" : "chat.work.replay")}</span>
			</div>
			<div
				className="omp-live-step-scroll"
				ref={scrollRef}
				tabIndex={0}
				role="region"
				aria-label={t("chat.work.surface")}
				onScroll={event => {
					const element = event.currentTarget;
					stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
				}}
			>
				{kind === "wait" && !entry?.isError && entry?.status !== "error" && entry?.status !== "aborted" ? (
					<div className="omp-live-work-calm" data-wait-line>
						{t("chat.work.waiting")}{" "}
						<span className="tabular-nums">
							· {formatDuration(Math.max(0, (live ? now : (entry?.endTime ?? now)) - startTime))}
						</span>
					</div>
				) : Renderer && entry ? (
					<Renderer
						key={selected}
						args={entry.args}
						result={entry.result}
						partialResult={partial}
						isPartial={entry.status === "pending" || entry.status === "running"}
						isError={entry.isError || entry.status === "error"}
						interrupted={entry.status === "aborted"}
						livePreview
						toolCallId={selected}
					/>
				) : (
					<div className="omp-live-work-calm">{reasoning || t("chat.thinking.live")}</div>
				)}
			</div>
			<div className="omp-live-work-strip" role="group" aria-label={t("chat.work.steps")}>
				<div className="omp-live-work-chips" ref={stripRef}>
					{steps.map((step, index) => {
						const item = selectToolEntry(tools.getState(), step.id);
						if (!item) return null;
						const meta = getToolHeader(item.toolName, item.args);
						const StepIcon = meta.icon;
						const label = `${index + 1}. ${meta.labelKey ? t(meta.labelKey) : meta.tool}${meta.path || meta.target ? ` · ${meta.path ?? meta.target}` : ""}`;
						return (
							<button
								type="button"
								key={step.ids[0]}
								className={cx(
									"omp-live-work-chip",
									item.status !== "pending" && item.status !== "running" && "omp-live-work-chip--finished",
								)}
								aria-label={label}
								title={label}
								aria-pressed={step.ids.includes(selected)}
								data-step-id={step.id}
								onClick={() => setReplay(step.id)}
							>
								<StepIcon aria-hidden className="omp-live-step-icon" />
								<span className="tabular-nums">{index + 1}</span>
							</button>
						);
					})}
				</div>
				<button
					type="button"
					className="omp-live-work-chip omp-live-work-follow"
					aria-pressed={live}
					onClick={() => setReplay(null)}
				>
					<Radio aria-hidden className="omp-live-step-icon" />
					{t("chat.work.live")}
				</button>
			</div>
		</div>
	);
}
