import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPairingRequest } from "../../shared/mobile-web";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";
import { normalizeCode } from "../remote/crypto";
import {
	MAX_PAIRING_FAILURES,
	PAIRING_CODE_TTL_MS,
	PAIRING_CONFIRM_TIMEOUT_MS,
	PairingConfirmations,
	WebPairing,
} from "./pairing";

describe("WebPairing", () => {
	it("answers inactive until a code is issued, then accepts it once", () => {
		const pairing = new WebPairing();
		expect(pairing.attempt("ABCD-EFGH")).toBe("inactive");
		const { code } = pairing.issue();
		expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		expect(pairing.active()?.code).toBe(code);
		expect(pairing.attempt(code.toLowerCase())).toBe("ok");
		expect(pairing.attempt(code)).toBe("inactive");
		expect(pairing.active()).toBeNull();
	});

	it("is its own code generator, not the remote host's", () => {
		const first = new WebPairing().issue().code;
		const second = new WebPairing().issue().code;
		expect(normalizeCode(first)).not.toBeNull();
		expect(first).not.toBe(second);
	});

	it("expires after ten minutes", () => {
		let now = 0;
		const pairing = new WebPairing(() => now);
		const { code } = pairing.issue();
		now = PAIRING_CODE_TTL_MS - 1;
		expect(pairing.active()).not.toBeNull();
		now = PAIRING_CODE_TTL_MS;
		expect(pairing.attempt(code)).toBe("inactive");
	});

	it("replaces an unused code with a new one", () => {
		const pairing = new WebPairing();
		const old = pairing.issue().code;
		const fresh = pairing.issue().code;
		expect(pairing.attempt(old)).toBe("wrong");
		expect(pairing.attempt(fresh)).toBe("ok");
	});

	it("locks and replaces the code at the fifth wrong try", () => {
		const onChange = vi.fn();
		const pairing = new WebPairing(Date.now, onChange);
		const { code } = pairing.issue();
		for (let i = 1; i < MAX_PAIRING_FAILURES; i++) expect(pairing.attempt("0000-0000")).toBe("wrong");
		expect(pairing.attempt("0000-0000")).toBe("locked");
		expect(pairing.attempt(code)).toBe("wrong");
		expect(pairing.active()?.code).not.toBe(code);
		expect(onChange).toHaveBeenCalled();
	});

	it("counts a malformed code as wrong and can be cleared", () => {
		const pairing = new WebPairing();
		pairing.issue();
		expect(pairing.attempt("short")).toBe("wrong");
		pairing.clear();
		expect(pairing.attempt("short")).toBe("inactive");
	});
});

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
