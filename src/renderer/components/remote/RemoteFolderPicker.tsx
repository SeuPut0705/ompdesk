/**
 * Remote folder picker: browses a paired host's directories one level at a
 * time through `remote.listDirs` (the native dialog only sees this device's
 * disk). Starts at the host's home, walks down by clicking a folder and up
 * with the parent button, and picks the folder being shown. The host lists a
 * bounded number of folders per level (`truncated` past it), so the name
 * filter asks the host again with the query: a folder past the bound in a
 * crowded directory (a temp folder with thousands of entries) stays reachable.
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
import { Button, IconButton, InlineNotice, ListRow, Modal, SearchField, SkeletonRows, Spinner } from "../common";

/** Typing pause before the host is asked for the filtered level. */
const FILTER_DELAY_MS = 150;

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
	const [filter, setFilter] = useState("");
	/** Only the latest navigation may land; a slow parent read must not replace its child. */
	const request = useRef(0);
	const filterTimer = useRef<number | undefined>(undefined);

	const load = useCallback(
		async (path?: string, query = "") => {
			const version = ++request.current;
			setLoading(true);
			setError(null);
			try {
				const next = await (query
					? window.omp.remote.listDirs(deviceId, path, query)
					: path === undefined
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
		setFilter("");
		void load();
		return () => {
			clearTimeout(filterTimer.current);
			request.current++;
		};
	}, [open, load]);

	/** Another folder: the filter belonged to the one being left. */
	const navigate = (path: string) => {
		clearTimeout(filterTimer.current);
		setFilter("");
		void load(path);
	};
	const changeFilter = (value: string) => {
		setFilter(value);
		clearTimeout(filterTimer.current);
		const at = listing?.path;
		if (at === undefined) return;
		filterTimer.current = window.setTimeout(() => void load(at, value.trim()), FILTER_DELAY_MS);
	};

	const parent = listing?.parent ?? null;
	const query = filter.trim();
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
							if (parent !== null) navigate(parent);
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
				<SearchField
					controlSize="sm"
					data-remote-picker-filter
					disabled={!listing}
					label={t("remote.picker.filter")}
					onValueChange={changeFilter}
					placeholder={t("remote.picker.filter")}
					spellCheck={false}
					value={filter}
				/>
				{error && (
					<InlineNotice
						action={
							<Button
								icon={<RefreshCw />}
								onClick={() => void load(listing?.path, query)}
								size="sm"
								variant="secondary"
							>
								{t("common.retry")}
							</Button>
						}
						detail={error.cause}
						live
						title={error.message}
						tone="danger"
					/>
				)}
				<div
					aria-busy={loading}
					aria-label={t("remote.picker.list")}
					className="h-72 overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-1"
					role="group"
				>
					{!listing && loading ? (
						<SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />
					) : listing && listing.entries.length === 0 ? (
						<p className="px-2.5 py-2 text-sc-sm text-(--sc-text-muted)">
							{query ? t("remote.picker.noMatch", { query }) : t("remote.picker.empty")}
						</p>
					) : (
						// A row stays clickable while a level loads: a click starts the latest
						// navigation, which outranks the read in flight (a filter typed a moment ago).
						listing?.entries.map(entry => (
							<ListRow
								buttonProps={{ "data-remote-dir": entry.path }}
								key={entry.path}
								leading={<Folder aria-hidden />}
								onClick={() => navigate(entry.path)}
								title={entry.name}
								titleText={entry.path}
							/>
						))
					)}
				</div>
				{listing?.truncated && (
					<p className="text-sc-sm text-(--sc-text-muted)" data-remote-picker-truncated>
						{t("remote.picker.truncated")}
					</p>
				)}
			</div>
		</Modal>
	);
}
