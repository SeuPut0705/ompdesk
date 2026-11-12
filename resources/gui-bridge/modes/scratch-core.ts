/**
 * The session's scratch folder, pure half (./scratch.ts wires it): one short per-turn prompt section naming the
 * folder OMPdesk made for this tab's throwaway files (main `src/main/session-scratch.ts`, which also says why it is
 * not the temp folder). Without it agents write screenshots, test output and probes to `/tmp`, the home folder or
 * the repository by hard-coded path, where nothing can tie them to a session afterwards (measured:
 * machine-setup-updates › Disk care). Two sentences: every byte rides on every request.
 *
 * Dependency-free: main imports the variable's name.
 */

/** The tab's scratch folder, an absolute path; set per spawn by main (`sessionEnv`). */
export const SCRATCH_ENV = "OMP_GUI_SCRATCH";

export const SCRATCH_SECTION_ID = "scratch";

/** The section for a session whose omp was given `dir`, or undefined for none. */
export function scratchSection(dir: string | undefined): string | undefined {
	if (!dir) return undefined;
	return `<scratch>
Put every file you make only to do the work (screenshots, captures, test output, logs, probes, throwaway checkouts, downloads) under \`${dir}\`, never in \`/tmp\`, the temp folder, the home folder or the repository. OMPdesk removes that folder some days after this session's tab is closed and keeps only the files your replies show or link, until the session is deleted.
</scratch>`;
}
