import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp, runBridgeProbe } from "./test-bridge-probe";

/**
 * What needs no account of the person's, wherever omp is installed (CI included): stock's selectors on made-up
 * reports and credits, and the account listing of a throwaway credential in an empty private agent dir. Each line
 * names what it would mean when it fails.
 */
const SELECTORS_PROBE = `
import { methods } from "./settings";
import { shapeResetPasses } from "./reset-passes-core";
import { storedRoleValue } from "./role-values";
import { reportMatchesActiveAccount } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account";
import { toResetUsageAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/reset-usage";
import { extractExplicitThinkingSelector } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
export default function(pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = {pi, session: () => session, context: () => undefined, emit: () => {}};
   const failures = [];
   const hold = (what, ok) => { if (!ok) failures.push(what); };
   const limit = {id: "test", scope: {}, amount: {unit: "requests"}};
   const report = {provider: "test", fetchedAt: Date.now(), metadata: {email: "other@example.test", accountId: "same"}, limits: [limit]};
   hold("email must decide", !reportMatchesActiveAccount(report, {email: "me@example.test", accountId: "same"}));
   hold("org presence gate ignored", !reportMatchesActiveAccount({...report, metadata: {email: "me@example.test", orgId: "org"}}, {email: "me@example.test"}));
   hold("account_id ignored", reportMatchesActiveAccount({...report, metadata: {account_id: "same"}}, {accountId: "same"}));
   hold("project scope ignored", reportMatchesActiveAccount({...report, metadata: {}, limits: [{...limit, scope: {projectId: "project"}}]}, {projectId: "project"}));
   const codex = {provider: "openai-codex", credentialId: 1, active: false, availableCount: 1, credits: []};
   hold("manual Codex exhaustion gate remained", shapeResetPasses(toResetUsageAccounts([codex])[0])?.redeemable === true);
   const claude = {...codex, provider: "anthropic", credits: [{id: "unbound", usable: true}]};
   hold("Claude pin ignored", !shapeResetPasses(toResetUsageAccounts([claude])[0])?.redeemable);
   const expired = {...codex, redeemableCount: 0, credits: [{id: "expired", usable: false, status: "expired", expiresAt: "2000-01-01T00:00:00Z"}]};
   hold("expired stock refusal ignored", !shapeResetPasses(toResetUsageAccounts([expired])[0])?.redeemable);
   const selector = value => extractExplicitThinkingSelector(value, undefined, {isLiteralModelId: (_provider, id) => id === "literal:max"});
   hold("literal max interpreted as thinking", storedRoleValue("advisor", "test/literal:max", selector) === "test/literal:max:auto");
   hold("explicit max lost", storedRoleValue("advisor", "test/model:max", selector) === "test/model:max");
   const auth = session.modelRegistry.authStorage;
   const provider = "ompdesk-accounts-probe";
   await auth.credentials.upsert(provider, {type: "api_key", key: "throwaway-not-a-real-key"});
   const stored = auth.credentials.list(provider).map(row => row.id);
   const listed = (await methods.provider_accounts({providerId: provider}, env)).accounts.map(row => row.credentialId);
   console.error("SELECTORS_PROBE=" + JSON.stringify({failures, stored: stored.length, listed: JSON.stringify(listed) === JSON.stringify(stored)}));
   process.exit(0);
  } catch (error) {
   console.error("SELECTORS_PROBE=" + JSON.stringify({ error: String((error && error.stack) || error) }));
   process.exit(1);
  }
 });
}
`;

/**
 * Each shape of credits stock reports (pi-ai usage/*.ts), as made-up reports from a runtime usage provider of made-up
 * API-key providers (stock `UsageService.setProvider`: no request leaves the process), read back through the bridge's
 * `provider_accounts` and `usage`.
 */
const CREDITS_PROBE = `
import { methods } from "./settings";
export default function(pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = {pi, session: () => session, context: () => undefined, emit: () => {}};
   const auth = session.modelRegistry.authStorage;
   const window5h = provider => ({id: provider + ":5h", label: "5 Hour", scope: {provider, windowId: "5h", shared: true}, window: {id: "5h", label: "5 Hour", durationMs: 18000000}, amount: {used: 20, limit: 100, usedFraction: 0.2, unit: "percent"}, status: "ok"});
   const shapes = {
    "ompdesk-credits-balance": provider => [{id: "charm-hyper:credits", label: "Credit balance", scope: {provider, windowId: "balance", shared: true}, amount: {remaining: 1200, unit: "credits"}}],
    "ompdesk-credits-factory": provider => [window5h(provider), {id: "factory-droid:extra-balance", label: "Extra usage balance", scope: {provider}, amount: {used: 0, limit: 12.4, remaining: 12.4, usedFraction: 0, remainingFraction: 1, unit: "usd"}, status: "ok"}],
    "ompdesk-credits-cap": provider => [window5h(provider), {id: "anthropic:extra", label: "Claude Extra Usage", scope: {provider, windowId: "extra"}, amount: {used: 14.8, limit: 50, remaining: 35.2, usedFraction: 0.296, remainingFraction: 0.704, unit: "usd"}, status: "ok"}],
    "ompdesk-credits-uncapped": provider => [{id: "anthropic:extra", label: "Claude Extra Usage", scope: {provider, windowId: "extra"}, amount: {used: 3, unit: "usd"}}],
    "ompdesk-credits-spent": provider => [{id: "anthropic:extra", label: "Claude Extra Usage", scope: {provider, windowId: "extra"}, amount: {used: 50, limit: 50, remaining: 0, usedFraction: 1, remainingFraction: 0, unit: "usd"}, status: "exhausted"}],
    "ompdesk-credits-zero": provider => [{id: "commandcode:balance", label: "Credit balance", scope: {provider, windowId: "balance", shared: true}, amount: {remaining: 0, unit: "credits"}}],
    "ompdesk-credits-none": provider => [window5h(provider)],
   };
   const accounts = {};
   for (const [provider, limits] of Object.entries(shapes)) {
    auth.usage.setProvider(provider, {id: provider, supports: () => true, fetchUsage: async () => ({provider, fetchedAt: Date.now(), limits: limits(provider)})});
    await auth.credentials.upsert(provider, {type: "api_key", key: "throwaway-not-a-real-key"});
    const [account] = (await methods.provider_accounts({providerId: provider}, env)).accounts;
    accounts[provider] = {credits: account?.credits ?? null, limits: account ? account.limits.map(limit => limit.id) : null};
   }
   const factory = (await methods.usage({}, env)).reports.find(report => report.provider === "ompdesk-credits-factory")?.limits.find(limit => limit.id === "factory-droid:extra-balance");
   const balanceShare = factory ? {usedFraction: factory.usedFraction ?? null, used: factory.used ?? null} : "missing";
   console.error("CREDITS_PROBE=" + JSON.stringify({accounts, balanceShare}));
   process.exit(0);
  } catch (error) {
   console.error("CREDITS_PROBE=" + JSON.stringify({ error: String((error && error.stack) || error) }));
   process.exit(1);
  }
 });
}
`;

describe.skipIf(!existsSync(omp))("stock account selectors and listing, with no account of the person's", () => {
	it("matches reports, shapes reset passes, keeps a literal model id and lists a stored credential", () => {
		expect(runBridgeProbe(SELECTORS_PROBE, "SELECTORS_PROBE")).toEqual({ failures: [], stored: 1, listed: true });
	}, 120_000);

	it("passes the credits an account has left and never a gauge of a balance", () => {
		expect(runBridgeProbe(CREDITS_PROBE, "CREDITS_PROBE")).toEqual({
			accounts: {
				"ompdesk-credits-balance": {
					credits: { kind: "balance", limitId: "charm-hyper:credits", remaining: 1200, unit: "credits" },
					limits: [],
				},
				// Factory's balance as a cap of itself (`used: 0`): a balance, never a 0 % window.
				"ompdesk-credits-factory": {
					credits: { kind: "balance", limitId: "factory-droid:extra-balance", remaining: 12.4, unit: "usd" },
					limits: ["ompdesk-credits-factory:5h"],
				},
				// Claude's extra usage: what is left of the month's cap, said as credits and not as a gauge.
				"ompdesk-credits-cap": {
					credits: { kind: "monthlyCap", limitId: "anthropic:extra", remaining: 35.2, limit: 50, unit: "usd" },
					limits: ["ompdesk-credits-cap:5h"],
				},
				"ompdesk-credits-uncapped": { credits: null, limits: [] },
				"ompdesk-credits-spent": { credits: null, limits: [] },
				"ompdesk-credits-zero": { credits: null, limits: [] },
				"ompdesk-credits-none": { credits: null, limits: ["ompdesk-credits-none:5h"] },
			},
			balanceShare: { usedFraction: null, used: null },
		});
	}, 120_000);
});

// The person's own accounts: never on a CI runner, whose home holds only what another test left there.
const source = join(homedir(), ".omp", "agent");
const personsData = existsSync(join(source, "agent.db")) && process.env.GITHUB_ACTIONS !== "true";
describe.skipIf(!existsSync(omp) || !personsData)("real stock account/reset adapters", () => {
	it("preserves account listings, uses stock attribution/reset selectors, and logs out only a throwaway credential", () => {
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-accounts-stock-"));
		chmodSync(isolated, 0o700);
		try {
			for (const name of ["config.yml", "models.yml", "models.yaml"]) {
				if (existsSync(join(source, name))) copyFileSync(join(source, name), join(isolated, name));
			}
			const copied = spawnSync(
				"bun",
				[
					"-e",
					"import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1], {readonly:true}); db.exec('VACUUM INTO ' + JSON.stringify(process.argv[2])); db.close();",
					join(source, "agent.db"),
					join(isolated, "agent.db"),
				],
				{ encoding: "utf8" },
			);
			expect(copied.status).toBe(0);
			cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
			const extension = join(isolated, "bridge", "accounts-probe.ts");
			writeFileSync(
				extension,
				`
import { resolveUsedFraction } from "@oh-my-pi/pi-ai";
import { methods } from "./settings";
import { matchReportAccount } from "./accounts-core";
import { shapeResetPasses } from "./reset-passes-core";
import { reportMatchesActiveAccount } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account";
import { toResetUsageAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/reset-usage";
import { summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";
function oldMatch(report, accounts, count) {
 const identity = report.metadata ?? {};
 const sameOrg = account => identity.orgId === undefined || account.orgId === undefined || account.orgId === identity.orgId;
 const byId = identity.accountId ? accounts.filter(account => sameOrg(account) && account.accountId === identity.accountId) : [];
 if (byId.length === 1) return byId[0];
 const byEmail = typeof identity.email === "string" ? accounts.filter(account => sameOrg(account) && account.email?.toLowerCase() === identity.email.toLowerCase()) : [];
 if (byId.length > 1) { const both = byId.filter(account => byEmail.includes(account)); return both.length === 1 ? both[0] : undefined; }
 if (byEmail.length === 1) return byEmail[0];
 if (!byEmail.length && accounts.length === 1 && count === 1) return accounts[0];
}
export default function(pi) {
 pi.on("session_start", async (_event, context) => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = {pi, session: () => session, context: () => context, emit: () => {}};
   const auth = session.modelRegistry.authStorage;
   await auth.credentials.reload();
   const originalIds = auth.credentials.list().map(row => row.id).sort((a,b) => a-b);
   const providers = [...new Set(auth.credentials.list().map(row => row.provider))];
   let oldAccounts = 0, newAccounts = 0;
   for (const provider of providers) {
    const before = auth.credentials.list(provider).map(row => row.id).sort((a,b) => a-b);
    const result = await methods.provider_accounts({providerId: provider}, env);
    const after = result.accounts.map(row => row.credentialId).sort((a,b) => a-b);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("account listing mismatch");
    oldAccounts += before.length; newAccounts += after.length;
   }
   const raw = await session.fetchUsageReports() ?? [];
   const usage = await methods.usage({}, env);
   let oldAttributed = 0, newAttributed = 0, changedAttribution = 0, oldPasses = 0, newPasses = 0, oldRedeemable = 0, newRedeemable = 0;
   for (const [index, report] of raw.entries()) {
    const accounts = auth.oauth.accounts(report.provider, session.sessionId);
    const count = raw.filter(peer => peer.provider === report.provider).length;
    const old = oldMatch(report, accounts, count);
    const next = matchReportAccount(report, accounts, count, reportMatchesActiveAccount);
    if (usage.reports[index]?.credentialId !== next?.credentialId) throw new Error("wire attribution differs from stock matching");
    oldAttributed += Number(!!old); newAttributed += Number(!!next);
    changedAttribution += Number(old?.credentialId !== next?.credentialId);
    if (report.resetCredits) {
     const summary = summarizeUsageResetCredits(report.resetCredits);
     const status = {...report.resetCredits, provider: report.provider, credentialId: next?.credentialId ?? 0, active: next?.active ?? false, credits: report.resetCredits.credits ?? []};
     const passes = shapeResetPasses(toResetUsageAccounts([status])[0]);
     oldPasses += Number((summary?.bankedCount ?? 0) > 0); newPasses += Number(!!passes);
     const selected = status.nextCreditId ? status.credits.find(credit => credit.id === status.nextCreditId) : status.credits.find(credit => credit.usable !== false) ?? status.credits[0];
     const oldUsable = report.provider === "anthropic" && !status.nextCreditId ? 0 : summary?.redeemableCount ?? 0;
     const clears = selected?.clears?.length ? selected.clears : report.provider === "openai-codex" ? ["openai-codex:primary", "openai-codex:secondary"].filter(id => report.limits.some(limit => limit.id === id)) : [];
     const covered = clears.length > 0 ? report.limits.filter(limit => clears.includes(limit.id)) : report.limits;
     oldRedeemable += Number(oldUsable > 0 && (selected?.requiresLimit !== undefined || covered.some(limit => limit.status === "exhausted" || (resolveUsedFraction(limit) ?? 0) >= 0.999)));
     newRedeemable += Number(passes?.redeemable === true);
    }
   }
   if (usage.reports.length !== raw.length) throw new Error("usage report count mismatch");
   const provider = "ompdesk-logout-probe";
   await auth.credentials.upsert(provider, {type: "api_key", key: "throwaway-not-a-real-key"});
   const added = auth.credentials.list(provider).length;
   await methods.provider_logout({providerId: provider}, env);
   const remaining = auth.credentials.list(provider).length;
   const finalIds = auth.credentials.list().map(row => row.id).sort((a,b) => a-b);
   if (JSON.stringify(originalIds) !== JSON.stringify(finalIds)) throw new Error("logout touched original accounts");
   console.error("ACCOUNT_COUNTS=" + JSON.stringify({oldAccounts, newAccounts, oldReports: raw.length, newReports: usage.reports.length, oldAttributed, newAttributed, changedAttribution, oldPasses, newPasses, oldRedeemable, newRedeemable, throwawayAdded: added, throwawayRemaining: remaining, originalCredentialsRetained: finalIds.length}));
   process.exit(0);
  } catch { console.error("ACCOUNT_PROBE_FAILED"); process.exit(1); }
 });
}
`,
			);
			const result = spawnSync(
				OMP_COMMAND.file,
				[
					...OMP_COMMAND.args,
					"--mode",
					"rpc",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-rules",
					"-e",
					extension,
				],
				{
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: isolated,
						PI_CONFIG_DIR: configDirName(isolated),
						OMP_PROFILE: "",
						PI_PROFILE: "",
					},
					encoding: "utf8",
					timeout: 120_000,
					maxBuffer: 4 * 1024 * 1024,
				},
			);
			expect(
				result.status,
				"Isolated stock account probe failed (diagnostics suppressed to protect identities)",
			).toBe(0);
			const line = result.stderr.split("\n").find(value => value.startsWith("ACCOUNT_COUNTS="));
			if (!line) throw new Error("Stock probe did not return count-only evidence");
			const counts = JSON.parse(line.slice("ACCOUNT_COUNTS=".length)) as Record<string, number>;
			console.info("Stock account diff (counts only)", counts);
			expect(counts.newAccounts).toBe(counts.oldAccounts);
			expect(counts.newReports).toBe(counts.oldReports);
			expect(counts.newPasses).toBe(counts.oldPasses);
			expect(counts.throwawayAdded).toBe(1);
			expect(counts.throwawayRemaining).toBe(0);
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	}, 130_000);
});
