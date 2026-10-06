import type { AgentMessage } from "../../../shared/rpc-types";

export interface LaunchCompletionDaemon {
	name: string;
	state?: string;
	exitCode?: number;
	startedAt?: number;
	exitedAt?: number;
}

export function isCompletionMessage(message: AgentMessage): boolean {
	return message.customType === "async-result" || message.customType === "launch-completion";
}

export function launchCompletionDaemons(message: AgentMessage): LaunchCompletionDaemon[] {
	if (message.customType !== "launch-completion") return [];
	if (typeof message.details !== "object" || message.details === null) return [];
	const daemons = (message.details as Record<string, unknown>).daemons;
	if (!Array.isArray(daemons)) return [];
	return daemons.flatMap(value => {
		if (typeof value !== "object" || value === null) return [];
		const daemon = value as Record<string, unknown>;
		if (typeof daemon.name !== "string" || daemon.name.trim() === "") return [];
		return [
			{
				name: daemon.name.trim(),
				state: typeof daemon.state === "string" ? daemon.state : undefined,
				exitCode: typeof daemon.exitCode === "number" ? daemon.exitCode : undefined,
				startedAt: typeof daemon.startedAt === "number" ? daemon.startedAt : undefined,
				exitedAt: typeof daemon.exitedAt === "number" ? daemon.exitedAt : undefined,
			},
		];
	});
}

export function launchCompletionFailureCount(message: AgentMessage): number {
	return launchCompletionDaemons(message).filter(
		daemon => daemon.state === "failed" || (daemon.exitCode !== undefined && daemon.exitCode !== 0),
	).length;
}
