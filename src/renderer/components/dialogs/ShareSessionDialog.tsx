import { AlertTriangle, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcShareSessionPreview, RpcShareSessionResult } from "../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Button, CopyButton, InlineNotice, Modal, Spinner } from "../common";

export function ShareSessionDialog() {
	const t = useT();
	const rpc = useTabRpc();
	const generation = useRef(0);
	const [preview, setPreview] = useState<RpcShareSessionPreview | null>(null);
	const [uploading, setUploading] = useState(false);
	const open = useUiStore(state => state.shareSessionOpen);
	const close = useUiStore(state => state.closeShareSession);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const [result, setResult] = useState<RpcShareSessionResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<InlineFailure | null>(null);

	const prepare = useCallback(async () => {
		if (!sidecarReady) {
			setError({ message: t("sidecar.notResponding") });
			return;
		}
		const version = ++generation.current;
		setPreview(null);
		setUploading(false);
		setResult(null);
		setError(null);
		setLoading(true);
		try {
			const response = await rpc.previewShareSession();
			if (version !== generation.current) return;
			if (!response.success) {
				setError(inlineFailure(response, t("shareDialog.previewFailed")));
				return;
			}
			setPreview(response.data as RpcShareSessionPreview);
		} catch (cause) {
			if (version === generation.current) setError(inlineFailure(cause, t("shareDialog.previewFailed")));
		} finally {
			if (version === generation.current) setLoading(false);
		}
	}, [rpc, sidecarReady, t]);

	useEffect(() => {
		if (open) void prepare();
		return () => {
			generation.current++;
		};
	}, [open, prepare]);

	const upload = async () => {
		if (!sidecarReady || !preview || uploading) return;
		const version = generation.current;
		setUploading(true);
		setError(null);
		try {
			const response = await rpc.shareSession(preview.snapshotId);
			if (version !== generation.current) return;
			if (!response.success) {
				setError(inlineFailure(response, t("shareDialog.error")));
				return;
			}
			setResult(response.data as RpcShareSessionResult);
			setPreview(null);
		} catch (cause) {
			if (version === generation.current) setError(inlineFailure(cause, t("shareDialog.error")));
		} finally {
			if (version === generation.current) setUploading(false);
		}
	};

	return (
		<Modal
			onClose={uploading ? () => {} : close}
			open={open}
			size="md"
			title={t("shareDialog.title")}
			footer={
				!loading && !result && preview ? (
					<>
						<Button
							variant="secondary"
							disabled={uploading || !sidecarReady}
							onClick={() => void prepare()}
							title={!sidecarReady ? t("sidecar.notResponding") : undefined}
						>
							{t("shareDialog.refreshPreview")}
						</Button>
						<Button
							loading={uploading}
							disabled={uploading || !sidecarReady}
							onClick={() => void upload()}
							title={!sidecarReady ? t("sidecar.notResponding") : undefined}
							variant="primary"
						>
							{t("shareDialog.upload")}
						</Button>
					</>
				) : undefined
			}
		>
			{loading ? (
				<Spinner className="w-full justify-center py-8" label={t("shareDialog.preparing")} size="sm" />
			) : result ? (
				<div className="space-y-3">
					<div>
						<div className="mb-1 text-sc-xs font-medium text-(--sc-text-muted)">{t("shareDialog.url")}</div>
						<div className="flex flex-wrap items-end gap-2">
							<code className="min-w-0 flex-1 basis-48 rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-3 py-2 text-sc-sm break-all text-(--sc-text)">
								{result.url}
							</code>
							<CopyButton label={t("shareDialog.copy")} text={result.url} variant="secondary" />
							<Button
								aria-label={t("shareDialog.open")}
								onClick={() => openExternal(result.url)}
								size="sm"
								title={t("shareDialog.open")}
								variant="secondary"
							>
								<ExternalLink aria-hidden className="size-(--sc-icon-sm)" />
							</Button>
						</div>
					</div>
					{result.truncated ? (
						<div className="flex items-start gap-2 rounded-(--sc-radius-md) border border-(--sc-warning) p-3 text-sc-sm text-(--sc-warning)">
							<AlertTriangle aria-hidden className="mt-px size-(--sc-icon-md) shrink-0" />
							{t("shareDialog.truncated")}
						</div>
					) : null}
				</div>
			) : preview ? (
				<div className="space-y-3">
					<p className="text-sc-md text-(--sc-text-secondary)">{t("shareDialog.previewHint")}</p>
					<p className="break-all text-sc-xs text-(--sc-text-muted)">
						{t("shareDialog.destination")}: {preview.store === "gist" ? t("shareDialog.gistDestination") : ""}
						{preview.serverUrl}
					</p>
					<p className="text-sc-xs text-(--sc-text-muted)">
						{t(preview.redactionEnabled ? "shareDialog.redactionOn" : "shareDialog.redactionOff")}
					</p>
					{preview.truncated && (
						<p role="status" className="text-sc-sm text-(--sc-warning)">
							{t("shareDialog.previewTrimmed")}
						</p>
					)}
					<pre
						tabIndex={0}
						aria-label={t("shareDialog.preview")}
						className="max-h-[40vh] overflow-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-3 text-sc-sm whitespace-pre-wrap break-words"
					>
						{preview.preview}
					</pre>
				</div>
			) : null}
			{error && (
				<InlineNotice
					action={
						<Button
							variant="secondary"
							disabled={uploading || !sidecarReady}
							onClick={() => void prepare()}
							size="sm"
							title={!sidecarReady ? t("sidecar.notResponding") : undefined}
						>
							{t("shareDialog.refreshPreview")}
						</Button>
					}
					className="py-3"
					detail={error.cause}
					live
					title={error.message}
					tone="danger"
				/>
			)}
		</Modal>
	);
}
