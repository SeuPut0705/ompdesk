/**
 * Saved rate-limit resets ("reset passes"): spend one for one stored account
 * through stock's own redeem path (`AgentSession.redeemResetCredit`, what
 * `/usage reset` calls), so stock's in-flight dedupe, Claude idempotency key,
 * credential blocks and usage-cache invalidation all apply. The rules live in
 * reset-passes-core.ts; this module binds them to the live session. The read
 * side (each account's passes) rides on the usage reads in settings.ts.
 *
 * Stock helpers are imported inside the guarded method, so a missing export
 * fails only feature `resetPasses` (literal specifiers: see health.ts).
 */
import { getOAuthCredentialProvider } from "@oh-my-pi/pi-ai/oauth";
import { guard } from "./health";
import { redeemResetPass } from "./reset-passes-core";
import type { BridgeMethods } from "./types";

type Rec = Record<string, unknown>;


const asRecord = (value: unknown): Rec => (typeof value === "object" && value !== null ? (value as Rec) : {});

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
			const { toResetUsageAccounts, describeRedeemOutcome } = await import(
				"@oh-my-pi/pi-coding-agent/slash-commands/helpers/reset-usage"
			);
			return redeemResetPass(
				{
					list: provider => session.listResetCredits(undefined, provider),
					accounts: statuses => toResetUsageAccounts(statuses),
					redeem: target => session.redeemResetCredit(target),
					describe: (outcome, label) => describeRedeemOutcome(outcome, label),
				},
				{
					provider: getOAuthCredentialProvider(providerId),
					credentialId,
					...(creditId ? { creditId } : {}),
				},
			);
		},
	}),
};
