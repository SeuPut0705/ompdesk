/**
 * Feedback dialog: collects a bug/feature report and hands it to GitHub's
 * issue form (prefilled title/body/labels). Nothing is sent in-app — the user
 * reviews and posts on github.com, and diagnostics (environment, recent
 * runtime errors) are opt-in checkboxes with the exact text previewed.
 */

import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildIssueUrl, FEEDBACK_KINDS, type FeedbackKind, formatErrorTail } from "../../../shared/feedback";
import type { SystemInfo } from "../../../shared/ipc-types";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Button, Input, Modal, TextArea } from "../common";

const LOG_TAIL_LINES = 20;

export function FeedbackDialog() {
	const t = useT();
	const open = useUiStore(state => state.feedbackOpen);
	const prefill = useUiStore(state => state.feedbackPrefill);
	const close = useUiStore(state => state.closeFeedback);

	const [kind, setKind] = useState<FeedbackKind>("bug");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [includeEnv, setIncludeEnv] = useState(true);
	const [includeErrors, setIncludeErrors] = useState(true);
	const [info, setInfo] = useState<SystemInfo | null>(null);
	const [errorTail, setErrorTail] = useState<readonly string[]>([]);

	// Reload diagnostics and reset the draft every time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setTitle(prefill?.title ?? "");
		setDescription(prefill?.description ?? "");
		setKind("bug");
		setIncludeEnv(true);
		setIncludeErrors(true);
		setInfo(null);
		setErrorTail([]);
		window.omp.system
			.info()
			.then(setInfo)
			.catch(() => {});
		window.omp.runtime
			.logTail(LOG_TAIL_LINES)
			.then(setErrorTail)
			.catch(() => setErrorTail([]));
	}, [open, prefill]);

	const errorPreview = useMemo(() => formatErrorTail(errorTail), [errorTail]);
	const envLine = useMemo(
		() =>
			info
				? t("feedback.envLine", {
						version: info.appVersion,
						platform: info.platform,
						arch: info.arch,
						electron: info.electron,
					})
				: null,
		[info, t],
	);

	const canSubmit = description.trim().length > 0;
	const submit = useCallback(() => {
		if (!canSubmit) return;
		const url = buildIssueUrl({
			kind,
			title: title.trim() || description.trim().split("\n")[0].slice(0, 80),
			description,
			environment: includeEnv ? info : null,
			errors: includeErrors ? errorTail : [],
			prefillError: prefill?.error ?? null,
		});
		void window.omp.system.openExternal(url);
		close();
	}, [canSubmit, kind, title, description, includeEnv, includeErrors, info, errorTail, prefill, close]);

	return (
		<Modal onClose={close} open={open} size="lg" title={t("feedback.title")}>
			<div className="space-y-4">
				<p className="text-omp-sm leading-relaxed text-(--omp-muted)">{t("feedback.intro")}</p>

				<div>
					<span className="mb-1.5 block text-omp-md font-medium text-(--omp-text-secondary)">
						{t("feedback.kind")}
					</span>
					<div className="flex gap-1.5" role="group" aria-label={t("feedback.kind")}>
						{FEEDBACK_KINDS.map(value => (
							<button
								key={value}
								type="button"
								aria-pressed={kind === value}
								onClick={() => setKind(value)}
								className={`omp-pressable rounded-md px-3 py-1.5 text-omp-sm font-medium transition-colors ${
									kind === value
										? "bg-(--omp-btn-primary-bg) text-(--omp-btn-primary-text)"
										: "border border-(--omp-border-muted) text-(--omp-muted) hover:text-(--omp-text)"
								}`}
							>
								{t(`feedback.kind.${value}`)}
							</button>
						))}
					</div>
				</div>

				<Input
					label={t("feedback.summary")}
					placeholder={t("feedback.summaryPlaceholder")}
					value={title}
					onChange={event => setTitle(event.target.value)}
					maxLength={120}
				/>

				{prefill?.error && (
					<div>
						<span className="mb-1.5 block text-omp-md font-medium text-(--omp-text-secondary)">
							{t("feedback.capturedError")}
						</span>
						<pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-(--omp-border-muted) bg-(--omp-code-bg) p-2.5 font-mono text-omp-xs text-(--omp-error)">
							{prefill.error}
						</pre>
					</div>
				)}

				<TextArea
					label={t("feedback.description")}
					placeholder={t("feedback.descriptionPlaceholder")}
					value={description}
					onChange={event => setDescription(event.target.value)}
					rows={6}
					required
				/>

				<div className="space-y-2 rounded-lg border border-(--omp-border-muted) p-3">
					<label className="flex items-start gap-2.5 text-omp-sm text-(--omp-text)">
						<input
							type="checkbox"
							checked={includeEnv}
							onChange={event => setIncludeEnv(event.target.checked)}
							className="mt-0.5 accent-(--omp-accent)"
						/>
						<span>
							{t("feedback.includeEnv")}
							{includeEnv && envLine && (
								<span className="block font-mono text-omp-xs text-(--omp-dim)">{envLine}</span>
							)}
						</span>
					</label>
					<div>
						<label className="flex items-start gap-2.5 text-omp-sm text-(--omp-text)">
							<input
								type="checkbox"
								checked={includeErrors}
								onChange={event => setIncludeErrors(event.target.checked)}
								className="mt-0.5 accent-(--omp-accent)"
							/>
							<span>{t("feedback.includeErrors")}</span>
						</label>
						{/* Kept outside the label: clicking the preview to read/select text must not toggle the box. */}
						{includeErrors && (
							<details className="mt-1 ml-6">
								<summary className="cursor-pointer text-omp-xs text-(--omp-dim) hover:text-(--omp-muted)">
									{t("feedback.errorsPreview", { count: errorTail.length })}
								</summary>
								<pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-(--omp-code-bg) p-2 font-mono text-omp-xs text-(--omp-dim)">
									{errorPreview || t("feedback.errorsEmpty")}
								</pre>
							</details>
						)}
					</div>
				</div>

				<p className="text-omp-xs leading-relaxed text-(--omp-dim)">{t("feedback.note")}</p>

				<div className="flex justify-end gap-2 pt-1">
					<Button onClick={close} size="sm" variant="secondary">
						{t("feedback.cancel")}
					</Button>
					<Button
						disabled={!canSubmit}
						icon={<ExternalLink size={12} />}
						onClick={submit}
						size="sm"
						variant="primary"
					>
						{t("feedback.submit")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
