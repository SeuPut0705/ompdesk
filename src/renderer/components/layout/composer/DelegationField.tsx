/**
 * Delegation: how readily this tab's agent hands work to subagents, from Solo (no task tool) to Swarm. A section
 * of the composer's Run popover (`RunChip`); the chip shows a glyph while the strength is not "your settings".
 * Each strength is a set of stock `task.*` settings the gui-bridge holds as runtime overrides on the tab's omp
 * (resources/gui-bridge/modes/delegation-contracts.ts), so it applies from the next turn and never touches
 * config.yml; "your settings" holds nothing. The last choice is remembered (prefs `delegationMode`) for new and
 * restarted tabs. An omp that cannot report a strength gets no section (`useDelegation` reports `null`).
 */

import { Network } from "lucide-react";
import { useEffect, useState } from "react";
import {
	DELEGATION_MODES,
	DELEGATION_PREF,
	type DelegationMode,
	isDelegationMode,
} from "../../../../../resources/gui-bridge/modes/delegation-contracts";
import { saveGuiPreference } from "../../../lib/display-preferences";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useSessionStore } from "../../../stores/session";
import { toastError } from "../../../stores/toast";
import { ChoiceRow } from "./ChoiceRow";

/** The mode a `get_delegation` / `set_delegation` reply carries, if it carries one. */
function replyMode(data: unknown): DelegationMode | null {
	if (typeof data !== "object" || data === null || !("mode" in data)) return null;
	return isDelegationMode(data.mode) ? data.mode : null;
}

export interface DelegationState {
	/** The tab's held strength; `null` while unknown or when the omp cannot report one (no section). */
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

/**
 * The strengths as one line: the network glyph and a segmented row of short names (the full name is each segment's
 * tooltip and accessible name). What the held strength does, and that it applies from the next turn, sit behind (i).
 */
export function DelegationField({ mode, onPick }: { mode: DelegationMode; onPick: (next: DelegationMode) => void }) {
	const t = useT();
	return (
		<section aria-label={t("input.delegation.title")} className="break-keep" data-delegation-section>
			<ChoiceRow
				icon={Network}
				info={`${t(`input.delegation.desc.${mode}`)} ${t("input.delegation.note")}`}
				label={t("input.delegation.title")}
				onChange={onPick}
				optionAttr="data-delegation-option"
				options={DELEGATION_MODES.map(option => ({
					value: option,
					label: t(`input.delegation.short.${option}`),
					name: t(`input.delegation.mode.${option}`),
				}))}
				value={mode}
			/>
		</section>
	);
}
