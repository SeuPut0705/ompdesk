/**
 * Search in file contents (C46/C47): the query, Match case / Whole word /
 * Regex toggles and a filename glob run stock's gitignore-aware grep in main
 * (`fs.search`); hits group by file, and a line opens the viewer on it.
 * Typing searches after a short pause; an older answer never replaces a newer one.
 */
import { CaseSensitive, FileText, Regex, WholeWord } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { IpcFsSearchResult } from "../../../shared/ipc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { EmptyState, IconButton, InlineNotice, SearchField, Spinner } from "../common";

/** Pause after the last keystroke before a search runs. */
const SEARCH_DEBOUNCE_MS = 250;

type SearchState =
	| { status: "idle" }
	| { status: "searching" }
	| { status: "done"; result: IpcFsSearchResult }
	| { status: "error"; failure: InlineFailure };

export function FileContentSearch({ tabId, focusSeq }: { tabId: string | undefined; focusSeq: number }) {
	const t = useT();
	const openFilePreview = useUiStore(s => s.openFilePreview);
	const [query, setQuery] = useState("");
	const [glob, setGlob] = useState("");
	const [matchCase, setMatchCase] = useState(false);
	const [wholeWord, setWholeWord] = useState(false);
	const [regex, setRegex] = useState(false);
	const [state, setState] = useState<SearchState>({ status: "idle" });
	const field = useRef<HTMLInputElement>(null);
	const version = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: focusSeq is the request to focus again.
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, [focusSeq]);

	useEffect(() => {
		const current = ++version.current;
		if (!query) {
			setState({ status: "idle" });
			return;
		}
		setState({ status: "searching" });
		const timer = window.setTimeout(() => {
			void window.omp.fs.search({ query, matchCase, wholeWord, regex, glob }, tabId).then(
				result => {
					if (current !== version.current) return;
					setState(
						result.ok
							? { status: "done", result }
							: { status: "error", failure: inlineFailure(result, t("filesPanel.contentSearch.failed")) },
					);
				},
				cause => {
					if (current === version.current)
						setState({ status: "error", failure: inlineFailure(cause, t("filesPanel.contentSearch.failed")) });
				},
			);
		}, SEARCH_DEBOUNCE_MS);
		return () => window.clearTimeout(timer);
	}, [query, glob, matchCase, wholeWord, regex, tabId, t]);

	const groups: { path: string; lines: { line: number; text: string }[] }[] = [];
	if (state.status === "done") {
		const byPath = new Map<string, { line: number; text: string }[]>();
		for (const match of state.result.matches) {
			let lines = byPath.get(match.path);
			if (!lines) {
				lines = [];
				byPath.set(match.path, lines);
				groups.push({ path: match.path, lines });
			}
			lines.push({ line: match.line, text: match.text });
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-files-content-search>
			<div className="flex shrink-0 flex-col gap-1.5 border-b border-(--sc-divider) px-3 py-2">
				<div className="flex min-w-0 items-center gap-0.5">
					<div className="min-w-0 flex-1">
						<SearchField
							ref={field}
							controlSize="sm"
							label={t("filesPanel.contentSearch.query")}
							placeholder={t("filesPanel.contentSearch.query")}
							value={query}
							onValueChange={setQuery}
						/>
					</div>
					<IconButton
						icon={<CaseSensitive />}
						label={t("filesPanel.contentSearch.matchCase")}
						onClick={() => setMatchCase(value => !value)}
						pressed={matchCase}
						size="sm"
					/>
					<IconButton
						icon={<WholeWord />}
						label={t("filesPanel.contentSearch.wholeWord")}
						onClick={() => setWholeWord(value => !value)}
						pressed={wholeWord}
						size="sm"
					/>
					<IconButton
						icon={<Regex />}
						label={t("filesPanel.contentSearch.regex")}
						onClick={() => setRegex(value => !value)}
						pressed={regex}
						size="sm"
					/>
				</div>
				<input
					aria-label={t("filesPanel.contentSearch.glob")}
					className="h-(--sc-control-sm) min-w-0 rounded-(--sc-radius-sm) border border-(--sc-border) bg-(--sc-field) px-2 font-mono text-sc-xs text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
					placeholder={t("filesPanel.contentSearch.globPlaceholder")}
					spellCheck={false}
					autoCapitalize="none"
					value={glob}
					onChange={event => setGlob(event.target.value)}
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" aria-live="polite">
				{state.status === "idle" ? (
					<EmptyState icon={<FileText />} size="sm" title={t("filesPanel.contentSearch.hint")} />
				) : state.status === "searching" ? (
					<Spinner
						className="w-full justify-center py-8"
						label={t("filesPanel.contentSearch.searching")}
						size="sm"
					/>
				) : state.status === "error" ? (
					<div className="p-3">
						<InlineNotice tone="danger" title={state.failure.message} detail={state.failure.cause} live />
					</div>
				) : groups.length === 0 ? (
					<EmptyState icon={<FileText />} size="sm" title={t("filesPanel.contentSearch.none")} />
				) : (
					<>
						<p className="px-2 py-1.5 text-sc-xs tabular-nums text-(--sc-text-subtle)" data-content-search-count>
							{t(
								state.result.limited ? "filesPanel.contentSearch.countMore" : "filesPanel.contentSearch.count",
								{
									matches: state.result.matches.length,
									files: groups.length,
								},
							)}
						</p>
						<ul>
							{groups.map(group => (
								<li key={group.path} className="pb-1">
									<div
										className="truncate px-2 py-1 text-sc-sm font-medium text-(--sc-text)"
										title={group.path}
										data-content-search-file={group.path}
									>
										{group.path}
									</div>
									<ul>
										{group.lines.map(hit => (
											<li key={hit.line}>
												<button
													type="button"
													className="flex w-full min-w-0 items-baseline gap-2 rounded-(--sc-radius-sm) px-2 py-0.5 text-left text-sc-xs hover:bg-(--sc-hover) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
													onClick={() => openFilePreview(group.path, { line: hit.line })}
												>
													<span className="w-8 shrink-0 text-right tabular-nums text-(--sc-text-subtle)">
														{hit.line}
													</span>
													<span className="min-w-0 flex-1 truncate font-mono text-(--sc-text-muted)">
														{hit.text.trim()}
													</span>
												</button>
											</li>
										))}
									</ul>
								</li>
							))}
						</ul>
					</>
				)}
			</div>
		</div>
	);
}
