/**
 * Delegation: how readily this tab's agent hands work to subagents, from Solo (no task tool) to Swarm. A section
 * of the composer's Run popover (`RunChip`); the chip shows a glyph while the strength is not "your settings".
 * Each strength is a set of stock `task.*` settings the gui-bridge holds as runtime overrides on the tab's omp
 * (resources/gui-bridge/modes/delegation-contracts.ts), so it applies from the next turn and never touches
 * config.yml; "your settings" holds nothing. The last choice is remembered (prefs `delegationMode`) for new and
 * restarted tabs. An omp that cannot report a strength gets no section (`useDelegation` reports `null`).
 */

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import {
	DELEGATION_MODES,
	DELEGATION_PREF,
	type DelegationMode,
	isDelegationMode,
} from "../../../../../resources/gui-bridge/modes/delegation-contracts";
import { saveGuiPreference } from "../../../lib/display-preferences";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useSessionStore } from "../../../stores/session";
import { toastError } from "../../../stores/toast";

/** The mode a `get_delegation` / `set_delegation` reply carries, if it carries one. */
function replyMode(data: unknown): DelegationMode | null {
	if (typeof data !== "object" || data === null || !("mode" in data)) return null;
	return isDelegationMode(data.mode) ? data.mode : null;
}

export interface DelegationState {
	/** The tab's held strength; `null` while unknown or when the omp cannot report one (no section, no glyph). */
	mode: DelegationMode | null;
	/** A switch is in flight. */
	pending: boolean;
	pick: (next: DelegationMode) => Promise<void>;
}

/** Reads the strength on every session and on each popover open (a Settings write of a task setting releases it). */
export function useDelegation(open: boolean): DelegationState {
	const t = useT();
	const rpc = useTabRpc();
	const sessionId = useSessionStore(state => state.sessionId);
	const ready = useSessionStore(state => state.status) === "ready";
	const [mode, setMode] = useState<DelegationMode | null>(null);
	const [pending, setPending] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId and open are re-read triggers, not inputs.
	useEffect(() => {
		if (!ready) return;
		let live = true;
		// A rejected or thrown call (an omp or client without the method) leaves the section out.
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

	const pick = async (next: DelegationMode) => {
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

	return { mode, pending, pick };
}

/** The strengths as a radio group (one tab stop: the held one; arrows move between the rest) with each one's effect. */
export function DelegationField({ mode, onPick }: { mode: DelegationMode; onPick: (next: DelegationMode) => void }) {
	const t = useT();
	return (
		<section
			aria-label={t("input.delegation.title")}
			className="flex flex-col gap-1 break-keep"
			data-delegation-section
		>
			<h3 className="text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase">
				{t("input.delegation.title")}
			</h3>
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
							"flex min-h-(--sc-row-action) w-full items-start gap-2 rounded-(--sc-radius-md) px-2 py-1 text-left hover:bg-(--sc-hover) focus-visible:bg-(--sc-hover)",
							option === mode && "bg-(--sc-selected)",
						)}
						data-delegation-option={option}
						key={option}
						onClick={() => onPick(option)}
						role="radio"
						tabIndex={option === mode ? 0 : -1}
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
			<p className="mt-1 text-sc-xs break-keep text-(--sc-text-muted)">{t("input.delegation.note")}</p>
		</section>
	);
}
