/**
 * Run by `formal-stock.test.ts` under Bun (stock omp's source needs Bun's runtime): builds a real omp session with
 * the given extension roots in the caller's isolated HOME and agent dir and prints, as one JSON line, what the
 * formal-verification skill costs and exposes. Args: `<omp package root> <cwd> <extension root>...`.
 */
export {};

const [packageRoot, cwd, ...roots] = process.argv.slice(2);
// The installed omp's own modules: the package root is only known at run time, so no static import can name them.
const { createAgentSession } = await import(`${packageRoot}/src/sdk.ts`);
const { SkillProtocolHandler } = await import(`${packageRoot}/src/internal-urls/skill-protocol.ts`);
const { parseInternalUrl } = await import(`${packageRoot}/src/internal-urls/parse.ts`);

const { session } = await createAgentSession({ cwd, additionalExtensionPaths: roots, disableExtensionDiscovery: true });
const skills: { name: string; filePath: string; hide?: boolean; disableModelInvocation?: boolean }[] = [
	...session.skills,
];
const handler = new SkillProtocolHandler();
const read: Record<string, string> = {};
for (const url of ["skill://ompdesk-formal-verify", "skill://ompdesk-formal-verify/references/workflows.md"]) {
	try {
		const resource = await handler.resolve(parseInternalUrl(url), { skills });
		read[url] = String(resource.content ?? "").slice(0, 300);
	} catch (error) {
		read[url] = `error: ${error instanceof Error ? error.message : String(error)}`;
	}
}
const breakdown = await session.getContextBreakdown();
console.log(
	JSON.stringify({
		usedTokens: breakdown.usedTokens,
		skillsTokens: breakdown.skillsTokens,
		skills: skills.map(skill => ({
			name: skill.name,
			path: skill.filePath,
			hidden: skill.hide === true || skill.disableModelInvocation === true,
		})),
		read,
	}),
);
process.exit(0);
