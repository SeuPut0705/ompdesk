/**
 * Stock's `/dump all|anon` as a command with a structured answer. Over stock RPC the slash command only prints the
 * archive path inside a `command_output` prose frame and rides the prompt queue, so the tab's omp writes the zip
 * through the bridge (session-dump.ts) and main copies it where the person chose (src/main/diagnostic-bundle.ts).
 * A tab a host runs for a paired device answers on the host: the archive is that computer's file.
 */
import { promises as fsp } from "node:fs";
import { z } from "zod";
import type { SessionArchive, SessionArchiveDiscard } from "../../shared/diagnostic-bundle";
import { LocalCommandError, type LocalHandler } from "./types";

/** Archives this process asked for and nobody deleted yet: the only files `discard_session_archive` removes. */
const produced = new Set<string>();

export const handlers: Record<string, LocalHandler> = {
	dump_session_archive: async (command, ctx): Promise<SessionArchive> => {
		const anonymized = z.boolean().optional().parse(command.anonymized) === true;
		const archive = await ctx.bridge.request<SessionArchive | null>("session_dump", { anonymized });
		if (!archive) throw new LocalCommandError("No messages to dump yet.", "no_messages");
		produced.add(archive.path);
		return archive;
	},

	discard_session_archive: async (command): Promise<SessionArchiveDiscard> => {
		const path = z.string().min(1).parse(command.path);
		if (!produced.delete(path)) return { removed: false };
		await fsp.rm(path, { force: true });
		return { removed: true };
	},
};
