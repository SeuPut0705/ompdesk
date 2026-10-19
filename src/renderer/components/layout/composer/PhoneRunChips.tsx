/**
 * The phone toolbar's own Thinking and Delegation chips: on a phone every composer control is visible in the box's one
 * row (the user's rule), so these two are not only reachable through the Run chip. Each chip is its glyph with the value
 * as a tiny badge (Brain + the level's short name, Network + how many subagents at a time; the full value is the
 * accessible name) and opens its field in a focus-keeping bottom sheet (`ComposerSheet`), like the context chip; the soft
 * keyboard stays up.
 */
import { Brain, Network } from "lucide-react";
import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { ComposerSheet } from "./ComposerSheet";
import { DelegationField, delegationCount, useDelegation } from "./DelegationField";
import { keepFocus } from "./keep-focus";
import { useThinkingName } from "./RunSettings";
import { ThinkingLevelField, useThinkingSelector } from "./ThinkingControl";

export function PhoneThinkingChip() {
	const t = useT();
	const [open, setOpen] = useState(false);
	const selector = useThinkingSelector();
	const name = useThinkingName();
	const supported = useModelStore(s => s.availableThinkingLevels.length > 0);
	if (!supported) return null;
	return (
		<>
			<button
				{...keepFocus}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={`${t("input.runSettings.thinking")}: ${name}`}
				className="omp-status-chip"
				data-chip="thinking"
				data-compact=""
				onClick={() => setOpen(value => !value)}
				type="button"
			>
				<Brain aria-hidden />
				<span data-chip-badge="">{t(`input.thinking.short.${selector}`)}</span>
			</button>
			<ComposerSheet label={t("input.runSettings.thinking")} onClose={() => setOpen(false)} open={open}>
				<div className="px-1 pb-1">
					<ThinkingLevelField variant="segmented" />
				</div>
			</ComposerSheet>
		</>
	);
}

export function PhoneDelegationChip() {
	const t = useT();
	const [open, setOpen] = useState(false);
	const delegation = useDelegation(open);
	if (delegation.mode === null) return null;
	const name = t(`input.delegation.mode.${delegation.mode}`);
	const count = delegationCount(delegation.mode);
	return (
		<>
			<button
				{...keepFocus}
				aria-busy={delegation.pending || undefined}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={`${t("input.delegation.title")}: ${name}`}
				className="omp-status-chip"
				data-chip="delegation"
				data-compact=""
				onClick={() => setOpen(value => !value)}
				type="button"
			>
				<Network aria-hidden />
				{count !== null && <span data-chip-badge="">{count}</span>}
			</button>
			<ComposerSheet label={t("input.delegation.title")} onClose={() => setOpen(false)} open={open}>
				<div className="px-1 pb-1">
					<DelegationField mode={delegation.mode} onPick={next => void delegation.pick(next)} />
				</div>
			</ComposerSheet>
		</>
	);
}
