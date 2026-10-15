/**
 * Feedback on the shown preview page (C137–C139) and the agent's visual bar (C141):
 * the user picks elements or drags a region, writes a comment per numbered pin,
 * tweaks the page's CSS variables, and sends it all to the composer as one
 * message (region screenshots as images). Picking and pins run in main's
 * isolated page world (main/preview/page-scripts.ts); the page itself never
 * sees them.
 */
import {
	ArrowUpToLine,
	Crosshair,
	MousePointerClick,
	RotateCcw,
	Send,
	SlidersHorizontal,
	SquareDashed,
	X,
} from "lucide-react";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import type {
	PreviewCssVariable,
	PreviewElement,
	PreviewRequest,
	PreviewState,
	PreviewVisualRecord,
} from "../../../shared/preview";
import type { ImageContent } from "../../../shared/rpc-types";
import { formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { AsyncSection, Button, IconButton, Input, Modal, Select } from "../common";

export interface PreviewNote {
	n: number;
	kind: "element" | "region";
	/** The picked element, or the region's elements under it (C138's elements list). */
	elements: PreviewElement[];
	/** Region screenshot, PNG base64. */
	image?: string;
	comment: string;
}
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The composer message for `notes` and the CSS variables changed on `page` (`changed`: name → [from, to]). */
export function previewFeedbackMessage(
	t: Translate,
	page: { title: string; url: string },
	notes: readonly PreviewNote[],
	changed: Readonly<Record<string, [string, string]>>,
): { text: string; images: ImageContent[] } {
	const lines = [t("panel.preview.feedback.header", { title: page.title || page.url, url: page.url })];
	const images: ImageContent[] = [];
	for (const note of notes) {
		const comment = note.comment.trim() ? ` — ${note.comment.trim()}` : "";
		if (note.kind === "element") {
			const [element] = note.elements;
			const text = element?.text ? ` "${element.text}"` : "";
			lines.push(`${note.n}. <${element?.tag}> \`${element?.selector}\`${text}${comment}`);
		} else {
			if (note.image) images.push({ type: "image", data: note.image, mimeType: "image/png" });
			const shown = note.elements.map(element => `\`${element.selector}\``).join(", ");
			lines.push(
				`${note.n}. ${t("panel.preview.feedback.regionLine", { image: images.length, elements: shown || "—" })}${comment}`,
			);
		}
	}
	const variables = Object.entries(changed).filter(([, [from, to]]) => from !== to);
	if (variables.length > 0) {
		lines.push(t("panel.preview.feedback.variablesLine"));
		for (const [name, [from, to]] of variables) lines.push(`- ${name}: ${from || "∅"} → ${to}`);
	}
	return { text: lines.join("\n"), images };
}

const elementLabel = (element: PreviewElement | undefined) =>
	element ? `<${element.tag}>${element.text ? ` ${element.text}` : ""}` : "";

export interface PreviewFeedback {
	notes: PreviewNote[];
	setNotes: Dispatch<SetStateAction<PreviewNote[]>>;
	/** The picker waiting on the page, if any. */
	picking: "element" | "region" | null;
	/** The page's CSS variables while the editor is open (null = closed). */
	variables: PreviewCssVariable[] | null;
	/** Variables changed on this page: name → [value before, value now]. */
	changed: Record<string, [string, string]>;
	pick(kind: "element" | "region"): void;
	cancel(): void;
	openVariables(): void;
	closeVariables(): void;
	setVariable(name: string, value: string): void;
	resetVariables(): Promise<void>;
	/** Put the message into this tab's composer (ahead of a draft) and start over. */
	send(): void;
	discard(): void;
}

/** Feedback state for the shown page; it starts over whenever another page or address shows. */
export function usePreviewFeedback(state: PreviewState, tabId: string | null): PreviewFeedback {
	const t = useT();
	const [notes, setNotes] = useState<PreviewNote[]>([]);
	const [picking, setPicking] = useState<"element" | "region" | null>(null);
	const [variables, setVariables] = useState<PreviewCssVariable[] | null>(null);
	const [changed, setChanged] = useState<Record<string, [string, string]>>({});
	const next = useRef(1);
	const pageKey = `${state.activeTab}\n${state.url}`;
	const shownKey = useRef(pageKey);
	useEffect(() => {
		if (shownKey.current === pageKey) return;
		shownKey.current = pageKey;
		setNotes([]);
		setPicking(null);
		setVariables(null);
		setChanged({});
		next.current = 1;
	}, [pageKey]);
	const failed = useCallback(
		(error: unknown) => toastError({ title: t("panel.preview.feedback.failed"), error }),
		[t],
	);
	// Numbered markers over the picked elements.
	const pins = notes.flatMap(note =>
		note.kind === "element" && note.elements[0] ? [{ n: note.n, selector: note.elements[0].selector }] : [],
	);
	const pinsKey = JSON.stringify(pins);
	const pinsShown = useRef("[]");
	useEffect(() => {
		if (pinsShown.current === pinsKey || !state.url) return;
		pinsShown.current = pinsKey;
		void window.omp.preview.page({ action: "pins", pins: JSON.parse(pinsKey) }).catch(() => {});
	}, [pinsKey, state.url]);
	const pick = async (kind: "element" | "region") => {
		setPicking(kind);
		try {
			if (kind === "element") {
				const element = await window.omp.preview.page({ action: "pick" });
				if (element)
					setNotes(current => [...current, { n: next.current++, kind, elements: [element], comment: "" }]);
			} else {
				const region = await window.omp.preview.page({ action: "region" });
				if (region)
					setNotes(current => [
						...current,
						{ n: next.current++, kind, elements: region.elements, image: region.image, comment: "" },
					]);
			}
		} catch (error) {
			failed(error);
		} finally {
			setPicking(null);
		}
	};
	const openVariables = async () => {
		try {
			setVariables(await window.omp.preview.page({ action: "tweaks" }));
		} catch (error) {
			failed(error);
		}
	};
	return {
		notes,
		setNotes,
		picking,
		variables,
		changed,
		pick: (kind: "element" | "region") => void pick(kind),
		cancel: () => void window.omp.preview.page({ action: "cancel" }).catch(() => {}),
		openVariables: () => void openVariables(),
		closeVariables: () => setVariables(null),
		setVariable: (name: string, value: string) => {
			const before = variables?.find(variable => variable.name === name)?.value ?? "";
			setChanged(current => ({ ...current, [name]: [current[name]?.[0] ?? before, value] }));
			setVariables(
				current => current?.map(variable => (variable.name === name ? { ...variable, value } : variable)) ?? null,
			);
			void window.omp.preview.page({ action: "setVariable", name, value }).catch(failed);
		},
		resetVariables: async () => {
			try {
				await window.omp.preview.page({ action: "clearVariables" });
				setChanged({});
				setVariables(await window.omp.preview.page({ action: "tweaks" }));
			} catch (error) {
				failed(error);
			}
		},
		send: () => {
			const message = previewFeedbackMessage(t, state, notes, changed);
			window.dispatchEvent(
				new CustomEvent("omp:fill-composer", {
					detail: { text: message.text, images: message.images, prepend: true, ...(tabId ? { tabId } : {}) },
				}),
			);
			setNotes([]);
			setChanged({});
			next.current = 1;
		},
		discard: () => {
			setNotes([]);
			next.current = 1;
		},
	};
}

/** Visual bar, picker status, notes and CSS variables, between the toolbar and the page. */
export function PreviewFeedbackBar({
	state,
	feedback,
	command,
	tabId,
	pageReady,
}: {
	state: PreviewState;
	feedback: PreviewFeedback;
	command: (request: PreviewRequest) => void;
	tabId: string | null;
	pageReady: boolean;
}) {
	const t = useT();
	const { notes, picking, variables } = feedback;
	const visual = state.visual;
	const sendable = notes.length > 0 || Object.values(feedback.changed).some(([from, to]) => from !== to);
	if (!visual && !picking && notes.length === 0 && !variables) return null;
	const highlight = (selector: string) =>
		void window.omp.preview.page({ action: "highlight", selector }).catch(() => {});
	return (
		<div className="flex max-h-[45%] min-w-0 shrink-0 flex-col border-b border-(--sc-divider)" data-preview-feedback>
			<div className="flex min-w-0 items-center gap-1 px-3 py-1">
				{visual && (
					<div className="flex min-w-0 flex-1 items-center gap-2" data-preview-visual={visual.id}>
						<span className="truncate text-sc-xs font-medium text-(--sc-text)" title={visual.label}>
							{visual.label}
						</span>
						{visual.versions.length > 1 && (
							<Select
								aria-label={t("panel.preview.visual.version")}
								controlSize="sm"
								className="w-auto"
								value={String(visual.version)}
								options={[...visual.versions].reverse().map(entry => ({
									value: String(entry.version),
									label: t("panel.preview.visual.versionOf", {
										version: entry.version,
										count: visual.versions.length,
									}),
								}))}
								onChange={event => {
									if (tabId)
										command({
											action: "showVisual",
											tabId,
											visualId: visual.id,
											version: Number(event.target.value),
										});
								}}
							/>
						)}
					</div>
				)}
				{!visual && <span className="min-w-0 flex-1" />}
				<IconButton
					label={t("panel.preview.feedback.element")}
					icon={<MousePointerClick />}
					size="sm"
					pressed={picking === "element"}
					disabled={!pageReady}
					onClick={() => (picking === "element" ? feedback.cancel() : feedback.pick("element"))}
				/>
				<IconButton
					label={t("panel.preview.feedback.region")}
					icon={<SquareDashed />}
					size="sm"
					pressed={picking === "region"}
					disabled={!pageReady}
					onClick={() => (picking === "region" ? feedback.cancel() : feedback.pick("region"))}
				/>
				<IconButton
					label={t("panel.preview.feedback.variables")}
					icon={<SlidersHorizontal />}
					size="sm"
					pressed={variables !== null}
					disabled={!pageReady}
					onClick={() => (variables ? feedback.closeVariables() : feedback.openVariables())}
				/>
			</div>
			{picking && (
				<div
					className="flex min-w-0 items-center gap-2 bg-(--sc-accent-soft) px-3 py-1.5 text-sc-xs text-(--sc-text)"
					role="status"
					data-preview-picking={picking}
				>
					<span className="min-w-0 flex-1">
						{t(picking === "element" ? "panel.preview.feedback.pickHint" : "panel.preview.feedback.regionHint")}
					</span>
					<Button size="sm" variant="secondary" onClick={feedback.cancel}>
						{t("common.cancel")}
					</Button>
				</div>
			)}
			<div className="min-h-0 overflow-y-auto">
				{notes.length > 0 && (
					<ol
						aria-label={t("panel.preview.feedback.notes")}
						className="flex flex-col gap-1 px-3 py-1.5"
						data-preview-notes
					>
						{notes.map(note => {
							const [first] = note.elements;
							return (
								<li key={note.n} className="flex min-w-0 flex-col gap-1" data-preview-note={note.n}>
									<div className="flex min-w-0 items-center gap-1.5 text-sc-xs">
										<span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-(--sc-accent) text-sc-2xs font-semibold text-(--sc-accent-fg)">
											{note.n}
										</span>
										<span
											className="min-w-0 flex-1 truncate font-mono text-(--sc-text-muted)"
											title={first?.selector}
										>
											{note.kind === "element"
												? elementLabel(first)
												: t("panel.preview.feedback.regionTitle", { count: note.elements.length })}
										</span>
										{note.kind === "element" && first && (
											<>
												<IconButton
													label={t("panel.preview.feedback.show", { n: note.n })}
													icon={<Crosshair />}
													size="sm"
													onClick={() => highlight(first.selector)}
												/>
												<IconButton
													label={t("panel.preview.feedback.parent", { n: note.n })}
													icon={<ArrowUpToLine />}
													size="sm"
													onClick={async () => {
														const parent = await window.omp.preview
															.page({ action: "parent", selector: first.selector })
															.catch(() => null);
														if (parent)
															feedback.setNotes(current =>
																current.map(entry =>
																	entry.n === note.n ? { ...entry, elements: [parent] } : entry,
																),
															);
													}}
												/>
											</>
										)}
										<IconButton
											label={t("panel.preview.feedback.remove", { n: note.n })}
											icon={<X />}
											size="sm"
											onClick={() =>
												feedback.setNotes(current => current.filter(entry => entry.n !== note.n))
											}
										/>
									</div>
									{note.kind === "region" && (
										<div className="flex min-w-0 items-start gap-2">
											{note.image && (
												<img
													alt={t("panel.preview.feedback.regionImage", { n: note.n })}
													className="max-h-16 max-w-24 shrink-0 rounded-(--sc-radius-sm) border border-(--sc-border) object-contain"
													src={`data:image/png;base64,${note.image}`}
												/>
											)}
											<ul
												aria-label={t("panel.preview.feedback.elements")}
												className="flex min-w-0 flex-1 flex-wrap gap-1"
											>
												{note.elements.map(element => (
													<li key={element.selector} className="min-w-0">
														<button
															type="button"
															className="max-w-48 truncate rounded-(--sc-radius-sm) border border-(--sc-border) px-1.5 font-mono text-sc-xs text-(--sc-text-muted) hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
															title={element.selector}
															onClick={() => highlight(element.selector)}
														>
															{elementLabel(element)}
														</button>
													</li>
												))}
											</ul>
										</div>
									)}
									<Input
										aria-label={t("panel.preview.feedback.comment", { n: note.n })}
										controlSize="sm"
										placeholder={t("panel.preview.feedback.commentPlaceholder")}
										value={note.comment}
										onChange={event => {
											const comment = event.target.value;
											feedback.setNotes(current =>
												current.map(entry => (entry.n === note.n ? { ...entry, comment } : entry)),
											);
										}}
									/>
								</li>
							);
						})}
					</ol>
				)}
				{variables && (
					<section
						aria-label={t("panel.preview.feedback.variables")}
						className="px-3 py-1.5"
						data-preview-variables
					>
						{variables.length === 0 ? (
							<p className="text-sc-xs text-(--sc-text-muted)">{t("panel.preview.feedback.noVariables")}</p>
						) : (
							<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
								{variables.map(variable => (
									<label key={variable.name} className="contents">
										<span
											className="truncate font-mono text-sc-xs text-(--sc-text-muted)"
											title={variable.name}
										>
											{variable.name}
										</span>
										<Input
											controlSize="sm"
											mono
											value={variable.value}
											onChange={event => feedback.setVariable(variable.name, event.target.value)}
										/>
									</label>
								))}
							</div>
						)}
						<div className="flex justify-end pt-1">
							<Button
								size="sm"
								variant="ghost"
								icon={<RotateCcw />}
								disabled={Object.keys(feedback.changed).length === 0}
								onClick={() => void feedback.resetVariables()}
							>
								{t("panel.preview.feedback.resetVariables")}
							</Button>
						</div>
					</section>
				)}
			</div>
			{sendable && (
				<div className="flex items-center justify-end gap-1 px-3 py-1.5">
					<Button size="sm" variant="ghost" onClick={feedback.discard} disabled={notes.length === 0}>
						{t("panel.preview.feedback.discard")}
					</Button>
					<Button size="sm" variant="primary" icon={<Send />} onClick={feedback.send}>
						{t("panel.preview.feedback.send")}
					</Button>
				</div>
			)}
		</div>
	);
}

/** "All visuals" (C141): every visual the agent showed on this computer, newest first; Open adds one to this tab. */
export function AllVisualsDialog({
	open,
	onClose,
	onOpen,
}: {
	open: boolean;
	onClose: () => void;
	onOpen: (visualId: string) => void;
}) {
	const t = useT();
	const [records, setRecords] = useState<PreviewVisualRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(() => {
		setError(null);
		window.omp.preview
			.visuals()
			.then(setRecords, reason => setError(reason instanceof Error ? reason.message : String(reason)));
	}, []);
	useEffect(() => {
		if (open) load();
	}, [open, load]);
	return (
		<Modal open={open} onClose={onClose} title={t("panel.preview.visual.allTitle")} size="md">
			<AsyncSection
				loading={records === null && !error}
				hasData={records !== null}
				error={error}
				empty={records?.length === 0}
				emptyLabel={t("panel.preview.visual.none")}
				onRetry={load}
			>
				<ul className="flex flex-col" data-preview-visual-list>
					{records?.map(record => (
						<li key={record.id} className="flex min-w-0 items-center gap-2 border-b border-(--sc-divider) py-2">
							<div className="min-w-0 flex-1">
								<div className="truncate text-sc-sm font-medium text-(--sc-text)">{record.label}</div>
								<div className="truncate text-sc-xs text-(--sc-text-muted)" title={record.target || record.cwd}>
									{t(`panel.preview.visual.kind.${record.kind}`)}
									{" · "}
									{record.target || record.cwd}
								</div>
								<div className="text-sc-xs text-(--sc-text-muted)">
									{t("panel.preview.visual.meta", {
										count: record.versions,
										when: formatTimeAgo(new Date(record.updatedAt).toISOString()),
									})}
								</div>
							</div>
							<Button
								size="sm"
								variant="secondary"
								aria-label={t("panel.preview.visual.open", { label: record.label })}
								onClick={() => {
									onOpen(record.id);
									onClose();
								}}
							>
								{t("panel.preview.visual.openShort")}
							</Button>
						</li>
					))}
				</ul>
			</AsyncSection>
		</Modal>
	);
}
