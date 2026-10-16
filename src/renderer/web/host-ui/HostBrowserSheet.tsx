import { ArrowUp, File, Folder, Home, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { WEB_HOST_LIST_MAX_ENTRIES, type WebHostListing } from "../../../shared/web-host";
import { Button } from "../../components/common/Button";
import { IconButton } from "../../components/common/IconButton";
import { Input, SearchField } from "../../components/common/Input";
import { ListRow } from "../../components/common/ListRow";
import { Sheet } from "../../components/common/Sheet";
import { Spinner } from "../../components/common/Spinner";
import { basename, formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { FileFilter, HostActions } from "../host-hooks";
import { hostActionError } from "./errors";

/** Debounce of the name filter: a keystroke is not a request. */
const FILTER_DELAY_MS = 200;

export type BrowserMode = "folder" | "file" | "save";

export interface HostBrowserProps {
	mode: BrowserMode;
	title?: string;
	/** Where it opens (a folder; for `save` the file the caller proposed). Empty = the computer's home. */
	defaultPath?: string;
	filters?: FileFilter[];
	host: HostActions;
	/** The chosen host paths, or null when the person closed the sheet. */
	onDone: (paths: string[] | null) => void;
}

function parentOf(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut > 0 ? path.slice(0, cut) : path.slice(0, cut + 1);
}

function joinPath(dir: string, name: string): string {
	return dir.endsWith("/") || dir.endsWith("\\")
		? `${dir}${name}`
		: `${dir}${dir.includes("\\") && !dir.includes("/") ? "\\" : "/"}${name}`;
}

function matchesFilters(name: string, filters: FileFilter[] | undefined): boolean {
	const extensions = (filters ?? []).flatMap(filter => filter.extensions).filter(extension => extension !== "*");
	if (extensions.length === 0) return true;
	const lower = name.toLowerCase();
	return extensions.some(extension => lower.endsWith(`.${extension.toLowerCase().replace(/^\./, "")}`));
}

/**
 * The computer's folder and file browser, in place of the native dialogs a desktop shows (design §2.4):
 * starts at the home folder (or where the caller points), one level at a time over `web:host.listDirs`, a name
 * filter, a typed path, the parent and home buttons. `folder` chooses the open folder, `file` a file, `save` a
 * folder plus a file name (the answer is the full path). A file mode also offers files from this device.
 */
export function HostBrowserSheet({ mode, title, defaultPath, filters, host, onDone }: HostBrowserProps) {
	const t = useT();
	const startDir = mode === "save" && defaultPath ? parentOf(defaultPath) : defaultPath;
	const [dir, setDir] = useState<string | undefined>(startDir || undefined);
	const [typed, setTyped] = useState(startDir ?? "");
	const [query, setQuery] = useState("");
	const [debounced, setDebounced] = useState("");
	const [listing, setListing] = useState<WebHostListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [fileName, setFileName] = useState(defaultPath ? basename(defaultPath) : "");

	useEffect(() => {
		const timer = setTimeout(() => setDebounced(query), FILTER_DELAY_MS);
		return () => clearTimeout(timer);
	}, [query]);

	useEffect(() => {
		let current = true;
		setLoading(true);
		host
			.listDirs({ path: dir, query: debounced || undefined, files: mode !== "folder" })
			.then(next => {
				if (!current) return;
				setListing(next);
				setTyped(next.path);
				setError(null);
			})
			.catch((cause: unknown) => {
				if (current) setError(hostActionError(cause));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [host, dir, debounced, mode]);

	const goTo = (next: string | undefined) => {
		setQuery("");
		setDebounced("");
		setDir(next);
	};

	const entries = (listing?.entries ?? []).filter(entry => entry.directory || matchesFilters(entry.name, filters));
	const heading =
		title ??
		t(
			mode === "folder"
				? "hostUi.browser.folderTitle"
				: mode === "file"
					? "hostUi.browser.fileTitle"
					: "hostUi.browser.saveTitle",
		);
	const canSave = mode === "save" && listing !== null && fileName.trim() !== "";

	const footer =
		mode === "folder" ? (
			<Button disabled={!listing} onClick={() => listing && onDone([listing.path])} variant="primary">
				{t("hostUi.browser.chooseFolder")}
			</Button>
		) : mode === "save" ? (
			<Button
				disabled={!canSave}
				onClick={() => listing && onDone([joinPath(listing.path, fileName.trim())])}
				variant="primary"
			>
				{t("hostUi.browser.saveHere")}
			</Button>
		) : (
			<Button
				icon={<Smartphone />}
				onClick={() => {
					void host.pickPhoneFiles(filters).then(paths => {
						if (paths) onDone(paths);
					});
				}}
			>
				{t("hostUi.browser.fromPhone")}
			</Button>
		);

	return (
		<Sheet footer={footer} onClose={() => onDone(null)} open placement="full" title={heading}>
			<div className="flex min-h-0 flex-col gap-3" data-host-sheet="browse" data-host-browser-mode={mode}>
				<form
					className="flex items-end gap-2"
					onSubmit={event => {
						event.preventDefault();
						goTo(typed.trim() || undefined);
					}}
				>
					<IconButton
						disabled={!listing?.parent}
						icon={<ArrowUp />}
						label={t("hostUi.browser.up")}
						onClick={() => listing?.parent && goTo(listing.parent)}
					/>
					<IconButton icon={<Home />} label={t("hostUi.browser.home")} onClick={() => goTo(listing?.home)} />
					<Input
						aria-label={t("hostUi.browser.pathLabel")}
						className="min-w-0 flex-1"
						mono
						onChange={event => setTyped(event.target.value)}
						value={typed}
					/>
					<Button type="submit">{t("hostUi.browser.go")}</Button>
				</form>
				<SearchField
					label={t("hostUi.browser.filter")}
					onValueChange={setQuery}
					placeholder={t("hostUi.browser.filter")}
					value={query}
				/>
				{mode === "save" && (
					<Input
						label={t("hostUi.browser.fileName")}
						onChange={event => setFileName(event.target.value)}
						value={fileName}
					/>
				)}
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" data-host-sheet-error="" role="alert">
						{t("hostUi.browser.error", { error })}
					</p>
				)}
				<div aria-busy={loading} className="flex flex-col" data-host-entries="">
					{loading && !listing && (
						<div className="flex items-center gap-2 py-4 text-sc-sm text-(--sc-text-muted)">
							<Spinner size="sm" /> {t("hostUi.browser.loading")}
						</div>
					)}
					{entries.map(entry => (
						<ListRow
							key={entry.path}
							leading={entry.directory ? <Folder /> : <File />}
							meta={entry.directory || entry.size === null ? undefined : formatBytes(entry.size)}
							onClick={() => {
								if (entry.directory) goTo(entry.path);
								else if (mode === "file") onDone([entry.path]);
								else if (mode === "save") setFileName(entry.name);
							}}
							rowProps={{ "data-host-entry": entry.directory ? "folder" : "file" }}
							selected={mode === "save" && !entry.directory && entry.name === fileName}
							title={entry.name}
							titleText={entry.path}
						/>
					))}
					{!loading && !error && entries.length === 0 && (
						<p className="py-4 text-sc-sm text-(--sc-text-muted)">{t("hostUi.browser.empty")}</p>
					)}
					{listing?.truncated && (
						<p className="py-2 text-sc-xs text-(--sc-text-muted)">
							{t("hostUi.browser.truncated", { count: WEB_HOST_LIST_MAX_ENTRIES })}
						</p>
					)}
				</div>
			</div>
		</Sheet>
	);
}
