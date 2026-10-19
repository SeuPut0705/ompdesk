import { describe, expect, it } from "vitest";
import { redactDiagnosticsText as redact, redactDiagnosticsFile } from "./redactor";

describe("redactDiagnosticsText: credentials", () => {
	it("redacts GitHub tokens in every prefix", () => {
		for (const token of [
			`ghp_${"a1B2".repeat(9)}`,
			`gho_${"x9Y8".repeat(6)}`,
			`ghs_${"Q".repeat(30)}`,
			`github_pat_11ABCDEFG0${"k".repeat(30)}_${"z".repeat(20)}`,
		]) {
			expect(redact(`auth failed with ${token} for repo`)).toBe("auth failed with <token> for repo");
		}
	});

	it("redacts sk- keys including provider-prefixed ones", () => {
		expect(redact("key sk-ant-api03-AbCdEf0123456789_xyz-AbCdEf")).toBe("key <token>");
		expect(redact("sk-proj-0123456789abcdefABCDEF")).toBe("<token>");
	});

	it("redacts Bearer values and keeps the scheme word", () => {
		expect(redact("Authorization: Bearer abc.DEF-123_456~xyz+/=")).not.toContain("abc.DEF");
		expect(redact("header Bearer 8f14e45fceea167a")).toBe("header Bearer <token>");
	});

	it("redacts JWTs", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		expect(redact(`token ${jwt} end`)).toBe("token <token> end");
		expect(redact(`session=${jwt}`)).not.toContain("eyJ");
	});

	it("redacts other vendor keys", () => {
		expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe("<token>");
		expect(redact("xoxb-1234567890-abcdefghij")).toBe("<token>");
		expect(redact(`AIza${"a".repeat(35)}`)).toBe("<token>");
	});

	it("redacts key=value secrets in env, YAML, JSON and escaped JSON, keeping the key", () => {
		expect(redact("OPENAI_API_KEY=hunter2hunter2")).toBe("OPENAI_API_KEY=<secret>");
		expect(redact("password: correcthorse")).toBe("password: <secret>");
		expect(redact('{"client_secret":"abc def","a":1}')).toBe('{"client_secret":<secret>,"a":1}');
		expect(redact('{"message":"got \\"token\\":\\"abcd1234\\" back"}')).not.toContain("abcd1234");
		expect(redact("GET /x?access_token=abc123&other=1")).toBe("GET /x?access_token=<secret>&other=1");
		expect(redact("refreshToken = 'a b c'")).toBe("refreshToken = <secret>");
	});

	it("redacts PEM blocks, one at a time, and a block whose end was cut off", () => {
		const block = (body: string) => `-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----`;
		expect(redact(`a ${block("MIIEvQIBADANBgkq")} b ${block("QWxsb3dlZA")} c`)).toBe("a <secret> b <secret> c");
		expect(redact("key -----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA…")).toBe("key <secret>");
	});

	it("redacts URL credentials", () => {
		expect(redact("clone https://alice:s3cret@github.com/o/r.git")).toBe("clone https://<secret>@github.com/o/r.git");
	});

	it("redacts long hex and long mixed base64 runs", () => {
		expect(redact(`key ${"0123456789abcdef".repeat(4)} end`)).toBe("key <token> end");
		expect(redact("secret dGhpc0lzQVZlcnlMb25nQmFzZTY0U2VjcmV0VmFsdWUxMjM0 x")).toContain("<");
		expect(redact("blob aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6kL9n")).toBe("blob <token>");
	});
});

describe("redactDiagnosticsText: credentials, false positives", () => {
	it("keeps versions, UUIDs, short hashes and counts", () => {
		const text = [
			"OMPdesk 0.35.1 omp 18.11.1 Electron 36.4.0 Chrome 136.0.7103.113 Node 22.16.0",
			"Windows 10.0.22631.4890 build 1.2.3.4 v10.1.2.3",
			"session 550e8400-e29b-41d4-a716-446655440000 and 550E8400-E29B-41D4-A716-446655440000",
			"commit e4c6599 on branch omp/agent/orca-hygiene",
			"maxTokens: 4096 totalTokens=1234 tokens: 12 hasToken: false token: null",
			"ordinary words stay: password manager, secret santa, tokenizer",
		].join("\n");
		expect(redact(text)).toBe(text);
	});

	it("keeps long paths, kebab identifiers and camelCase names", () => {
		const text =
			"~/.omp/wt/gui-orca-hygiene-540bd7d/node_modules/@oh-my-pi/pi-coding-agent/src/UpdatesSectionRow2 useMachineSetupStoreForTheWholeApp";
		expect(redact(text)).toBe(text);
	});

	it("keeps an empty or already redacted value", () => {
		expect(redact("token=<token> password=")).toBe("token=<token> password=");
	});
});

describe("redactDiagnosticsText: emails", () => {
	it("redacts addresses and keeps ssh's git@ user and scoped package names", () => {
		expect(redact("from Alice.Smith+x@example.co.uk, cc bob@corp.example.com")).toBe("from <email>, cc <email>");
		expect(redact("git@github.com:SeuPut0705/ompdesk.git")).toBe("git@github.com:SeuPut0705/ompdesk.git");
		expect(redact("@oh-my-pi/pi-coding-agent@18.11.1 foo@latest")).toBe(
			"@oh-my-pi/pi-coding-agent@18.11.1 foo@latest",
		);
		expect(redact("12345+alice@users.noreply.github.com")).toBe("<email>");
	});
});

describe("redactDiagnosticsText: addresses", () => {
	it("redacts the whole tailnet IPv4 range and only it", () => {
		expect(redact("peer 100.64.0.1 100.101.102.103 100.127.255.254")).toBe(
			"peer <tailnet-ip> <tailnet-ip> <tailnet-ip>",
		);
		expect(redact("100.63.255.255 100.128.0.1")).toBe("100.63.255.255 100.128.0.1");
	});

	it("redacts tailnet names", () => {
		expect(redact("https://macbook-pro.tail1234.ts.net:443/pair")).toBe("https://<tailnet-host>:443/pair");
		expect(redact("host.TS.NET")).toBe("<tailnet-host>");
		expect(redact("ts.net is mentioned, not a host; nets.ts.example")).toBe(
			"ts.net is mentioned, not a host; nets.ts.example",
		);
	});

	it("redacts private IPv4 ranges with ports and keeps their edges", () => {
		expect(redact("10.0.0.5 10.255.1.2 192.168.1.20:47831 172.16.0.1 172.31.255.9")).toBe(
			"<lan-ip> <lan-ip> <lan-ip>:47831 <lan-ip> <lan-ip>",
		);
		expect(redact("172.15.0.1 172.32.0.1 192.169.0.1 11.0.0.1")).toBe("172.15.0.1 172.32.0.1 192.169.0.1 11.0.0.1");
	});

	it("keeps loopback, public and non-address dotted numbers", () => {
		const text = "127.0.0.1 8.8.8.8 1.2.3.4 10.0.22631.4890 192.168.999.1 v10.1.2.3 x10.1.2.3 10.1.2.3.4";
		expect(redact(text)).toBe(text);
	});

	it("redacts IPv6 link-local and unique-local addresses, tailnet ULA included", () => {
		expect(redact("fe80::1ff:fe23:4567:890a%en0")).toBe("<lan-ip>");
		expect(redact("fd12:3456:789a::1")).toBe("<lan-ip>");
		expect(redact("fd7a:115c:a1e0:ab12:4843:cd96:6258:1234")).toBe("<tailnet-ip>");
		expect(redact("2001:db8::1 ::1 12:34:56 fd:00")).toBe("2001:db8::1 ::1 12:34:56 fd:00");
	});
});

describe("redactDiagnosticsText: home paths", () => {
	it("collapses macOS and Windows homes to ~", () => {
		expect(redact("/Users/seuput/.omp/wt/x")).toBe("~/.omp/wt/x");
		expect(redact("C:\\Users\\Jane Doe\\Documents\\x")).toBe("~\\Documents\\x");
		expect(redact("opened C:\\Users\\bob in the editor")).toBe("opened ~ in the editor");
		expect(redact("C:\\Users\\seuput\\AppData\\Roaming\\ompdesk")).toBe("~\\AppData\\Roaming\\ompdesk");
		expect(redact("D:/Users/김스풋/work")).toBe("~/work");
		expect(redact("file:///Users/seuput/a.txt")).toBe("file://~/a.txt");
	});

	it("collapses JSON-escaped Windows paths", () => {
		expect(redact('{"cwd":"C:\\\\Users\\\\seuput\\\\proj"}')).toBe('{"cwd":"~\\\\proj"}');
	});

	it("keeps shared profile folders and unrelated words", () => {
		const text = "/Users/Shared/x C:\\Users\\Public\\y the Users guide /usr/local/bin";
		expect(redact(text)).toBe(text);
	});
});

describe("redactDiagnosticsText: a runtime log line", () => {
	it("redacts every kind in one JSONL entry", () => {
		const line = JSON.stringify({
			timestamp: "2026-10-18T14:33:40.123Z",
			appVersion: "0.35.1",
			cwd: "/Users/seuput/proj",
			message: `fetch http://100.101.5.6:47831 failed for seuput@example.com with ghp_${"a".repeat(36)}`,
		});
		const out = redact(line);
		expect(out).toContain('"timestamp":"2026-10-18T14:33:40.123Z"');
		expect(out).toContain('"appVersion":"0.35.1"');
		expect(out).toContain('"cwd":"~/proj"');
		expect(out).toContain("http://<tailnet-ip>:47831");
		expect(out).toContain("<email>");
		expect(out).toContain("<token>");
		expect(JSON.parse(out)).toBeTruthy();
	});
});

describe("redactDiagnosticsFile: a diagnostic bundle's members", () => {
	const request = {
		systemPrompt: "cwd /Users/jane/proj",
		apiKey: "hunter2-hunter2",
		credentials: { type: "oauth", tokens: 3 },
		maxTokens: 4096,
		messages: [{ content: "mail jane@example.com" }],
	};

	it("keeps a .json member valid JSON in stock's layout, blanking a field that names a secret", () => {
		const text = `${JSON.stringify(request, null, 2)}\n`;
		const out = redactDiagnosticsFile("llm-request.json", text);
		expect(JSON.parse(out)).toEqual({
			systemPrompt: "cwd ~/proj",
			apiKey: "<secret>",
			credentials: { type: "oauth", tokens: 3 },
			maxTokens: 4096,
			messages: [{ content: "mail <email>" }],
		});
		expect(out).toMatch(/^\{\n {2}"systemPrompt"/);
		expect(out.endsWith("}\n")).toBe(true);
		// Plain text redaction would have broken the object under `credentials`.
		expect(() => JSON.parse(redact(text))).toThrow();
	});

	it("redacts a .jsonl member line by line, and a line that is not JSON as text", () => {
		const out = redactDiagnosticsFile("session.jsonl", `${JSON.stringify(request)}\nraw /Users/jane/x\n`);
		const [first, second, last] = out.split("\n");
		expect(JSON.parse(first ?? "")).toMatchObject({ apiKey: "<secret>", systemPrompt: "cwd ~/proj" });
		expect(second).toBe("raw ~/x");
		expect(last).toBe("");
	});

	it("redacts a .json member that does not parse, and any other member, as text", () => {
		expect(redactDiagnosticsFile("llm-request.json", '{"cut": "/Users/jane/x')).toBe('{"cut": "~/x');
		expect(redactDiagnosticsFile("session.md", "token=abc123def from /Users/jane")).toBe("token=<secret> from ~");
	});
});
