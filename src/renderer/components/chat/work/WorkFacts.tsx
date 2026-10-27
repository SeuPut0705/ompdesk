import { Ban, BookOpen, Check, CircleX, FileDiff, Globe, type LucideIcon, Shield, Users } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../../lib/format";

type WorkFactTone = "ok" | "fail" | "neutral";

/** One thing a finished run did: a failed one is a verdict block, every other a labeled chip. */
export interface WorkFact {
	key: string;
	/** The `data-work-finding` value the tests and captures look for; `error` for every failed fact. */
	finding: string;
	tone: WorkFactTone;
	icon: "files" | "check" | "error" | "preview" | "stopped" | "skill" | "peers" | "protected";
	label: string;
	figure?: ReactNode;
	/** A verdict block's cause: the first line of output that says what failed. */
	detail?: string;
	/** A verdict block's right-hand figure: the exit code. */
	meta?: string;
	/** Failures folded into this block: one quiet line under it that opens the steps (no call to reveal). */
	more?: { label: string; onSelect: () => void };
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
	stopped: Ban,
	skill: BookOpen,
	peers: Users,
	protected: Shield,
};

function FactIcon({ fact }: { fact: WorkFact }) {
	const Icon = ICONS[fact.icon];
	return (
		<Icon
			aria-hidden="true"
			className={cx(
				"size-(--sc-icon-sm) shrink-0",
				fact.tone === "ok" && "text-(--sc-success)",
				fact.tone === "fail" && "text-(--sc-danger)",
			)}
		/>
	);
}

/**
 * A finished card's facts, each its own action. A failed check or command is a verdict block: its verdict, exit
 * code and cause (two lines at most) in one button that shows the failing step, and, when more than one thing
 * failed, one quiet "+N more failed" line that opens the steps. Files open Changes, a passing check shows its run,
 * the dev server opens Preview, the skills read show the first read, files another live session also changed open
 * that session.
 */
export function WorkMetrics({ facts }: { facts: readonly WorkFact[] }) {
	const blocks = facts.filter(fact => fact.tone === "fail");
	const chips = facts.filter(fact => fact.tone !== "fail");
	return (
		<div className="omp-work-facts">
			{blocks.map(fact => (
				<div className="omp-work-verdict-group" key={fact.key}>
					{/* controls-ok: the omp-work-verdict class draws the whole control */}
					<button
						aria-label={fact.detail ? `${fact.sentence}: ${fact.detail}` : fact.sentence}
						className="omp-work-verdict"
						data-work-finding={fact.finding}
						onClick={fact.onSelect}
						title={fact.detail ?? fact.title}
						type="button"
					>
						<FactIcon fact={fact} />
						<span className="omp-work-verdict-label">{fact.label}</span>
						{fact.meta ? <span className="omp-work-verdict-meta tabular-nums">{fact.meta}</span> : <span />}
						{fact.detail ? <span className="omp-work-verdict-cause">{fact.detail}</span> : null}
					</button>
					{fact.more ? (
						// controls-ok: the omp-work-verdict-more class draws the whole control
						<button
							className="omp-work-verdict-more"
							data-work-finding="more-failed"
							onClick={fact.more.onSelect}
							type="button"
						>
							{fact.more.label}
						</button>
					) : null}
				</div>
			))}
			{chips.length ? (
				<div className="omp-work-metrics">
					{chips.map(fact => (
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
							<FactIcon fact={fact} />
							<span className="omp-work-metric-label">{fact.label}</span>
							{fact.figure ? <span className="omp-work-metric-figure tabular-nums">{fact.figure}</span> : null}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
