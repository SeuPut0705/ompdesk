/**
 * Memory › Search: full-text across the chosen project, or all projects. A hit shows its title, path, kind, tier,
 * when it changed and the matching snippet; opening one lands in Pages. The last query is kept for the run.
 */
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AiMemoryPageRef, AiMemoryProjectRef } from "../../../../shared/ai-memory";
import { formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { SearchField, Tabs } from "../../common";
import { projectLabel } from "./MemorySection";
import { LIST_ROW, MutedLine, ReadError } from "./memory-ui";

type Scope = "project" | "all";
/** Kept across tab switches for the run. */
let lastQuery = "";
let lastScope: Scope = "project";

/** Tests: forget the kept query. */
export function resetMemorySearchForTest(): void {
	lastQuery = "";
	lastScope = "project";
}

export function MemorySearch({ project }: { project: AiMemoryProjectRef }) {
	const t = useT();
	const [query, setQuery] = useState(lastQuery);
	const [submitted, setSubmitted] = useState(lastQuery);
	const [scope, setScope] = useState<Scope>(lastScope);
	const [hits, setHits] = useState<AiMemoryPageRef[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sequence = useRef(0);
	const version = useMemoryPageStore(s => s.version);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `project` only matters in project scope; `version` re-reads after a write.
	useEffect(() => {
		lastQuery = submitted;
		lastScope = scope;
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
			<div className="flex flex-wrap items-center gap-2">
				<form className="min-w-48 flex-1" onSubmit={onSubmit}>
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
				<Tabs
					activeId={scope}
					ariaLabel={t("memory.search.scope")}
					compact
					onChange={id => setScope(id as Scope)}
					tabs={[
						{ id: "project", label: t("memory.search.project") },
						{ id: "all", label: t("memory.search.all") },
					]}
					variant="segmented"
				/>
			</div>
			<ReadError error={error} onRetry={() => useMemoryPageStore.getState().bump()} />
			{!submitted && <MutedLine data-memory-hint>{t("memory.search.hint")}</MutedLine>}
			{submitted && hits !== null && hits.length === 0 && (
				<MutedLine data-memory-no-results>{t("memory.search.none")}</MutedLine>
			)}
			<ul className="flex flex-col" data-memory-results>
				{(hits ?? []).map(hit => (
					<li key={`${hit.workspace}/${hit.project}/${hit.path}`}>
						<button
							className={`${LIST_ROW} flex-col items-start gap-0.5`}
							data-memory-hit={hit.path}
							onClick={() => useMemoryPageStore.getState().openPage(hit)}
							type="button"
						>
							<span className="w-full truncate font-medium">{hit.title || hit.path}</span>
							<span className="w-full truncate text-sc-xs text-(--sc-text-muted)">
								{[
									scope === "all" ? projectLabel(hit) : null,
									hit.path,
									hit.kind ? t(`memory.kind.${hit.kind}`) : null,
									hit.tier ? t(`memory.tier.${hit.tier}`) : null,
									formatTimeAgo(hit.updatedAt) || null,
								]
									.filter(Boolean)
									.join(" · ")}
							</span>
							{hit.snippet && (
								<span className="line-clamp-2 w-full text-sc-xs text-(--sc-text-secondary)">{hit.snippet}</span>
							)}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
