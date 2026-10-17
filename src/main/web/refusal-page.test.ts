import { describe, expect, it } from "vitest";
import { prefersKorean, type RefusalKind, refusalPage } from "./refusal-page";

const page = (kind: RefusalKind, acceptLanguage?: string, login: string | null = "kim@example.com") =>
	refusalPage({ kind, login, allowed: ["me@example.com", "you@example.com"], acceptLanguage });

describe("refusalPage", () => {
	it("names the account that is signed in and the accounts that may open the page", () => {
		const html = page("user-not-allowed");
		expect(html).toContain('lang="en"');
		expect(html).toContain("This account can&#39;t open OMPdesk");
		expect(html).toContain("kim@example.com");
		expect(html).toContain("me@example.com, you@example.com");
		expect(html).toContain('data-refusal="user-not-allowed"');
	});

	it("speaks Korean to a browser that asks for it first", () => {
		const html = page("user-not-allowed", "ko-KR,ko;q=0.9,en;q=0.8");
		expect(html).toContain('lang="ko"');
		expect(html).toContain("이 계정으로는 열 수 없어요");
		expect(html).toContain("me@example.com, you@example.com");
		expect(prefersKorean("en-US,ko;q=0.5")).toBe(false);
		expect(prefersKorean("ko")).toBe(true);
		expect(prefersKorean(undefined)).toBe(false);
	});

	it("says a tagged device has no account", () => {
		expect(page("no-user", undefined, null)).toContain("has no Tailscale account");
		expect(page("no-user", "ko", null)).toContain("Tailscale 계정이 없는 기기예요");
	});

	it("says a blocked device is blocked, and a blocked login blocks all its devices", () => {
		const node = page("blocked-node", "ko");
		expect(node).toContain("이 기기는 차단됐어요");
		expect(node).not.toContain("kim@example.com");
		const login = page("blocked-login", "ko");
		expect(login).toContain("이 기기는 차단됐어요");
		expect(login).toContain("kim@example.com 계정의 모든 기기");
		expect(page("blocked-login")).toContain("blocked every device of kim@example.com");
		expect(page("blocked-node")).toContain("This device is blocked");
	});

	it("escapes every value it inserts", () => {
		const html = refusalPage({
			kind: "user-not-allowed",
			login: '<script>alert("x")</script>',
			allowed: ["a&b@example.com"],
			acceptLanguage: undefined,
		});
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
		expect(html).toContain("a&amp;b@example.com");
	});
});
