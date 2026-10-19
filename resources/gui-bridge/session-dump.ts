// Defer stock imports until guard succeeds: incompatible omp modules must not prevent bridge startup.
import { guard } from "./health";
import type { BridgeMethods } from "./types";

/**
 * Stock's `/dump all` and `/dump anon` over RPC only print the archive path inside a `command_output` text frame
 * and wait in the prompt queue; these call the exact session methods those commands run and hand the structured
 * result back. The zip lives in `os.tmpdir()` until the GUI has copied it and asks main to delete it.
 */
export const methods: BridgeMethods = guard("sessionDump", {
	/** `{anonymized?}` → stock's `SessionDumpArchive` (`anonymized` always set), or null while the session has no messages. */
	session_dump: async (params, env) => {
		const anonymized =
			typeof params === "object" && params !== null && "anonymized" in params && params.anonymized === true;
		const session = env.session();
		const archive = anonymized
			? await session.dumpAnonymizedArchiveToTmpDir()
			: await session.dumpSessionArchiveToTmpDir();
		if (!archive) return null;
		return { ...archive, anonymized };
	},
});
