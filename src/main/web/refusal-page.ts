/**
 * The page a browser sees when the server turns it away for a reason it can act on: its Tailscale account is not
 * one of the allowed ones (which account to use is named), it has no account at all (a tagged device), or the user
 * blocked this device (or its whole login) on the computer. Plain HTML with inline style only (the page's CSP
 * allows nothing else), in Korean or English by `Accept-Language`, every inserted value escaped.
 */
export type RefusalKind = "user-not-allowed" | "no-user" | "blocked-node" | "blocked-login";

export interface RefusalDetails {
	kind: RefusalKind;
	/** The Tailscale login the request came with (null for none). */
	login: string | null;
	/** The logins that may open the page. */
	allowed: readonly string[];
	acceptLanguage: string | undefined;
}

interface Text {
	title: string;
	body: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char] ?? char);
}

/** Korean when the browser asks for it first, else English. */
export function prefersKorean(acceptLanguage: string | undefined): boolean {
	const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
	return first === "ko" || first.startsWith("ko-");
}

function textFor(korean: boolean, details: RefusalDetails): Text {
	const accounts = details.allowed.join(", ");
	const login = details.login ?? "";
	switch (details.kind) {
		case "user-not-allowed":
			return korean
				? {
						title: "이 계정으로는 열 수 없어요",
						body: `이 기기는 Tailscale에 ${login} 계정으로 로그인돼 있어요. OMPdesk는 ${accounts} 계정에서만 열려요. Tailscale 앱에서 그 계정으로 로그인한 뒤 다시 열어 주세요.`,
					}
				: {
						title: "This account can't open OMPdesk",
						body: `This device is signed in to Tailscale as ${login}. OMPdesk opens only for ${accounts}. Sign in to that account in the Tailscale app, then open this page again.`,
					};
		case "no-user":
			return korean
				? {
						title: "Tailscale 계정이 없는 기기예요",
						body: `태그된 기기는 계정이 없어서 열 수 없어요. ${accounts} 계정으로 로그인한 기기에서 열어 주세요.`,
					}
				: {
						title: "This device has no Tailscale account",
						body: `A tagged device has no account, so it can't open OMPdesk. Open it on a device signed in as ${accounts}.`,
					};
		case "blocked-node":
			return korean
				? {
						title: "이 기기는 차단됐어요",
						body: "컴퓨터의 OMPdesk에서 이 기기를 차단했어요. 다시 쓰려면 컴퓨터에서 차단을 풀어 주세요.",
					}
				: {
						title: "This device is blocked",
						body: "OMPdesk on your computer blocked this device. To use it again, unblock it on your computer.",
					};
		case "blocked-login":
			return korean
				? {
						title: "이 기기는 차단됐어요",
						body: `컴퓨터의 OMPdesk가 ${login} 계정의 모든 기기를 차단했어요. 다시 쓰려면 컴퓨터에서 차단을 풀어 주세요.`,
					}
				: {
						title: "This device is blocked",
						body: `OMPdesk on your computer blocked every device of ${login}. To use it again, unblock it on your computer.`,
					};
	}
}

/** The whole HTML document. */
export function refusalPage(details: RefusalDetails): string {
	const korean = prefersKorean(details.acceptLanguage);
	const { title, body } = textFor(korean, details);
	return `<!doctype html>
<html lang="${korean ? "ko" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px}main{max-width:26rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:GrayText;overflow-wrap:anywhere}</style>
</head>
<body>
<main data-refusal="${details.kind}">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
</main>
</body>
</html>
`;
}
