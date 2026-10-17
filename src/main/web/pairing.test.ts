import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPairingRequest } from "../../shared/mobile-web";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";
import { PAIRING_CONFIRM_TIMEOUT_MS, PairingConfirmations } from "./pairing";

describe("PairingConfirmations", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const details = { name: "iPhone", userAgent: "UA", tailscaleLogin: "me@example.com", ip: "100.64.0.2" };

	function rig() {
		const shown: WebPairingRequest[] = [];
		return { shown, confirmations: new PairingConfirmations({ notify: request => shown.push(request) }) };
	}

	it("shows the desktop the phone's details and the default tier, and settles with its approval", async () => {
		const { shown, confirmations } = rig();
		const outcome = confirmations.request(details);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toMatchObject({ ...details, grants: [...DEFAULT_WEB_GRANTS] });
		expect(confirmations.pending()).toHaveLength(1);
		expect(
			confirmations.respond({ id: shown[0]?.id ?? "", approve: true, grants: ["workspace", "pairing-admin"] }),
		).toBe(true);
		await expect(outcome).resolves.toEqual({ approved: true, grants: ["workspace"] });
		expect(confirmations.pending()).toEqual([]);
		expect(confirmations.respond({ id: shown[0]?.id ?? "", approve: true })).toBe(false);
	});

	it("settles declined when the desktop says no", async () => {
		const { shown, confirmations } = rig();
		const outcome = confirmations.request(details);
		confirmations.respond({ id: shown[0]?.id ?? "", approve: false });
		await expect(outcome).resolves.toEqual({ approved: false, reason: "declined" });
	});

	it("times out after 60 s", async () => {
		const { confirmations } = rig();
		const outcome = confirmations.request(details);
		vi.advanceTimersByTime(PAIRING_CONFIRM_TIMEOUT_MS);
		await expect(outcome).resolves.toEqual({ approved: false, reason: "timeout" });
		expect(confirmations.pending()).toEqual([]);
	});

	it("declines everything waiting when the server stops", async () => {
		const { confirmations } = rig();
		const outcomes = [confirmations.request(details), confirmations.request(details)];
		confirmations.declineAll();
		await expect(Promise.all(outcomes)).resolves.toEqual([
			{ approved: false, reason: "declined" },
			{ approved: false, reason: "declined" },
		]);
	});
});
