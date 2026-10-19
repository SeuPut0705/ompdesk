import { Check, Circle, Plus, X } from "lucide-react";
import { useState } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { Button, IconButton, Input, SettingInfo } from "../../common";
import { useAutopilotActions } from "./use-autopilot-actions";

/** Items the user pinned: the agent takes them before any rotation pick. Done ones stay with the cycle that did them. */
export function AutopilotBacklog() {
	const t = useT();
	const backlog = useAutopilotStore(s => s.status.backlog);
	const state = useAutopilotStore(s => s.status.state);
	const { run, pending } = useAutopilotActions();
	const [text, setText] = useState("");
	const trimmed = text.trim();
	const ended = state === "ended";
	const add = async () => {
		if (!trimmed) return;
		if (await run({ action: "backlog_add", text: trimmed })) setText("");
	};
	return (
		<section className="flex flex-col gap-2 border-t border-(--sc-divider) px-3 py-3" data-autopilot-backlog>
			<h3 className="flex items-center gap-1 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
				{t("autopilot.backlog")}
				<SettingInfo text={t("autopilot.sheet.backlogHint")} />
			</h3>
			{backlog && backlog.length > 0 && (
				<ul className="flex flex-col gap-0.5">
					{backlog.map(item => (
						<li
							className="flex min-w-0 items-center gap-1.5 text-sc-sm"
							data-backlog-item={item.id}
							key={item.id}
						>
							{item.done ? (
								<Check aria-hidden className="size-3.5 shrink-0 text-(--sc-success)" />
							) : (
								<Circle aria-hidden className="size-3.5 shrink-0 text-(--sc-text-subtle)" />
							)}
							<span
								className={cx("min-w-0 flex-1 truncate", item.done && "text-(--sc-text-muted)")}
								title={item.text}
							>
								{item.text}
								{item.done && item.cycle !== undefined && (
									<span className="text-sc-xs text-(--sc-text-muted)">
										{" "}
										({t("autopilot.cycleN", { n: item.cycle })})
									</span>
								)}
							</span>
							{!item.done && (
								<IconButton
									icon={<X />}
									label={t("autopilot.backlogRemove")}
									onClick={() => void run({ action: "backlog_remove", id: item.id })}
									size="sm"
								/>
							)}
						</li>
					))}
				</ul>
			)}
			{!ended && (
				<form
					className="flex items-center gap-1.5"
					onSubmit={event => {
						event.preventDefault();
						void add();
					}}
				>
					<Input
						aria-label={t("autopilot.backlogAdd")}
						className="min-w-0 flex-1"
						data-autopilot-backlog-input
						onChange={event => setText(event.target.value)}
						placeholder={t("autopilot.backlogPlaceholder")}
						value={text}
					/>
					<Button
						data-autopilot-backlog-add
						disabled={!trimmed || pending === "backlog_add"}
						icon={<Plus aria-hidden />}
						loading={pending === "backlog_add"}
						size="sm"
						type="submit"
						variant="secondary"
					>
						{t("autopilot.backlogAdd")}
					</Button>
				</form>
			)}
		</section>
	);
}
