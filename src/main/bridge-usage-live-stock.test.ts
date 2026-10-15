import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the bridge's quota reads to stock's own usage cache, on the installed
 * omp: an empty private agent dir holds throwaway Anthropic and Codex OAuth
 * credentials, and runtime usage providers (stock `usage.setProvider`) stand
 * in for the network, counting probes and recording the base URL each one
 * was keyed by. Nothing reaches a provider and no user data is read.
 *
 * - Settings' `provider_accounts` reads the same cache entry as `usage`
 *   (stock `fetchUsageReports`), which the rate-limit headers of every turn
 *   and credential selection also use: keyed by the provider's base URL.
 * - `refresh` is stock's `usage.invalidate` for a provider whose report is a
 *   minute old or more, and leaves a fresher one alone.
 * - An account whose refreshed probe fails keeps its last report, with that
 *   report's own age, on both reads.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { methods } from "./settings";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const auth = session.modelRegistry.authStorage;
   const expires = Date.now() + 3_600_000;
   await auth.credentials.upsert("anthropic", { type: "oauth", access: "probe-access-not-real", refresh: "probe-refresh-not-real", expires, email: "probe@example.test" });
   await auth.credentials.upsert("openai-codex", { type: "oauth", access: "probe-access-not-real", refresh: "probe-refresh-not-real", expires, email: "codex@example.test", accountId: "probe-codex-account" });
   const probes = { anthropic: 0, codex: 0 };
   const keyedBy = [];
   let anthropicFresh = false;
   let codexFails = false;
   const twoMinutesAgo = () => Date.now() - 120_000;
   const report = (provider, id, fetchedAt, used, credential) => ({
    provider,
    fetchedAt,
    limits: [{ id, label: id, scope: { provider, windowId: "5h", shared: true }, amount: { usedFraction: used, unit: "percent" }, window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: Date.now() + 3_600_000 } }],
    metadata: { email: credential.email, ...(credential.accountId ? { accountId: credential.accountId } : {}) },
   });
   auth.usage.setProvider("anthropic", {
    id: "anthropic",
    async fetchUsage(params) {
     probes.anthropic += 1;
     keyedBy.push(params.baseUrl ?? null);
     return report("anthropic", "anthropic:5h", anthropicFresh ? Date.now() : twoMinutesAgo(), probes.anthropic / 10, params.credential);
    },
   });
   auth.usage.setProvider("openai-codex", {
    id: "openai-codex",
    async fetchUsage(params) {
     probes.codex += 1;
     if (codexFails) throw new Error("429 rate limited");
     return report("openai-codex", "openai-codex:primary", twoMinutesAgo(), 0.5, params.credential);
    },
   });
   const codexOf = result => result.reports.find(entry => entry.provider === "openai-codex");
   const anthropicOf = result => result.reports.find(entry => entry.provider === "anthropic");
   const usage = await methods.usage({}, env);
   const accounts = await methods.provider_accounts({ providerId: "anthropic" }, env);
   const afterReads = { ...probes };
   anthropicFresh = true;
   const refreshed = await methods.provider_accounts({ providerId: "anthropic", refresh: true }, env);
   const afterStaleRefresh = { ...probes };
   await methods.provider_accounts({ providerId: "anthropic", refresh: true }, env);
   const afterFreshRefresh = { ...probes };
   codexFails = true;
   const failedRefresh = await methods.usage({ refresh: true }, env);
   const afterFailedRefresh = { ...probes };
   const codexAccounts = await methods.provider_accounts({ providerId: "openai-codex" }, env);
   console.error("USAGE_PROBE=" + JSON.stringify({
    baseUrl: session.modelRegistry.getProviderBaseUrl("anthropic") ?? null,
    keyedBy,
    afterReads,
    afterStaleRefresh,
    afterFreshRefresh,
    afterFailedRefresh,
    usageFetchedAt: anthropicOf(usage)?.fetchedAt ?? null,
    accountFetchedAt: accounts.accounts[0]?.fetchedAt ?? null,
    accountUsed: accounts.accounts[0]?.limits[0]?.usedFraction ?? null,
    refreshedAge: Date.now() - (refreshed.accounts[0]?.fetchedAt ?? 0),
    codexBefore: codexOf(usage)?.fetchedAt ?? null,
    codexAfterFailedRefresh: codexOf(failedRefresh)?.fetchedAt ?? null,
    codexAccountAfterFailedRefresh: codexAccounts.accounts[0]?.fetchedAt ?? null,
    codexAccountUsed: codexAccounts.accounts[0]?.limits[0]?.usedFraction ?? null,
   }));
   process.exit(0);
  } catch (error) {
   console.error("USAGE_PROBE_FAILED " + (error instanceof Error ? error.message : String(error)));
   process.exit(1);
  }
 });
}
`;

describe.skipIf(!existsSync(omp))("bridge quota reads on stock's usage cache", () => {
	it("reads Settings' accounts from the base-URL entry every other usage reader shares, refreshes stale ones through invalidate, and never blanks a failed one", () => {
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-usage-live-"));
		chmodSync(isolated, 0o700);
		try {
			cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
			const extension = join(isolated, "bridge", "usage-live-probe.ts");
			writeFileSync(extension, PROBE);
			// A throwaway OpenAI key only gives the session a default model; nothing is prompted.
			const env: Record<string, string | undefined> = {
				...process.env,
				PI_CODING_AGENT_DIR: isolated,
				PI_CONFIG_DIR: isolated,
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OPENAI_API_KEY: "probe-not-a-real-key",
			};
			// An Anthropic key from the shell would add a second credential to probe.
			for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
				Reflect.deleteProperty(env, key);
			}
			const result = spawnSync(
				omp,
				["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
				{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
			);
			const line = result.stderr.split("\n").find(value => value.startsWith("USAGE_PROBE"));
			expect(line, result.stderr.slice(-2000)).toMatch(/^USAGE_PROBE=/);
			const probe = JSON.parse(line?.slice("USAGE_PROBE=".length) ?? "{}") as Record<string, unknown>;
			expect(probe.baseUrl).toEqual(expect.stringMatching(/^https:\/\//));
			// Every probe keyed by the provider's base URL: no second, header-blind `default` entry.
			expect(new Set(probe.keyedBy as unknown[])).toEqual(new Set([probe.baseUrl]));
			// One probe served both reads: Settings shows exactly what Stats › Usage shows.
			expect(probe.afterReads).toEqual({ anthropic: 1, codex: 1 });
			expect(probe.accountFetchedAt).toBe(probe.usageFetchedAt);
			expect(probe.accountUsed).toBe(0.1);
			// A two-minute-old report: refresh drops stock's cache and the account is probed now.
			expect(probe.afterStaleRefresh).toEqual({ anthropic: 2, codex: 1 });
			expect(probe.refreshedAge).toBeLessThan(10_000);
			// A fresh report answers the next refresh as it is.
			expect(probe.afterFreshRefresh).toEqual({ anthropic: 2, codex: 1 });
			// Codex was stale, so it was probed; the probe failed, and both reads keep its last report and age.
			expect(probe.afterFailedRefresh).toEqual({ anthropic: 2, codex: 2 });
			expect(probe.codexAfterFailedRefresh).toBe(probe.codexBefore);
			expect(probe.codexAccountAfterFailedRefresh).toBe(probe.codexBefore);
			expect(probe.codexAccountUsed).toBe(0.5);
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	}, 130_000);
});
