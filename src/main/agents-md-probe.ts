/**
 * Run by `agents-md.test.ts` under Bun (stock omp's source needs Bun's runtime): builds a real omp session in the
 * given folder and prints, as one JSON line, the domain rules stock lists, the context files it loads, the session's
 * prompt size and the start of one rule read through `rule://`. Args: `<omp package root> <cwd> <rule to read>`.
 */
export {};

const [packageRoot, cwd, ruleName] = process.argv.slice(2);
// The installed omp's own modules: the package root is only known at run time, so no static import can name them.
const { createAgentSession } = await import(`${packageRoot}/src/sdk.ts`);
const { RuleProtocolHandler } = await import(`${packageRoot}/src/internal-urls/rule-protocol.ts`);
const { parseInternalUrl } = await import(`${packageRoot}/src/internal-urls/parse.ts`);

const { session } = await createAgentSession({ cwd, disableExtensionDiscovery: true });
const prompt: string = (session.systemPrompt as string[]).join("\n");
const domain = prompt.match(/<domain-rules>\n([\s\S]*?)<\/domain-rules>/)?.[1] ?? "";
const listed = [...domain.matchAll(/^- ([^ ]+) \(/gm)].map(match => match[1]);
const contextFiles = [...prompt.matchAll(/<file path="([^"]+)">/g)].map(match => match[1]);
let read = "";
try {
	const resource = await new RuleProtocolHandler().resolve(parseInternalUrl(`rule://${ruleName}`));
	read = String(resource.content ?? "").slice(0, 300);
} catch (error) {
	read = `error: ${error instanceof Error ? error.message : String(error)}`;
}
const breakdown = await session.getContextBreakdown();
console.log(JSON.stringify({ listed, contextFiles, read, usedTokens: breakdown.usedTokens }));
process.exit(0);
