/**
 * Settings › Updates & about › Copy diagnostics: opens a preview of the redacted report main builds
 * (`window.omp.runtime.diagnostics()`: versions, machine setup, the last runtime-log lines, private
 * details hidden by `resources/gui-bridge/redactor.ts`) with a Copy button for the clipboard. The report is read
 * again every time the preview opens, so it holds what happened since. Nothing is uploaded. The download menu
 * beside Preview saves a diagnostic bundle of the focused tab (lib/diagnostic-bundle.ts): stock's `/dump` zip
 * plus this same text, anonymized with Option/Alt or its own item. Live log opens the Logs sheet (the app's log as it
 * is written, with search and a level filter).
 */
import { Check, ClipboardList, Copy, Download, ScrollText } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { saveFocusedDiagnosticBundle } from "../../lib/diagnostic-bundle";
import { copyText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, InlineNotice, MenuButton } from "../common";
import { SettingsRow } from "./SettingsLayout";

/** How long the Copy button says "Copied". */
const COPIED_MS = 1500;

type Report = { state: "loading" } | { state: "ready"; text: string } | { state: "failed"; cause: unknown };

export function DiagnosticsRow() {
	const t = useT();
	const previewId = useId();
	const [open, setOpen] = useState(false);
	const [report, setReport] = useState<Report>({ state: "loading" });
	const [copied, setCopied] = useState(false);
	// A newer read (a reopen, a Retry) wins over one still in flight.
	const latest = useRef(0);

	const load = useCallback(() => {
		const request = ++latest.current;
		setReport({ state: "loading" });
		window.omp.runtime
			.diagnostics()
			.then(text => {
				if (request === latest.current) setReport({ state: "ready", text });
			})
			.catch((cause: unknown) => {
				if (request === latest.current) setReport({ state: "failed", cause });
			});
	}, []);

	useEffect(() => {
		if (open) load();
		return () => {
			latest.current++;
		};
	}, [open, load]);

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
		return () => window.clearTimeout(timer);
	}, [copied]);

	const copy = (text: string) => {
		void copyText(text).then(ok => {
			if (ok) setCopied(true);
			else toast({ variant: "error", message: t("common.copyFailed") });
		});
	};

	return (
		<SettingsRow
			control={
				<div className="flex items-center justify-end gap-1.5">
					<Button
						aria-controls={previewId}
						aria-expanded={open}
						data-diagnostics-toggle
						onClick={() => {
							setCopied(false);
							setOpen(value => !value);
						}}
						size="sm"
						variant="secondary"
					>
						{open ? t("about.diagnosticsHide") : t("about.diagnosticsShow")}
					</Button>
					<MenuButton
						align="end"
						icon={<Download />}
						items={[
							{
								id: "save-bundle",
								label: t("diagnosticBundle.save"),
								icon: Download,
								onSelect: modifiers => void saveFocusedDiagnosticBundle(modifiers?.altKey === true),
							},
							{
								id: "save-bundle-anonymized",
								label: t("diagnosticBundle.saveAnonymized"),
								icon: Download,
								onSelect: () => void saveFocusedDiagnosticBundle(true),
							},
						]}
						label={t("diagnosticBundle.save")}
						size="sm"
						variant="secondary"
					/>
					<Button
						data-diagnostics-live-log
						icon={<ScrollText aria-hidden />}
						onClick={() => useUiStore.getState().openViewSheet("logs")}
						size="sm"
						variant="secondary"
					>
						{t("about.liveLog")}
					</Button>
				</div>
			}
			description={t("about.diagnosticsDesc")}
			tipOnly
			icon={<ClipboardList />}
			id="setting-about-diagnostics"
			label={t("about.diagnostics")}
		>
			{open && (
				<div className="mt-1 flex min-w-0 flex-col gap-2" data-diagnostics-preview id={previewId}>
					{report.state === "loading" && (
						<InlineNotice live title={t("about.diagnosticsLoading")} tone="pending" />
					)}
					{report.state === "failed" && (
						<InlineNotice
							action={
								<Button onClick={load} size="sm" variant="secondary">
									{t("common.retry")}
								</Button>
							}
							detail={report.cause}
							live
							title={t("about.diagnosticsFailed")}
							tone="danger"
						/>
					)}
					{report.state === "ready" && (
						<>
							<pre
								aria-label={t("about.diagnosticsPreviewLabel")}
								className="max-h-72 min-w-0 overflow-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-code-bg) px-2 py-1.5 font-mono text-sc-xs break-words whitespace-pre-wrap text-(--sc-text-secondary) select-text"
								data-diagnostics-text
								tabIndex={0}
							>
								{report.text}
							</pre>
							<div className="flex items-center justify-end gap-2">
								<Button
									data-copied={copied || undefined}
									data-diagnostics-copy
									icon={copied ? <Check /> : <Copy />}
									onClick={() => copy(report.text)}
									size="sm"
									variant="primary"
								>
									{copied ? t("about.diagnosticsCopied") : t("about.diagnosticsCopy")}
								</Button>
								<span aria-live="polite" className="sr-only" role="status">
									{copied ? t("common.copied") : ""}
								</span>
							</div>
						</>
					)}
				</div>
			)}
		</SettingsRow>
	);
}
