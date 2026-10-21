/**
 * An MCP server's sign-in is no model provider. Stock keeps a managed MCP OAuth token in the same credential store
 * as model accounts, its provider column the credential id (`mcp_oauth:profile:<profile>:<server url>`); the
 * Settings provider list (bridge `providers`) once listed every stored row's provider, so a Higgsfield or Mobbin
 * sign-in showed up under Providers & accounts (the user's report, 21 Oct 2026). Installed omp, private agent dir.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTALLED_OMP, runBridgeProbe } from "./test-bridge-probe";

const PROBE = `
import { methods } from "./settings";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   await session.modelRegistry.authStorage.credentials.set(mcpOAuthCredentialId("https://mcp.example.test/mcp"), {
    type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000,
   });
   await session.modelRegistry.authStorage.credentials.set("openrouter", { type: "api_key", key: "sk-or-test" });
   const { providers } = await methods.providers({}, env);
   console.error("MCP_CRED_PROBE=" + JSON.stringify({ ids: providers.map(provider => provider.id) }));
  } catch (error) {
   console.error("MCP_CRED_PROBE=" + JSON.stringify({ error: String(error?.stack ?? error) }));
  }
 });
}
`;

describe.skipIf(!existsSync(INSTALLED_OMP))("an MCP sign-in in the credential store", () => {
	it("is not listed as a model provider; a model provider's stored key still is", () => {
		const probe = runBridgeProbe(PROBE, "MCP_CRED_PROBE") as { ids?: string[]; error?: string };
		expect(probe.error).toBeUndefined();
		expect(probe.ids).toContain("openrouter");
		expect(probe.ids?.filter(id => id.includes("mcp"))).toEqual([]);
	}, 150_000);
});
