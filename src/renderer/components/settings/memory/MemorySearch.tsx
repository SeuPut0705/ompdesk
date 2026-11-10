/**
 * Memory › Search: full-text across the chosen project, or all projects (the first option of the tab bar's project
 * picker, `useSearchScope`). A hit shows its title, the matching snippet, its kind (and its tier where the kind does not
 * imply it) and when it changed; its path is the tooltip. Opening one lands in Pages. The last query and scope are
 * kept for the run.
 */
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AiMemoryPageRef, AiMemoryProjectRef } from "../../../../shared/ai-memory";
import { useT } from "../../../lib/i18n";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { ListRow, SearchField, TimeAgo } from "../../common";
import { projectLabel } from "./MemorySection";
import { MutedLine, ReadError, unusualTier } from "./memory-ui";

export type SearchScope = "project" | "all";
/** Kept across tab switches for the run. */
let lastQuery = "";
let lastScope: SearchScope = "project";

/** Tests: forget the kept query and scope. */
export function resetMemorySearchForTest(): void {
	lastQuery = "";
	lastScope = "project";
}

/** Where Search looks, kept for the run; the Memory page's project picker sets it. */
export function useSearchScope(): [SearchScope, (scope: SearchScope) => void] {
	const [scope, setScope] = useState(lastScope);
	const choose = (next: SearchScope) => {
		lastScope = next;
		setScope(next);
	};
	return [scope, choose];
}

export function MemorySearch({ project, scope }: { project: AiMemoryProjectRef; scope: SearchScope }) {
	const t = useT();
	const [query, setQuery] = useState(lastQuery);
	const [submitted, setSubmitted] = useState(lastQuery);
	const [hits, setHits] = useState<AiMemoryPageRef[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sequence = useRef(0);
	const version = useMemoryPageStore(s => s.version);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `project` only matters in project scope; `version` re-reads after a write.
	useEffect(() => {
		lastQuery = submitted;
		if (!submitted) {
			setHits(null);
			setError(null);
			return;
		}
		const mine = ++sequence.current;
		window.omp.aiMemory.search(submitted, scope === "all" ? undefined : project).then(
			found => {
				if (mine !== sequence.current) return;
				setHits(found);
				setError(null);
			},
			cause => {
				if (mine === sequence.current) setError(cause instanceof Error ? cause.message : String(cause));
			},
		);
	}, [submitted, scope, scope === "all" ? "" : `${project.workspace}/${project.project}`, version]);

	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		setSubmitted(query.trim());
	};

	return (
		<div className="flex flex-col gap-2" data-memory-search>
			<form onSubmit={onSubmit}>
				<SearchField
					label={t("memory.search.label")}
					onValueChange={value => {
						setQuery(value);
						if (value.trim() === "") setSubmitted("");
					}}
					placeholder={t("memory.search.placeholder")}
					value={query}
				/>
			</form>
			<ReadError error={error} onRetry={() => useMemoryPageStore.getState().bump()} />
			{!submitted && <MutedLine data-memory-hint>{t("memory.search.hint")}</MutedLine>}
			{submitted && hits !== null && hits.length === 0 && (
				<MutedLine data-memory-no-results>{t("memory.search.none")}</MutedLine>
			)}
			<ul className="flex flex-col" data-memory-results>
				{(hits ?? []).map(hit => {
					const tier = unusualTier(hit);
					const facts = [
						scope === "all" ? projectLabel(hit) : null,
						hit.kind ? t(`memory.kind.${hit.kind}`) : null,
						tier ? t(`memory.tier.${tier}`) : null,
					].filter(Boolean);
					return (
						<li key={`${hit.workspace}/${hit.project}/${hit.path}`}>
							<ListRow
								description={hit.snippet || undefined}
								descriptionLines={2}
								meta={
									<span className="flex items-center gap-2">
										{facts.length > 0 && <span>{facts.join(" · ")}</span>}
										{hit.updatedAt && <TimeAgo iso={hit.updatedAt} />}
									</span>
								}
								onClick={() => useMemoryPageStore.getState().openPage(hit)}
								rowProps={{ "data-memory-hit": hit.path }}
								title={hit.title || hit.path}
							/>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
