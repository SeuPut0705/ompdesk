import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = join(homedir(), ".omp", "agent");
const omp = join(homedir(), ".bun", "bin", "omp");
describe.skipIf(!existsSync(omp) || !existsSync(join(source, "agent.db")))("real stock account/reset adapters", () => {
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
import { storedRoleValue } from "./role-values";
import { reportMatchesActiveAccount } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account";
import { toResetUsageAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/reset-usage";
import { summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { extractExplicitThinkingSelector } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
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
   const limit = {id: "test", scope: {}, amount: {unit: "requests"}};
   const report = {provider: "test", fetchedAt: Date.now(), metadata: {email: "other@example.test", accountId: "same"}, limits: [limit]};
   if (reportMatchesActiveAccount(report, {email: "me@example.test", accountId: "same"})) throw new Error("email must decide");
   if (reportMatchesActiveAccount({...report, metadata: {email: "me@example.test", orgId: "org"}}, {email: "me@example.test"})) throw new Error("org presence gate ignored");
   if (!reportMatchesActiveAccount({...report, metadata: {account_id: "same"}}, {accountId: "same"})) throw new Error("account_id ignored");
   if (!reportMatchesActiveAccount({...report, metadata: {}, limits: [{...limit, scope: {projectId: "project"}}]}, {projectId: "project"})) throw new Error("project scope ignored");
   const codex = {provider: "openai-codex", credentialId: 1, active: false, availableCount: 1, credits: []};
   if (!shapeResetPasses(toResetUsageAccounts([codex])[0])?.redeemable) throw new Error("manual Codex exhaustion gate remained");
   const claude = {...codex, provider: "anthropic", credits: [{id: "unbound", usable: true}]};
   if (shapeResetPasses(toResetUsageAccounts([claude])[0])?.redeemable) throw new Error("Claude pin ignored");
   const expired = {...codex, redeemableCount: 0, credits: [{id: "expired", usable: false, status: "expired", expiresAt: "2000-01-01T00:00:00Z"}]};
   if (shapeResetPasses(toResetUsageAccounts([expired])[0])?.redeemable) throw new Error("expired stock refusal ignored");
   const selector = value => extractExplicitThinkingSelector(value, undefined, {isLiteralModelId: (_provider, id) => id === "literal:max"});
   if (storedRoleValue("advisor", "test/literal:max", selector) !== "test/literal:max:auto") throw new Error("literal max interpreted as thinking");
   if (storedRoleValue("advisor", "test/model:max", selector) !== "test/model:max") throw new Error("explicit max lost");
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
				omp,
				["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
				{
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: isolated,
						PI_CONFIG_DIR: isolated,
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
