/** Main-side worker: which stock providers have a stored credential (src/main/cli-tools/updater.ts). */
import * as path from "node:path";

interface StockAuthStorage {
	credentials: {
		reload(): Promise<void>;
		list(): ReadonlyArray<{ provider?: unknown }>;
	};
	close?(): void;
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
		const storage = await sdk.discoverAuthStorage();
		try {
			await storage.credentials.reload();
			const providers = storage.credentials
				.list()
				.map(row => row.provider)
				.filter((provider): provider is string => typeof provider === "string");
			return { providers: [...new Set(providers)] };
		} finally {
			storage.close?.();
		}
	},
};
