import { AlertCircle, CheckCircle2, Circle, XCircle } from "lucide-react";
import type { TodoTask } from "../../../../shared/rpc-types";
import { StatusDot } from "../../common";

/** Each task state's word: read beside its mark, which is decorative. */
export const TODO_STATUS_LABEL_KEY: Record<TodoTask["status"], string> = {
	pending: "todoPanel.status.pending",
	in_progress: "todoPanel.status.inProgress",
	completed: "todoPanel.status.completed",
	blocked: "todoPanel.status.blocked",
	abandoned: "todoPanel.status.abandoned",
};

/** A task's state as a shape as well as a colour: a dashed ring, the live dot, a check, a warning, a cross. */
export function TodoStatusIcon({ status }: { status: TodoTask["status"] }) {
	if (status === "in_progress") return <StatusDot decorative pulse={false} size="md" tone="working" />;
	if (status === "completed") return <CheckCircle2 aria-hidden="true" className="text-(--sc-text-muted)" size={16} />;
	if (status === "blocked") return <AlertCircle aria-hidden="true" className="text-(--sc-warning)" size={16} />;
	if (status === "abandoned") return <XCircle aria-hidden="true" className="text-(--sc-danger)" size={16} />;
	return <Circle aria-hidden="true" className="text-(--sc-text-subtle)" size={16} strokeDasharray="2.5 2.5" />;
}
