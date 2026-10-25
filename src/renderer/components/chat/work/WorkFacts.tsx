import { Check, CircleX, FileDiff, Globe, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../../lib/format";

type WorkFactTone = "ok" | "fail" | "neutral";

/** One thing a finished run did, drawn as a labeled metric button: a word, then its figure. */
export interface WorkFact {
	key: string;
	/** The `data-work-finding` value the tests and captures look for. */
	finding: string;
	tone: WorkFactTone;
	icon: "files" | "check" | "error" | "preview";
	label: string;
	figure?: ReactNode;
	/** The whole fact as one sentence: the button's accessible name. */
	sentence: string;
	title: string;
	onSelect: () => void;
}

const ICONS: Record<WorkFact["icon"], LucideIcon> = {
	files: FileDiff,
	check: Check,
	error: CircleX,
	preview: Globe,
};

/**
 * A finished card's one row of facts, each its own action (a failed check shows its step, files open
 * Changes, the preview opens Preview), then the failing step's cause in danger and the Copy button.
 */
export function WorkMetrics({
	facts,
	cause,
	trailing,
}: {
	facts: readonly WorkFact[];
	cause: ReactNode;
	trailing: ReactNode;
}) {
	return (
		<div className="omp-work-facts">
			<div className="omp-work-metrics">
				{facts.map(fact => {
					const Icon = ICONS[fact.icon];
					return (
						// controls-ok: the omp-work-metric class draws the whole control
						<button
							aria-label={fact.sentence}
							className="omp-work-metric"
							data-tone={fact.tone}
							data-work-finding={fact.finding}
							key={fact.key}
							onClick={fact.onSelect}
							title={fact.title}
							type="button"
						>
							<Icon
								aria-hidden="true"
								className={cx(
									"size-(--sc-icon-sm) shrink-0",
									fact.tone === "ok" && "text-(--sc-success)",
									fact.tone === "fail" && "text-(--sc-danger)",
								)}
							/>
							<span>{fact.label}</span>
							{fact.figure ? <span className="omp-work-metric-figure tabular-nums">{fact.figure}</span> : null}
						</button>
					);
				})}
				{trailing}
			</div>
			{cause}
		</div>
	);
}
