/**
 * Settings › Models & providers: how omp spreads a provider's sessions over
 * its signed-in accounts (prefs `accountRotation`, src/shared/account-rotation.ts).
 * Two choices in one segmented radio group with a line on the chosen one:
 * quota-based (stock omp, default) or even (new sessions take the accounts in
 * turn). Self-contained: it loads, saves and reports its own errors.
 *
 * The pref belongs to the machine whose omp runs the sessions: with `device`
 * (the focused tab's paired host) it reads and writes that host's own pref
 * (`host.accountRotation.*`), and says so. It is shown whatever the account
 * count — a pool can grow at any login — with a hint that it only matters
 * from two accounts on. Even is disabled when that machine's omp lacks the
 * gui-bridge `accountRotation` feature.
 */

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ACCOUNT_ROTATION_MODES, type AccountRotationMode } from "../../../../shared/account-rotation";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useHostView } from "../../../stores/remote";
import { toastError } from "../../../stores/toast";
import { Spinner } from "../../common";

const LABEL_KEY: Record<AccountRotationMode, string> = {
	quota: "providers.rotation.quota",
	even: "providers.rotation.even",
};

const DESCRIPTION_KEY: Record<AccountRotationMode, string> = {
	quota: "providers.rotation.quotaDesc",
	even: "providers.rotation.evenDesc",
};

export function RotationModeControl({ device }: { device?: string }) {
	const t = useT();
	const labelId = useId();
	const groupRef = useRef<HTMLDivElement>(null);
	const hostName = useHostView(device)?.name;
	const [mode, setMode] = useState<AccountRotationMode | null>(null);
	const [evenSupported, setEvenSupported] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	/** Bumped per device and per save, so a late answer for another machine or an older choice is dropped. */
	const request = useRef(0);

	useEffect(() => {
		const version = ++request.current;
		setMode(null);
		setEvenSupported(null);
		setSaving(false);
		window.omp.accountRotation
			.get(device)
			.then(state => {
				if (version !== request.current) return;
				setMode(state.mode);
				setEvenSupported(state.evenSupported);
			})
			.catch((error: unknown) => {
				if (version !== request.current) return;
				// Stock behaviour is what runs when nothing could be read.
				setMode("quota");
				toastError({ title: t("providers.rotation.loadFailed"), error });
			});
	}, [device, t]);

	const available = (option: AccountRotationMode) => option !== "even" || evenSupported !== false;

	const choose = (next: AccountRotationMode) => {
		if (!mode || next === mode || saving || !available(next)) return;
		const version = ++request.current;
		const previous = mode;
		setMode(next);
		setSaving(true);
		window.omp.accountRotation
			.set(next, device)
			.then(state => {
				if (version !== request.current) return;
				setMode(state.mode);
				setEvenSupported(state.evenSupported);
			})
			.catch((error: unknown) => {
				if (version !== request.current) return;
				setMode(previous);
				toastError({ title: t("providers.rotation.saveFailed"), error });
			})
			.finally(() => {
				if (version === request.current) setSaving(false);
			});
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (delta === undefined || !mode) return;
		event.preventDefault();
		const options = ACCOUNT_ROTATION_MODES.filter(available);
		const next = options[(options.indexOf(mode) + delta + options.length) % options.length];
		if (!next) return;
		choose(next);
		groupRef.current?.querySelector<HTMLElement>(`[data-rotation-mode="${next}"]`)?.focus();
	};

	return (
		<div className="flex min-w-0 flex-col gap-1.5" data-account-rotation={mode ?? "loading"}>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<span className="text-sc-md font-medium text-(--sc-text)" id={labelId}>
					{t("providers.rotation.label")}
				</span>
				<div
					aria-busy={saving || mode === null}
					aria-labelledby={labelId}
					className="inline-flex items-center gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-3) p-0.5"
					onKeyDown={onKeyDown}
					ref={groupRef}
					role="radiogroup"
				>
					{ACCOUNT_ROTATION_MODES.map(option => {
						const selected = option === mode;
						return (
							<button
								aria-checked={selected}
								className={cx(
									"inline-flex h-(--sc-hit-min) shrink-0 items-center rounded-(--sc-radius-sm) px-2.5 text-sc-sm font-medium whitespace-nowrap transition-colors duration-(--sc-duration-fast) disabled:cursor-not-allowed disabled:opacity-50",
									selected
										? "bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-sm)"
										: "text-(--sc-text-muted) hover:text-(--sc-text)",
								)}
								data-rotation-mode={option}
								disabled={mode === null || !available(option)}
								key={option}
								onClick={() => choose(option)}
								role="radio"
								tabIndex={selected || (mode === null && option === "quota") ? 0 : -1}
								type="button"
							>
								{t(LABEL_KEY[option])}
							</button>
						);
					})}
				</div>
				{(saving || mode === null) && <Spinner size="sm" />}
			</div>
			{mode && <p className="text-sc-sm text-(--sc-text-secondary)">{t(DESCRIPTION_KEY[mode])}</p>}
			<p className="text-sc-xs text-(--sc-text-muted)">
				{t("providers.rotation.hint")}
				{device && ` ${t("providers.rotation.host", { name: hostName ?? t("remote.tab.unknownDevice") })}`}
			</p>
			{evenSupported === false && (
				<p className="text-sc-xs text-(--sc-warning)" data-rotation-unavailable="true">
					{t("providers.rotation.evenUnavailable")}
				</p>
			)}
		</div>
	);
}
