/**
 * Stock's `/dump all|anon` as a command with a structured answer. Over stock RPC the slash command only prints the
 * archive path inside a `command_output` prose frame and rides the prompt queue, so the tab's omp writes the zip
 * through the bridge (session-dump.ts) and main copies it where the person chose (src/main/diagnostic-bundle.ts).
 * A tab a host runs for a paired device answers on the host: the archive is that computer's file.
 *
 * Stock's archive holds the raw transcript, the LLM request and subagent transcripts (`/dump anon` only what its
 * anonymizer kept), so it never leaves this step as is: every text member goes through the diagnostics redactor
 * into a new zip, a member that is not text is dropped and named in `dropped`, and stock's file is deleted. This runs
 * on the machine whose omp wrote the archive, so a host redacts before a paired device reads a byte.
 */
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import type { SessionArchive, SessionArchiveDiscard } from "../../shared/diagnostic-bundle";
import { redactDiagnosticsFile } from "../redactor";
import { LocalCommandError, type LocalHandler } from "./types";

/** Archives this process asked for and nobody deleted yet: the only files `discard_session_archive` removes. */
const produced = new Set<string>();

/** Stock's archive as a redacted zip beside it (stock's own file is left to the caller to delete). */
async function redactArchive(stock: string): Promise<{ path: string; files: string[]; dropped: string[] }> {
	const source = await JSZip.loadAsync(await fsp.readFile(stock));
	const out = new JSZip();
	const files: string[] = [];
	const dropped: string[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (const [name, entry] of Object.entries(source.files)) {
		if (entry.dir) continue;
		let text: string | undefined;
		try {
			text = decoder.decode(await entry.async("uint8array"));
		} catch {}
		if (text === undefined || text.includes("\0")) {
			dropped.push(name);
			continue;
		}
		out.file(name, redactDiagnosticsFile(name, text), { createFolders: false });
		files.push(name);
	}
	const file = path.join(path.dirname(stock), `ompdesk-dump-${randomUUID()}.zip`);
	await fsp.writeFile(file, await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), { mode: 0o600 });
	return { path: file, files, dropped };
}

export const handlers: Record<string, LocalHandler> = {
	dump_session_archive: async (command, ctx): Promise<SessionArchive> => {
		const anonymized = z.boolean().optional().parse(command.anonymized) === true;
		const archive = await ctx.bridge.request<Omit<SessionArchive, "redacted" | "dropped"> | null>("session_dump", {
			anonymized,
		});
		if (!archive) throw new LocalCommandError("No messages to dump yet.", "no_messages");
		try {
			const redacted = await redactArchive(archive.path);
			produced.add(redacted.path);
			return {
				path: redacted.path,
				files: redacted.files,
				subagentCount: archive.subagentCount,
				anonymized: archive.anonymized,
				redacted: true,
				...(redacted.dropped.length > 0 ? { dropped: redacted.dropped } : {}),
				...(archive.subagentError ? { subagentError: archive.subagentError } : {}),
			};
		} finally {
			await fsp.rm(archive.path, { force: true });
		}
	},

	discard_session_archive: async (command): Promise<SessionArchiveDiscard> => {
		const file = z.string().min(1).parse(command.path);
		if (!produced.delete(file)) return { removed: false };
		await fsp.rm(file, { force: true });
		return { removed: true };
	},
};
