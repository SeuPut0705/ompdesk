/**
 * Remote folder picker: browses a paired host's directories one level at a
 * time through `remote.listDirs` (the native dialog only sees this device's
 * disk). Starts at the host's home, walks down by clicking a folder and up
 * with the parent button, and picks the folder being shown.
 *
 * `RemoteFolderPickerHost` (mounted once in App) serves the imperative
 * `pickRemoteDirectory(deviceId)` that every "choose a folder" flow uses for
 * a remote tab.
 */
import { CornerLeftUp, Folder, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteDirListing } from "../../../shared/ipc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { settleRemoteDirectory, useHostView, useRemotePickerStore } from "../../stores/remote";
import { Button, ErrorDetail, IconButton, ListRow, Modal, Spinner } from "../common";

export function RemoteFolderPickerHost() {
	const t = useT();
	const request = useRemotePickerStore(state => state.request);
	// The closing panel keeps its device while it animates out.
	const lastDevice = useRef("");
	if (request) lastDevice.current = request.deviceId;
	const host = useHostView(lastDevice.current);
	return (
		<RemoteFolderPicker
			deviceId={lastDevice.current}
			deviceName={host?.name ?? t("remote.tab.unknownDevice")}
			onClose={() => settleRemoteDirectory(undefined)}
			onPick={path => settleRemoteDirectory(path)}
			open={request !== null}
		/>
	);
}

export interface RemoteFolderPickerProps {
	open: boolean;
	deviceId: string;
	deviceName: string;
	onClose: () => void;
	onPick: (path: string) => void;
}

export function RemoteFolderPicker({ open, deviceId, deviceName, onClose, onPick }: RemoteFolderPickerProps) {
	const t = useT();
	const [listing, setListing] = useState<RemoteDirListing | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<InlineFailure | null>(null);
	/** Only the latest navigation may land; a slow parent read must not replace its child. */
	const request = useRef(0);

	const load = useCallback(
		async (path?: string) => {
			const version = ++request.current;
			setLoading(true);
			setError(null);
			try {
				const next = await (path === undefined
					? window.omp.remote.listDirs(deviceId)
					: window.omp.remote.listDirs(deviceId, path));
				if (version === request.current) setListing(next);
			} catch (cause) {
				if (version === request.current) setError(inlineFailure(cause, t("remote.picker.loadFailed")));
			} finally {
				if (version === request.current) setLoading(false);
			}
		},
		[deviceId, t],
	);

	useEffect(() => {
		if (!open) return;
		setListing(null);
		void load();
		return () => {
			request.current++;
		};
	}, [open, load]);

	const parent = listing?.parent ?? null;
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						data-remote-picker-open
						disabled={!listing || loading}
						onClick={() => {
							if (listing) onPick(listing.path);
						}}
						variant="primary"
					>
						{t("remote.picker.open")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			title={t("remote.picker.title", { name: deviceName })}
		>
			<div className="flex flex-col gap-2">
				<div className="flex min-w-0 items-center gap-1">
					<IconButton
						data-remote-picker-up
						disabled={parent === null || loading}
						icon={<CornerLeftUp />}
						label={t("remote.picker.up")}
						onClick={() => {
							if (parent !== null) void load(parent);
						}}
						size="sm"
					/>
					<span
						className="min-w-0 flex-1 truncate font-mono text-sc-sm text-(--sc-text-secondary) select-all"
						data-remote-picker-path
						title={listing?.path}
					>
						{listing?.path ?? ""}
					</span>
					{loading && listing && <Spinner size="sm" />}
				</div>
				{error && (
					<div className="flex items-start justify-between gap-2" role="alert">
						<p className="min-w-0 text-sc-sm break-words text-(--sc-danger)">
							{error.message}
							<ErrorDetail className="mt-0.5" error={error.cause} />
						</p>
						<Button icon={<RefreshCw />} onClick={() => void load(listing?.path)} size="sm" variant="secondary">
							{t("common.retry")}
						</Button>
					</div>
				)}
				<div
					aria-busy={loading}
					aria-label={t("remote.picker.list")}
					className="h-72 overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-1"
					role="group"
				>
					{!listing && loading ? (
						<div className="flex h-full items-center justify-center">
							<Spinner />
						</div>
					) : listing && listing.entries.length === 0 ? (
						<p className="px-2.5 py-2 text-sc-sm text-(--sc-text-muted)">{t("remote.picker.empty")}</p>
					) : (
						listing?.entries.map(entry => (
							<ListRow
								buttonProps={{ "data-remote-dir": entry.path }}
								disabled={loading}
								key={entry.path}
								leading={<Folder aria-hidden />}
								onClick={() => void load(entry.path)}
								title={entry.name}
								titleText={entry.path}
							/>
						))
					)}
				</div>
			</div>
		</Modal>
	);
}
