/**
 * Run by `ecc-stock.test.ts` under Bun (stock omp's source needs Bun's runtime): builds a real omp session with the
 * given extension roots in the caller's isolated HOME and agent dir, and prints what the ECC pack costs and exposes
 * as one JSON line. Args: `<omp package root> <cwd> <extension root>...`.
 */
export {};

const [packageRoot, cwd, ...roots] = process.argv.slice(2);
// The installed omp's own modules: the package root is only known at run time, so no static import can name them.
const { createAgentSession } = await import(`${packageRoot}/src/sdk.ts`);
const { buildAvailableSlashCommands } = await import(`${packageRoot}/src/slash-commands/available-commands.ts`);
const { SkillProtocolHandler } = await import(`${packageRoot}/src/internal-urls/skill-protocol.ts`);
const { parseInternalUrl } = await import(`${packageRoot}/src/internal-urls/parse.ts`);
const { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } = await import(`${packageRoot}/src/slash-commands/builtin-registry.ts`);

const { session } = await createAgentSession({ cwd, additionalExtensionPaths: roots, disableExtensionDiscovery: true });
const skills: { name: string; filePath: string; hide?: boolean }[] = [...session.skills];
const handler = new SkillProtocolHandler();
const read: Record<string, string> = {};
for (const name of ["ecc", "golang-patterns", "django-tdd"]) {
	try {
		const resource = await handler.resolve(parseInternalUrl(`skill://${name}`), { skills });
		read[name] = String(resource.content ?? "").slice(0, 200);
	} catch (error) {
		read[name] = `error: ${error instanceof Error ? error.message : String(error)}`;
	}
}
const commands: { name: string; source: string }[] = await buildAvailableSlashCommands(session);
const breakdown = await session.getContextBreakdown();
console.log(
	JSON.stringify({
		usedTokens: breakdown.usedTokens,
		skillsTokens: breakdown.skillsTokens,
		skills: skills.map(skill => ({ name: skill.name, path: skill.filePath, hidden: skill.hide === true })),
		commands: commands.map(command => ({ name: command.name, source: command.source })),
		read,
		reserved: [...BUILTIN_SLASH_COMMAND_RESERVED_NAMES],
	}),
);
process.exit(0);
