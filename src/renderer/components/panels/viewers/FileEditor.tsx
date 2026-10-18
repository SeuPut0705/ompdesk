/**
 * The Files viewer's Edit (C2): the whole text file in a CodeMirror field,
 * saved through the confined `fs.mutate` write (also on a paired host's tab).
 * A save carries the modification time the editor loaded, so a file that
 * changed on disk meanwhile is never overwritten silently: the editor offers
 * to save anyway or to load the disk version. Files over main's 2 MB text cap
 * or that aren't text stay read-only.
 */
import { Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FS_WRITE_MAX_BYTES } from "../../../../shared/ipc-types";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";
import { toastError } from "../../../stores/toast";
import { Banner, Button, InlineNotice, TextEditor, type TextEditorLanguage } from "../../common";
import type { ViewerKind } from "./file-kind";
import { ViewerLoading } from "./viewer-chrome";

/** Viewer kinds whose file is plain text the editor can hold. */
export const EDITABLE_KINDS: Partial<Record<ViewerKind, true>> = {
	markdown: true,
	code: true,
	json: true,
	html: true,
	mermaid: true,
	csv: true,
};

type EditorState =
	| { status: "loading" }
	| { status: "error"; failure: InlineFailure }
	| { status: "readOnly"; reason: "tooLarge" | "binary" }
	| { status: "ready"; saved: string; mtimeMs: number };

export function FileEditor({
	path,
	tabId,
	kind,
	diskRevision,
	onSaved,
	onDirtyChange,
}: {
	path: string;
	tabId: string | undefined;
	kind: ViewerKind;
	/** Bumped by the panel's disk watch when the file changed outside this editor. */
	diskRevision: number;
	/** The new modification time and byte size after a save: the disk watch must not take the write for an outside change, and the header's size follows it. */
	onSaved: (mtimeMs: number, size: number) => void;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const t = useT();
	const [state, setState] = useState<EditorState>({ status: "loading" });
	const [draft, setDraft] = useState("");
	/** Remounts the CodeMirror field with a freshly loaded document. */
	const [generation, setGeneration] = useState(0);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState(false);
	const name = path.split("/").pop() ?? path;
	const dirty = state.status === "ready" && draft !== state.saved;
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;

	useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

	const load = useCallback(async () => {
		setConflict(false);
		try {
			// The time first: a change between the two reads then shows as a conflict, never as a lost edit.
			const stat = await window.omp.fs.stat(path, tabId);
			if (!stat.ok) {
				setState({ status: "error", failure: inlineFailure(stat, t("filesPanel.readFailed")) });
				return;
			}
			const read = await window.omp.fs.read(path, FS_WRITE_MAX_BYTES, tabId);
			if (!read.ok) setState({ status: "error", failure: inlineFailure(read, t("filesPanel.readFailed")) });
			else if (read.binary) setState({ status: "readOnly", reason: "binary" });
			else if (read.truncated) setState({ status: "readOnly", reason: "tooLarge" });
			else {
				setState({ status: "ready", saved: read.content, mtimeMs: stat.mtimeMs });
				setDraft(read.content);
				setGeneration(value => value + 1);
			}
		} catch (cause) {
			setState({ status: "error", failure: inlineFailure(cause, t("filesPanel.readFailed")) });
		}
	}, [path, tabId, t]);

	useEffect(() => {
		void load();
	}, [load]);

	// An outside change: a clean editor follows it; unsaved edits are kept and the conflict is shown.
	const seenRevision = useRef(diskRevision);
	useEffect(() => {
		if (diskRevision === seenRevision.current) return;
		seenRevision.current = diskRevision;
		if (dirtyRef.current) setConflict(true);
		else void load();
	}, [diskRevision, load]);

	const save = async (force = false) => {
		if (state.status !== "ready" || saving || (!dirty && !force)) return;
		setSaving(true);
		try {
			const result = await window.omp.fs.mutate(
				{ op: "write", path, content: draft, expectedMtimeMs: state.mtimeMs, ...(force ? { force: true } : {}) },
				tabId,
			);
			if (result.ok && typeof result.mtimeMs === "number") {
				setState({ status: "ready", saved: draft, mtimeMs: result.mtimeMs });
				setConflict(false);
				onSaved(result.mtimeMs, new TextEncoder().encode(draft).byteLength);
			} else if (result.code === "changed_on_disk") setConflict(true);
			else toastError({ title: t("fileViewer.saveFailed"), error: result });
		} catch (cause) {
			toastError({ title: t("fileViewer.saveFailed"), error: cause });
		} finally {
			setSaving(false);
		}
	};

	if (state.status === "loading") {
		return <ViewerLoading />;
	}
	if (state.status === "error") {
		return (
			<div className="p-3">
				<InlineNotice detail={state.failure.cause} live title={state.failure.message} tone="danger" />
			</div>
		);
	}
	if (state.status === "readOnly") {
		return (
			<div className="p-3">
				<Banner live variant="warning">
					{t(state.reason === "binary" ? "fileViewer.editBinary" : "fileViewer.editTooLarge")}
				</Banner>
			</div>
		);
	}
	const language: TextEditorLanguage = kind === "markdown" ? "markdown" : kind === "json" ? "json" : "text";
	return (
		<div className="flex h-full min-h-0 flex-col" data-file-editor>
			<div className="flex shrink-0 items-center gap-2 border-b border-(--sc-divider) px-3 py-1.5">
				<span aria-live="polite" className="me-auto text-sc-xs text-(--sc-text-muted)" data-editor-status>
					{saving ? t("common.saving") : dirty ? t("common.unsaved") : t("common.saved")}
				</span>
				<Button
					disabled={!dirty || saving}
					icon={<Save />}
					loading={saving}
					onClick={() => void save()}
					size="sm"
					variant="primary"
				>
					{t("fileViewer.save")}
				</Button>
			</div>
			{conflict && (
				<div className="shrink-0 px-3 pt-2">
					<Banner
						actions={
							<>
								<Button disabled={saving} onClick={() => void save(true)} size="sm">
									{t("fileViewer.overwrite")}
								</Button>
								<Button disabled={saving} onClick={() => void load()} size="sm">
									{t("fileViewer.reloadDisk")}
								</Button>
							</>
						}
						live
						variant="warning"
					>
						{t("fileViewer.changedOnDisk")}
					</Banner>
				</div>
			)}
			<div className="min-h-0 flex-1 p-2">
				<TextEditor
					ariaLabel={t("fileViewer.editorLabel", { name })}
					autoFocus
					className="h-full"
					key={generation}
					language={language}
					lineNumbers
					onChange={setDraft}
					onSave={() => void save()}
					value={draft}
				/>
			</div>
		</div>
	);
}
