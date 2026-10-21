/** Main-side worker: which stock providers have a stored credential (src/main/cli-tools/updater.ts). */
import * as path from "node:path";

interface StockAuthStorage {
	credentials: {
		reload(): Promise<void>;
		list(): ReadonlyArray<{ provider?: unknown }>;
	};
	close?(): void;
}

/**
 * Stock's own test for an MCP server's sign-in, which shares the credential store with model accounts (its
 * provider column is the credential id, `mcp_oauth:profile:<profile>:<url>`): no model provider, no first-run
 * sign-in. From the user's omp installation, as the store is.
 */
async function mcpCredentialTest(root: string): Promise<(provider: string) => boolean> {
	const flow = (await import(
		Bun.resolveSync("@oh-my-pi/pi-coding-agent/mcp/oauth-flow", path.join(root, "package.json"))
	)) as {
		isManagedMCPOAuthCredentialId?: (id: string | undefined) => boolean;
	};
	if (typeof flow.isManagedMCPOAuthCredentialId !== "function")
		throw new Error("Installed omp has no isManagedMCPOAuthCredentialId");
	return flow.isManagedMCPOAuthCredentialId;
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	/**
	 * The providers with at least one stored credential row, through stock's own `discoverAuthStorage`
	 * (the user's agent dir and broker, exactly what omp reads). Ids only: no token or identity leaves
	 * this worker. The store is opened for the call and closed again, so no sqlite handle outlives it.
	 */
	"accounts.providers": async () => {
		const root = process.env.OMP_PACKAGE_ROOT;
		if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
		// Runtime-selected: the credential store belongs to the user's resolved omp installation.
		const sdk = (await import(Bun.resolveSync("@oh-my-pi/pi-coding-agent/sdk", path.join(root, "package.json")))) as {
			discoverAuthStorage?: () => Promise<StockAuthStorage>;
		};
		if (typeof sdk.discoverAuthStorage !== "function") throw new Error("Installed omp has no discoverAuthStorage");
		const isMcp = await mcpCredentialTest(root);
		const storage = await sdk.discoverAuthStorage();
		try {
			await storage.credentials.reload();
			const providers = storage.credentials
				.list()
				.map(row => row.provider)
				.filter((provider): provider is string => typeof provider === "string" && !isMcp(provider));
			return { providers: [...new Set(providers)] };
		} finally {
			storage.close?.();
		}
	},
	/**
	 * Whether omp holds any credential at all: a stored one (stock `discoverAuthStorage`, as above) or an API
	 * key stock reads from the environment (`listProvidersWithEnvKey` / `getEnvApiKey`, stock's own map;
	 * `env` is the login-shell environment main hands omp, applied for the call). None means a true first run:
	 * the first-run provider step opens while omp still boots. A yes/no only: nothing else leaves the worker.
	 */
	"accounts.signedIn": async params => {
		const root = process.env.OMP_PACKAGE_ROOT;
		if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
		const env = params && typeof params === "object" && "env" in params ? params.env : undefined;
		if (env && typeof env === "object") {
			for (const [key, value] of Object.entries(env)) {
				if (typeof value === "string" && process.env[key] === undefined) process.env[key] = value;
			}
		}
		const resolve = (specifier: string) => Bun.resolveSync(specifier, path.join(root, "package.json"));
		// Runtime-selected: the credential store and env map belong to the user's resolved omp installation.
		const [sdk, ai] = (await Promise.all([
			import(resolve("@oh-my-pi/pi-coding-agent/sdk")),
			import(resolve("@oh-my-pi/pi-ai")),
		])) as [
			{ discoverAuthStorage?: () => Promise<StockAuthStorage> },
			{ listProvidersWithEnvKey?: () => string[]; getEnvApiKey?: (provider: string) => string | undefined },
		];
		if (typeof sdk.discoverAuthStorage !== "function") throw new Error("Installed omp has no discoverAuthStorage");
		if (typeof ai.listProvidersWithEnvKey !== "function" || typeof ai.getEnvApiKey !== "function")
			throw new Error("Installed omp has no getEnvApiKey");
		const getEnvApiKey = ai.getEnvApiKey;
		if (ai.listProvidersWithEnvKey().some(provider => getEnvApiKey(provider))) return { signedIn: true };
		const isMcp = await mcpCredentialTest(root);
		const storage = await sdk.discoverAuthStorage();
		try {
			await storage.credentials.reload();
			const models = storage.credentials
				.list()
				.filter(row => typeof row.provider !== "string" || !isMcp(row.provider));
			return { signedIn: models.length > 0 };
		} finally {
			storage.close?.();
		}
	},
};
