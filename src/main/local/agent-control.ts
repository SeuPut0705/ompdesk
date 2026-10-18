/**
 * OMPdesk control tools (src/main/agent-control/): the confirmation card a risky tool call waits for, and the note
 * an answered session keeps. Main asks the calling tab's omp (a paired host's tab: on the host, so the card reaches
 * the device like any other approval) and the bridge raises stock's own extension-UI `confirm`
 * (gui-bridge agent-control.ts). Not stock commands and never sent by a renderer.
 */
import { z } from "zod";
import type { LocalHandler } from "./types";

const confirmCommand = z.object({ title: z.string().min(1).max(200), message: z.string().min(1).max(2000) });
const noteCommand = z.object({ text: z.string().min(1).max(500) });
const workerCommand = z.object({ from: z.string().min(1).max(200) });

export const handlers: Record<string, LocalHandler> = {
	agent_control_confirm: async (command, ctx) => {
		const { title, message } = confirmCommand.parse(command);
		const { approved } = await ctx.bridge.request<{ approved: boolean }>("agent_control.confirm", { title, message });
		return { approved: approved === true };
	},
	agent_control_note: async (command, ctx) => {
		const { text } = noteCommand.parse(command);
		await ctx.bridge.request("agent_control.note", { text });
		return {};
	},
	/** The session was opened by another session's agent: its bridge journals it and adds the worker contract. */
	agent_control_worker: async (command, ctx) => {
		const { from } = workerCommand.parse(command);
		await ctx.bridge.request("agent_control.worker", { from });
		return {};
	},
};
