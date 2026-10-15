/**
 * Getting-started checklist at the foot of the sidebar. Each step completes
 * from real app state — a model that can answer, a sent prompt, a session in
 * a project folder, a split view, the side panel — and stays done once seen
 * (`stores/starter-guide`). Only the next step shows its hint and a "Show me"
 * that spotlights the real control (StarterTour). Hidden while the inline
 * first-run setup has the main area, and for good once the user hides it.
 */

import { ChevronDown, Circle, CircleCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { STARTER_STEPS, type StarterStep, useStarterGuideStore } from "../../stores/starter-guide";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { Button } from "../common";
import { ProductStar } from "../settings/ProductStar";
import { useFirstRunActive } from "./FirstRunSetup";

export function StarterGuide({ promptSent, projectOpened }: { promptSent: boolean; projectOpened: boolean }) {
	const t = useT();
	const firstRunActive = useFirstRunActive();
	const loaded = useStarterGuideStore(state => state.loaded);
	const done = useStarterGuideStore(state => state.done);
	const dismissed = useStarterGuideStore(state => state.dismissed);
	const modelReady = useModelStore(state => state.availableModels.length > 0);
	const prompted = useSessionStore(state => state.messageCount > 0) || promptSent;
	const split = useTabsStore(state => state.split !== null);
	const panel = useUiStore(state => state.panelVisible);
	const [open, setOpen] = useState(false);
	const listId = useId();

	useEffect(() => {
		void useStarterGuideStore.getState().load();
	}, []);

	useEffect(() => {
		const reached: StarterStep[] = [];
		if (modelReady) reached.push("model");
		if (prompted) reached.push("prompt");
		if (projectOpened) reached.push("project");
		if (split) reached.push("split");
		if (panel) reached.push("panel");
		useStarterGuideStore.getState().complete(reached);
	}, [modelReady, prompted, projectOpened, split, panel]);

	if (!loaded || dismissed || firstRunActive) return null;

	const next = STARTER_STEPS.find(step => !done.includes(step));
	return (
		<section
			aria-label={t("starter.title")}
			className="shrink-0 border-t border-(--sc-divider) px-2 pt-2"
			data-starter-guide
		>
			<button
				aria-controls={listId}
				aria-expanded={open}
				className="flex min-h-(--sc-control-sm) w-full min-w-0 items-center gap-2 rounded-(--sc-radius-md) px-2.5 text-sc-sm text-(--sc-text-secondary) hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
				onClick={() => setOpen(value => !value)}
				type="button"
			>
				<span className="min-w-0 flex-1 truncate text-left">{next ? t("starter.title") : t("starter.allSet")}</span>
				<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)">
					{t("starter.progress", { done: done.length, total: STARTER_STEPS.length })}
				</span>
				<ChevronDown aria-hidden className={cx("size-3.5 shrink-0", open && "rotate-180")} />
			</button>
			{open && (
				<div className="pb-2" id={listId}>
					<ol className="mt-1 flex flex-col">
						{STARTER_STEPS.map(step => {
							const complete = done.includes(step);
							return (
								<li className="px-2.5 py-1" data-done={String(complete)} data-starter-step={step} key={step}>
									<div className="flex min-w-0 items-center gap-2 text-sc-sm">
										{complete ? (
											<CircleCheck aria-hidden className="size-3.5 shrink-0 text-(--sc-success)" />
										) : (
											<Circle aria-hidden className="size-3.5 shrink-0 text-(--sc-text-subtle)" />
										)}
										<span
											className={cx(
												"min-w-0 flex-1 truncate",
												complete ? "text-(--sc-text-muted)" : "text-(--sc-text)",
											)}
										>
											{t(`starter.step.${step}.title`)}
										</span>
										{complete && <span className="sr-only">{t("starter.done")}</span>}
									</div>
									{step === next && (
										<div className="mt-1 flex flex-col items-start gap-1.5 pl-5.5">
											<p className="text-sc-xs break-keep text-(--sc-text-muted)">
												{t(`starter.step.${step}.hint`)}
											</p>
											<Button
												onClick={() => useStarterGuideStore.getState().startTour(step)}
												size="sm"
												variant="secondary"
											>
												{t("starter.showMe")}
											</Button>
										</div>
									)}
								</li>
							);
						})}
					</ol>
					{!next && (
						// Every step done: mixdog's last onboarding step, starring the repository.
						<div className="mt-1 flex flex-col items-start gap-1.5 px-2.5" data-starter-star>
							<p className="text-sc-xs break-keep text-(--sc-text-muted)">{t("starter.star")}</p>
							<ProductStar />
						</div>
					)}
					<div className="mt-1 px-1">
						<Button onClick={() => useStarterGuideStore.getState().dismiss()} size="sm" variant="ghost">
							{t("starter.hide")}
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}
