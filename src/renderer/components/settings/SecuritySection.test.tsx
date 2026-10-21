/**
 * Tests for the Security Center page: the "Scan" button used to write the
 * `security.enabled` master switch as a side effect, so a click that only asked
 * for one scan permanently enabled scan planning and execution.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse, RpcSecurityDashboardResult } from "../../../shared/rpc-types";
import { I18nProvider, loadLocale, setLanguageOverride, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { SecuritySection } from "./SecuritySection";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

function ok(command: string, data?: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

function dashboard(overrides?: Partial<RpcSecurityDashboardResult>): RpcSecurityDashboardResult {
	return {
		enabled: false,
		modelReady: true,
		repositoryRoot: "/tmp/omp-gui-fixtures/demo",
		scans: [],
		operations: [],
		...overrides,
	};
}

const getSecurityDashboard = vi.fn(async (): Promise<RpcResponse> => ok("get_security_dashboard", dashboard()));
const setSetting = vi.fn(async (): Promise<RpcResponse> => ok("set_setting", { value: true }));
const securityStart = vi.fn(async (): Promise<RpcResponse> => ok("security_start", { scanId: "scan-1" }));

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: {
			getSecurityDashboard,
			getSecurityScan: vi.fn(async (): Promise<RpcResponse> => ok("get_security_scan", undefined)),
			securityCancel: vi.fn(async (): Promise<RpcResponse> => ok("security_cancel")),
			securityValidate: vi.fn(async (): Promise<RpcResponse> => ok("security_validate")),
			securitySetDisposition: vi.fn(async (): Promise<RpcResponse> => ok("security_set_disposition")),
			securityStart,
			setSetting,
		},
	},
});

const roots: Root[] = [];

beforeEach(() => {
	useSessionStore.setState({ status: "ready" });
});

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<SecuritySection />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

function buttonWithLabel(label: string): HTMLButtonElement | undefined {
	return (Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[]).find(
		button => (button.textContent ?? "").trim() === label,
	);
}

function bodyText(): string {
	return document.body.textContent ?? "";
}

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	getSecurityDashboard.mockReset();
	getSecurityDashboard.mockResolvedValue(ok("get_security_dashboard", dashboard()));
	setSetting.mockClear();
	securityStart.mockClear();
	useSessionStore.getState().reset();
});

describe("SecuritySection scan", () => {
	it("asks before a scan turns the security switch on", async () => {
		await mount();

		await act(async () => {
			buttonWithLabel(translate("security.scan.workingTree"))?.click();
		});

		expect(setSetting).not.toHaveBeenCalled();
		expect(securityStart).not.toHaveBeenCalled();
		expect(bodyText()).toContain(translate("security.enableScanTitle"));
	});

	it("enables and scans once the confirmation is accepted", async () => {
		await mount();

		await act(async () => {
			buttonWithLabel(translate("security.scan.workingTree"))?.click();
		});
		await act(async () => {
			buttonWithLabel(translate("security.enableScanAction"))?.click();
		});

		expect(setSetting).toHaveBeenCalledWith("security.enabled", true);
		expect(securityStart).toHaveBeenCalledWith({ kind: "working_tree" });
	});

	it("scans without asking once the switch is already on", async () => {
		getSecurityDashboard.mockResolvedValue(ok("get_security_dashboard", dashboard({ enabled: true })));
		await mount();

		await act(async () => {
			buttonWithLabel(translate("security.scan.workingTree"))?.click();
		});

		expect(setSetting).not.toHaveBeenCalled();
		expect(securityStart).toHaveBeenCalledWith({ kind: "working_tree" });
	});
});

describe("SecuritySection with nothing found", () => {
	it("shows no empty risk gauge and no finding-detail placeholders before there is a finding", async () => {
		await mount();

		expect(bodyText()).toContain(translate("security.noScans"));
		expect(bodyText()).not.toContain(translate("security.whyDefault"));
		expect(bodyText()).not.toContain(translate("security.suggestionDefault"));
		expect(document.querySelector("[data-risk-gauge]")).toBeNull();
	});

	describe("says which state the project is in", () => {
		const now = "2026-10-18T00:00:00.000Z";
		const scan = (status: "completed" | "failed" | "partial", findingCount = 0) => ({
			id: "scan",
			status,
			createdAt: now,
			producer: "fixture",
			findingCount,
			target: { kind: "working_tree" as const, displayName: "Working tree" },
		});
		const finding = {
			id: "f1",
			scanId: "scan",
			title: "Untrusted path reaches file access",
			summary: "Isolated finding",
			severity: "high" as const,
			confidence: "high" as const,
			disposition: "open" as const,
			validation: "unvalidated" as const,
			evidence: [],
		};
		const scanned = (status: "completed" | "failed" | "partial", findings: (typeof finding)[] = []) =>
			dashboard({
				enabled: true,
				scans: [scan(status, findings.length)],
				latest: { scan: scan(status, findings.length), findings },
			});
		const STATES: Array<[string, RpcResponse | Error, string]> = [
			["unavailable", new Error("Isolated dashboard unavailable"), translate("security.empty.unavailable")],
			["disabled", ok("get_security_dashboard", dashboard()), translate("security.ready.disabled")],
			[
				"unscanned",
				ok("get_security_dashboard", dashboard({ enabled: true })),
				translate("security.empty.unscanned"),
			],
			[
				"running",
				ok(
					"get_security_dashboard",
					dashboard({
						enabled: true,
						operations: [
							{
								operationId: "op",
								planId: "plan",
								scanId: "scan",
								phase: "reviewing",
								createdAt: now,
								updatedAt: now,
								findingCount: 0,
							},
						],
					}),
				),
				translate("security.empty.running"),
			],
			["failed", ok("get_security_dashboard", scanned("failed")), translate("security.empty.failed")],
			["incomplete", ok("get_security_dashboard", scanned("partial")), translate("security.empty.incomplete")],
			["clear", ok("get_security_dashboard", scanned("completed")), translate("security.empty.title")],
			["findings", ok("get_security_dashboard", scanned("completed", [finding])), finding.title],
		];
		it.each(STATES)("%s", async (state, response, expected) => {
			if (response instanceof Error) getSecurityDashboard.mockRejectedValue(response);
			else getSecurityDashboard.mockResolvedValue(response);
			await mount();
			expect(bodyText()).toContain(expected);
			if (state !== "clear") expect(bodyText()).not.toContain(translate("security.empty.title"));
		});
	});

	it("says when the last scan ran in the UI language", async () => {
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000 - 5_000).toISOString();
		getSecurityDashboard.mockResolvedValue(
			ok(
				"get_security_dashboard",
				dashboard({
					enabled: true,
					scans: [
						{
							id: "scan",
							status: "completed",
							createdAt: fiveMinutesAgo,
							completedAt: fiveMinutesAgo,
							producer: "fixture",
							findingCount: 0,
							target: { kind: "working_tree", displayName: "Working tree" },
						},
					],
				}),
			),
		);
		await loadLocale("ko");
		setLanguageOverride("ko");
		try {
			await mount();
			expect(bodyText()).toContain(translate("security.lastScan", { time: "5분 전" }));
			expect(bodyText()).not.toMatch(/\b5m\b/);
		} finally {
			await act(async () => setLanguageOverride(null));
		}
	});

	it("names the full repository path on hover where the row truncates it", async () => {
		await mount();

		const path = document.querySelector('[title="/tmp/omp-gui-fixtures/demo"]');
		expect(path?.textContent).toBe("/tmp/omp-gui-fixtures/demo");
	});
});
