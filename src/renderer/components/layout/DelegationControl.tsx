/**
 * Composer delegation chip: how readily this tab's agent hands work to
 * subagents, from Solo (no task tool) to Swarm. Each strength is a set of
 * stock `task.*` settings the gui-bridge holds as runtime overrides on the
 * tab's omp (resources/gui-bridge/delegation-contracts.ts), so it applies from
 * the next turn and never touches config.yml; "your settings" holds nothing.
 * The last choice is remembered (prefs `delegationMode`) for new and restarted
 * tabs. An omp that cannot report a strength gets no chip.
 */

import { Check, ChevronDown, Network } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	DELEGATION_MODES,
	DELEGATION_PREF,
	type DelegationMode,
	isDelegationMode,
} from "../../../../resources/gui-bridge/delegation-contracts";
import { saveGuiPreference } from "../../lib/display-preferences";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { toastError } from "../../stores/toast";
import { Button, Popover, Tooltip } from "../common";

/** The mode a `get_delegation` / `set_delegation` reply carries, if it carries one. */
function replyMode(data: unknown): DelegationMode | null {
	if (typeof data !== "object" || data === null || !("mode" in data)) return null;
	return isDelegationMode(data.mode) ? data.mode : null;
}

export function DelegationControl() {
	const t = useT();
	const rpc = useTabRpc();
	const sessionId = useSessionStore(state => state.sessionId);
	const ready = useSessionStore(state => state.status) === "ready";
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<DelegationMode | null>(null);
	const [pending, setPending] = useState(false);

	// Re-read on every session and on each open: a Settings write of a task
	// setting releases the strength on the omp side.
	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId and open are re-read triggers, not inputs.
	useEffect(() => {
		if (!ready) return;
		let live = true;
		// A rejected or thrown call (an omp or client without the method) leaves the chip out.
		void Promise.resolve()
			.then(() => rpc.getDelegation())
			.then(response => {
				if (live) setMode(response.success ? replyMode(response.data) : null);
			})
			.catch(() => {
				if (live) setMode(null);
			});
		return () => {
			live = false;
		};
	}, [rpc, ready, sessionId, open]);

	if (mode === null) return null;

	const pick = async (next: DelegationMode) => {
		setOpen(false);
		if (next === mode || pending) return;
		setPending(true);
		try {
			const response = await rpc.setDelegation(next);
			if (!response.success) throw new Error(response.error);
			const held = replyMode(response.data) ?? next;
			setMode(held);
			await saveGuiPreference(DELEGATION_PREF, held, () => {});
		} catch (error) {
			toastError({ title: t("input.delegation.failed"), error });
		} finally {
			setPending(false);
		}
	};

	const name = t(`input.delegation.mode.${mode}`);
	return (
		<>
			<Tooltip content={t("input.delegation.title")} describe={false}>
				<Button
					aria-expanded={open}
					aria-haspopup="dialog"
					aria-label={`${t("input.delegation.title")}: ${name}`}
					className="omp-composer-chip"
					data-delegation-trigger
					disabled={pending}
					icon={<Network aria-hidden />}
					onClick={() => setOpen(value => !value)}
					ref={triggerRef}
					size="sm"
					trailingIcon={<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />}
					variant="ghost"
				>
					{mode !== "default" && <span className="omp-composer-control-label">{name}</span>}
				</Button>
			</Tooltip>
			<Popover
				anchorRef={triggerRef}
				ariaLabel={t("input.delegation.title")}
				className="w-80"
				onClose={() => setOpen(false)}
				open={open}
				placement="top-start"
			>
				<div
					aria-label={t("input.delegation.title")}
					className="flex flex-col gap-0.5"
					onKeyDown={event => {
						if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
						const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]"));
						const index = options.indexOf(event.target as HTMLElement);
						if (index < 0) return;
						event.preventDefault();
						const step = event.key === "ArrowDown" ? 1 : -1;
						options[(index + step + options.length) % options.length]?.focus();
					}}
					role="radiogroup"
				>
					{DELEGATION_MODES.map(option => (
						<button
							aria-checked={option === mode}
							className={cx(
								"flex w-full items-start gap-2 rounded-(--sc-radius-md) px-2 py-1.5 text-left hover:bg-(--sc-hover) focus-visible:bg-(--sc-hover)",
								option === mode && "bg-(--sc-selected)",
							)}
							data-delegation-option={option}
							key={option}
							onClick={() => void pick(option)}
							role="radio"
							type="button"
						>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-sc-sm font-medium text-(--sc-text)">
									{t(`input.delegation.mode.${option}`)}
								</span>
								<span className="text-sc-xs break-keep text-(--sc-text-muted)">
									{t(`input.delegation.desc.${option}`)}
								</span>
							</span>
							{option === mode && <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-(--sc-accent)" />}
						</button>
					))}
				</div>
				<p className="mt-2 border-t border-(--sc-border-subtle) pt-2 text-sc-xs break-keep text-(--sc-text-muted)">
					{t("input.delegation.note")}
				</p>
			</Popover>
		</>
	);
}
