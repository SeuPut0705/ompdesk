import { ExternalLink, FileX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcShareSessionPreview, RpcShareSessionResult } from "../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Button, Card, CopyButton, EmptyState, FieldLabel, InlineNotice, Modal, PathText, Spinner } from "../common";

/** A snapshot with no entries (`{"entries":[]}`): a session with nothing in it yet. */
function isEmptySnapshot(text: string): boolean {
	if (text.trim() === "") return true;
	try {
		const data: unknown = JSON.parse(text);
		return (
			typeof data === "object" &&
			data !== null &&
			"entries" in data &&
			Array.isArray(data.entries) &&
			data.entries.length === 0
		);
	} catch {
		return false;
	}
}

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
	const empty = preview !== null && isEmptySnapshot(preview.preview);

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
							disabledReason={!sidecarReady ? t("sidecar.notResponding") : undefined}
						>
							{t("shareDialog.refreshPreview")}
						</Button>
						{empty ? null : (
							<Button
								loading={uploading}
								disabled={uploading || !sidecarReady}
								onClick={() => void upload()}
								disabledReason={!sidecarReady ? t("sidecar.notResponding") : undefined}
								variant="primary"
							>
								{t("shareDialog.upload")}
							</Button>
						)}
					</>
				) : undefined
			}
		>
			{loading ? (
				<Spinner className="w-full justify-center py-8" label={t("shareDialog.preparing")} size="sm" />
			) : result ? (
				<div className="space-y-3">
					<div>
						<FieldLabel as="span">{t("shareDialog.url")}</FieldLabel>
						<div className="flex flex-wrap items-end gap-2">
							<Card className="min-w-0 flex-1 basis-48" padding="sm">
								<code className="text-sc-sm break-all text-(--sc-text)">{result.url}</code>
							</Card>
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
					{result.truncated ? <InlineNotice title={t("shareDialog.truncated")} tone="warning" /> : null}
				</div>
			) : preview ? (
				empty ? (
					<div role="status">
						<EmptyState icon={<FileX />} size="sm" title={t("shareDialog.empty")} />
					</div>
				) : (
					<div className="space-y-3">
						<p className="text-sc-sm text-(--sc-text-muted)">
							{t(preview.redactionEnabled ? "shareDialog.noteRedacted" : "shareDialog.noteUnredacted")}
						</p>
						{/* Where the transcript goes, read before anything is uploaded. */}
						<p
							className="flex min-w-0 items-baseline gap-1 text-sc-sm text-(--sc-text-muted)"
							data-share-destination
						>
							<span>
								{t("shareDialog.destination")}:{" "}
								{preview.store === "gist" ? t("shareDialog.gistDestination").trimEnd() : null}
							</span>
							<PathText path={preview.serverUrl} />
						</p>
						{preview.truncated && (
							<p role="status" className="text-sc-sm text-(--sc-warning)">
								{t("shareDialog.previewTrimmed")}
							</p>
						)}
						<Card
							tabIndex={0}
							role="region"
							aria-label={t("shareDialog.preview")}
							className="max-h-[40vh] overflow-auto"
						>
							<pre className="text-sc-sm whitespace-pre-wrap break-words">{preview.preview}</pre>
						</Card>
					</div>
				)
			) : null}
			{error && (
				<InlineNotice
					action={
						<Button
							variant="secondary"
							disabled={uploading || !sidecarReady}
							onClick={() => void prepare()}
							size="sm"
							disabledReason={!sidecarReady ? t("sidecar.notResponding") : undefined}
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
