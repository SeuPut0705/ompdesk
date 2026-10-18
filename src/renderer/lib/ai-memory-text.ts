import type { AiMemoryState } from "../../shared/ai-memory";

/** The one status sentence Settings and the side panel share: phase (with the step while starting), version, source. */
export function aiMemoryStatusText(
	t: (key: string, params?: Record<string, string | number>) => string,
	state: AiMemoryState,
): string {
	const parts = [
		state.phase === "starting" && state.step
			? t("aiMemory.phase.startingStep", { step: t(`aiMemory.step.${state.step}`) })
			: t(`aiMemory.phase.${state.phase}`),
	];
	if (state.version) parts.push(`v${state.version}`);
	if (state.version && state.phase !== "off" && state.phase !== "unsupported")
		parts.push(t(`aiMemory.source.${state.source}`));
	return parts.join(" · ");
}
