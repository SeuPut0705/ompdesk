/**
 * Saved rate-limit resets ("reset passes"): spend one for one stored account
 * through stock's own redeem path (`AgentSession.redeemResetCredit`, what
 * `/usage reset` calls), so stock's in-flight dedupe, Claude idempotency key,
 * credential blocks and usage-cache invalidation all apply. The rules live in
 * reset-passes-core.ts; this module binds them to the live session. The read
 * side (each account's passes) rides on the usage reads in settings.ts.
 *
 * A confirmed pass stock does not spend (Claude names another next, or stock's
 * read of the offer failed) is sent with stock's own offer read and claim
 * request (pi-ai `listClaudeResetCredits`, `consumeClaudeResetCredit`) over
 * the stored account's access, which never leaves this process; when that read
 * fails too, from the account's last usage read (last-reports.ts).
 *
 * Stock helpers are imported inside the guarded method, so a missing export
 * fails only feature `resetPasses` (literal specifiers: see health.ts).
 */
import { getOAuthCredentialProvider } from "@oh-my-pi/pi-ai/oauth";
import { guard } from "./health";
import { lastReport } from "./last-reports";
import { asRecord } from "./params";
import { type ChosenOffer, chosenClaims, redeemResetPass } from "./reset-passes-core";
import type { BridgeMethods } from "./types";

const claims = chosenClaims();

export const methods: BridgeMethods = {
	...guard("resetPasses", {
		reset_pass_redeem: async (params, env) => {
			const { providerId, credentialId, creditId } = asRecord(params);
			if (typeof providerId !== "string" || !providerId) throw new Error("providerId is required");
			if (typeof credentialId !== "number" || !Number.isInteger(credentialId)) {
				throw new Error("credentialId must be an integer");
			}
			if (creditId !== undefined && typeof creditId !== "string") throw new Error("creditId must be a string");
			const session = env.session();
			const { describeRedeemOutcome } = await import("@oh-my-pi/pi-coding-agent/slash-commands/helpers/reset-usage");
			const storage = session.modelRegistry.authStorage;
			return redeemResetPass(
				{
					redeem: target => session.redeemResetCredit(target),
					describe: (outcome, label) => describeRedeemOutcome(outcome, label),
					account: async (provider, id, live) => {
						const access = await storage.oauth.accessById(provider, id);
						if (!access) return { code: "no_account" };
						if (!access.ok) return { code: "account_unavailable" };
						const { listClaudeResetCredits, consumeClaudeResetCredit } = await import("@oh-my-pi/pi-ai");
						const auth = {
							...access,
							baseUrl: session.modelRegistry.getProviderBaseUrl?.(provider),
							// The fetch stock's own reset reads use (auth-storage.ts `usageFetch ?? fetch`).
							fetch: (storage.usage as { fetch?: typeof fetch }).fetch ?? fetch,
						};
						const read = live ? await listClaudeResetCredits(auth) : null;
						const last = read ? undefined : lastReport(provider, id);
						const stored: ChosenOffer | undefined = last?.resetCredits && {
							...last.resetCredits,
							credits: last.resetCredits.credits ?? [],
							storedAt: last.fetchedAt,
						};
						const offer = read ?? stored;
						const orgId = read?.orgId ?? access.orgId ?? last?.metadata?.orgId;
						return {
							...(access.email ? { email: access.email } : {}),
							...(offer ? { offer } : {}),
							spend: (credit, requestId) =>
								consumeClaudeResetCredit({
									...auth,
									baseUrl: read?.baseUrl ?? auth.baseUrl,
									...(typeof orgId === "string" ? { orgId } : {}),
									credit,
									redeemRequestId: requestId,
								}),
						};
					},
					settle: provider => storage.usage.invalidate(provider),
				},
				{
					provider: getOAuthCredentialProvider(providerId),
					credentialId,
					...(creditId ? { creditId } : {}),
				},
				claims,
			);
		},
	}),
};
