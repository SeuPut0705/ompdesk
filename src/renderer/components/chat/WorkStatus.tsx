import { Check, Minus, X } from "lucide-react";
import { cx } from "../../lib/format";

export type WorkState = "running" | "pending" | "complete" | "failed" | "stopped";

/** How a work group (or one agent's lane) ended, resolved once by its owner. */
export type WorkGroupState = "running" | "failed" | "interrupted" | "complete";

export function agentGroupState(status: string | undefined): WorkGroupState {
	switch (status) {
		case "running":
		case "pending":
			return "running";
		case "failed":
			return "failed";
		case "cancelled":
			return "interrupted";
		default:
			return "complete";
	}
}

/** Maps a stock subagent status onto the four shapes the work view draws. */
export function agentWorkState(status: string | undefined): WorkState {
	switch (status) {
		case "running":
			return "running";
		case "pending":
			return "pending";
		case "completed":
			return "complete";
		case "failed":
			return "failed";
		default:
			return "stopped";
	}
}

/**
 * One status mark shared by the work head and agent lanes: a breathing accent
 * dot while running (static under reduced motion), a hollow ring while queued,
 * then a check, a cross or a dash. The label carries the state for assistive tech.
 */
export function WorkStatus({ state, label, motion }: { state: WorkState; label: string; motion: boolean }) {
	return (
		<span
			className={cx("omp-work-status", motion && state === "running" && "omp-work-pulse")}
			data-state={state}
			role="img"
			aria-label={label}
			title={label}
		>
			{state === "complete" ? (
				<Check aria-hidden />
			) : state === "failed" ? (
				<X aria-hidden />
			) : state === "stopped" ? (
				<Minus aria-hidden />
			) : null}
		</span>
	);
}
