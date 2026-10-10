/** Fake omp schema/catalog exports used by desktop provider e2e; real stock is tested separately. */
const vocabulary: Record<string, string[]> = {
	api: [
		"openai-completions",
		"openai-responses",
		"openai-codex-responses",
		"azure-openai-responses",
		"anthropic-messages",
		"bedrock-converse-stream",
		"google-generative-ai",
		"google-gemini-cli",
		"google-vertex",
	],
	auth: ["apiKey", "none", "oauth"],
	type: ["ollama", "llama.cpp", "lm-studio", "openai-models-list", "proxy", "litellm"],
	mode: ["effort", "budget", "google-level", "anthropic-adaptive", "anthropic-budget-effort"],
	efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
};
export const fixtureProviderOptions = {
	apis: vocabulary.api,
	auth: vocabulary.auth,
	discovery: vocabulary.type,
	thinkingModes: vocabulary.mode,
	efforts: vocabulary.efforts,
};
function schema(keys: Array<string | number> = []) {
	const key = keys.at(-1) === 0 ? keys.at(-2) : keys.at(-1);
	return {
		assert: (config: unknown) => config,
		get: (...path: Array<string | number>) => schema([...keys, ...path]),
		ir: { k: "union", members: (vocabulary[String(key)] ?? []).map(v => ({ k: "lit", v })) },
	};
}
export const ModelsConfigSchema = schema();
export function providerEntries(): Record<string, { id: string }> {
	return Object.fromEntries(["anthropic", "openai", "google", "openai-codex", "fixture"].map(id => [id, { id }]));
}
export function authProviders(): Array<{ id: string }> {
	return [{ id: "anthropic" }, { id: "openai-codex" }];
}
