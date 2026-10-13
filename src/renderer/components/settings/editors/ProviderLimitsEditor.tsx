/**
 * Dedicated editor for providers.maxInFlightRequests (TUI
 * ProviderLimitsSubmenu parity): one row per provider id with a concurrency
 * cap, plus a provider dropdown (fed by get_providers through
 * ModelValueSelect) to add rows. Clearing a row's field or clicking remove
 * makes that provider unlimited; picking a provider from the dropdown adds it
 * capped at 1. Commits the whole record on every change (the parent writes via
 * setSetting); stock's `validateProviderMaxInFlightRequests` normalizer floors
 * every write to a whole number ≥ 1, and the row shows the value read back.
 */

import { X } from "lucide-react";
import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { toast } from "../../../stores/toast";
import { IconButton, Input } from "../../common";
import { ModelValueSelect } from "../ModelValueSelect";

export interface ProviderLimitsEditorProps {
	value: Record<string, unknown>;
	onCommit: (value: Record<string, unknown>) => void;
	disabled?: boolean;
}

function LimitInput({
	limit,
	disabled,
	onCommit,
}: {
	limit: number;
	disabled?: boolean;
	/** null removes the row (provider becomes unlimited). */
	onCommit: (limit: number | null) => void;
}) {
	const t = useT();
	const [draft, setDraft] = useState<string | null>(null);

	const commit = () => {
		if (draft === null) return;
		const trimmed = draft.trim();
		setDraft(null);
		if (trimmed === "") {
			onCommit(null);
			return;
		}
		const num = Number(trimmed);
		if (!Number.isFinite(num) || num <= 0) {
			toast({ variant: "warning", message: t("settings.editors.errPositive") });
			return;
		}
		if (num !== limit) onCommit(num);
	};

	return (
		<div className="w-20 shrink-0">
			<Input
				className="text-right tabular-nums"
				controlSize="sm"
				disabled={disabled}
				inputMode="numeric"
				onBlur={commit}
				onChange={event => setDraft(event.target.value)}
				onKeyDown={event => {
					if (isImeKeyEvent(event)) return;
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") {
						setDraft(null);
						event.currentTarget.blur();
					}
				}}
				placeholder={t("settings.editors.limitUnlimited")}
				spellCheck={false}
				value={draft ?? String(limit)}
			/>
		</div>
	);
}

export function ProviderLimitsEditor({ value, onCommit, disabled }: ProviderLimitsEditorProps) {
	const t = useT();
	// Only finite numbers render as rows; stock normalizes whatever the next commit writes.
	const entries = Object.entries(value)
		.filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
		.sort(([a], [b]) => a.localeCompare(b));

	const setLimit = (provider: string, limit: number | null) => {
		const next: Record<string, unknown> = Object.fromEntries(entries);
		if (limit === null) {
			delete next[provider];
		} else {
			next[provider] = limit;
		}
		onCommit(next);
	};

	return (
		<div className="flex w-full flex-col gap-1">
			{entries.map(([provider, limit]) => (
				<div className="flex items-center gap-2" key={provider}>
					<span className="min-w-0 flex-1 truncate font-mono text-sc-sm text-(--sc-text)" title={provider}>
						{provider}
					</span>
					<LimitInput disabled={disabled} limit={limit} onCommit={next => setLimit(provider, next)} />
					{!disabled && (
						<IconButton
							className="shrink-0"
							icon={<X />}
							label={t("settings.editors.kvRemove")}
							onClick={() => setLimit(provider, null)}
							size="sm"
						/>
					)}
				</div>
			))}
			{!disabled && (
				<ModelValueSelect
					disabled={disabled}
					kind="provider"
					onCommit={provider => {
						if (provider !== "") setLimit(provider, 1);
					}}
					placeholder={t("settings.editors.limitAdd")}
					value=""
				/>
			)}
		</div>
	);
}
