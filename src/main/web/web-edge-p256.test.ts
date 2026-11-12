/**
 * The device proof as real browsers make it (docs/rust-remaining-units.md §5.2): Playwright's Chromium and WebKit
 * generate an ECDSA P-256 key with WebCrypto, sign nonces the way the page does (`src/renderer/web/device-key.ts`
 * `signNonce`: ECDSA / SHA-256 over the UTF-8 nonce, raw IEEE P1363, base64url), and the TypeScript verifier accepts them
 * and refuses a tampered nonce, a tampered signature, another key, a DER signature and a wrong length.
 *
 * The signatures are also kept in `native/ompdesk/crates/core/src/web/testdata/browser-p256.json`, which the core's Rust
 * verifier (`web/proof_browsers.rs`) accepts and refuses alike; `OMPDESK_WEB_P256=write` makes the file anew from the
 * installed browsers. A browser that is not installed (`bunx playwright install chromium webkit`) skips its cases.
 * This runs in the node project because the e2e project's global setup needs the built app, which a WebCrypto check does not.
 */
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Browser, chromium, webkit } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { verifyDeviceProof } from "./auth";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FIXTURE = join(resolve(HERE, "../../../native/ompdesk/crates/core/src/web/testdata"), "browser-p256.json");
const WRITE = process.env.OMPDESK_WEB_P256 === "write";
const NONCES = 16;
// Playwright lists the browsers it started in a registry folder under the real home; the home-write guard
// (scripts/vitest-real-home-guard.ts) refuses that, so the registry goes to the temp folder.
const REGISTRY = mkdtempSync(join(tmpdir(), "pw-registry-"));
process.env.PWTEST_SERVER_REGISTRY = REGISTRY;
afterAll(() => rmSync(REGISTRY, { recursive: true, force: true }));

interface Proof {
	nonce: string;
	signature: string;
}
interface Made {
	publicKeyJwk: NodeJsonWebKey;
	otherPublicKeyJwk: NodeJsonWebKey;
	proofs: Proof[];
}

/** Runs in the page: what `createDeviceKey` and `signNonce` do. */
async function inPage(count: number): Promise<Made> {
	const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
	const toBase64Url = (bytes: ArrayBuffer): string => {
		let binary = "";
		for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
		return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	};
	const pair = await crypto.subtle.generateKey(algorithm, false, ["sign", "verify"]);
	const other = await crypto.subtle.generateKey(algorithm, false, ["sign", "verify"]);
	const proofs: Proof[] = [];
	for (let i = 0; i < count; i++) {
		const random = crypto.getRandomValues(new Uint8Array(24));
		const nonce = toBase64Url(random.buffer);
		const signature = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			pair.privateKey,
			new TextEncoder().encode(nonce),
		);
		proofs.push({ nonce, signature: toBase64Url(signature) });
	}
	const jwk = async (key: CryptoKey) => {
		const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", key);
		return { kty, crv, x, y } as NodeJsonWebKey;
	};
	return { publicKeyJwk: await jwk(pair.publicKey), otherPublicKeyJwk: await jwk(other.publicKey), proofs };
}

/** ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }` of a P1363 signature (what OpenSSL's default encoding is). */
function der(p1363: Buffer): Buffer {
	const integer = (bytes: Buffer): Buffer => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		let body = bytes.subarray(start);
		if (body[0] !== undefined && body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
		return Buffer.concat([Buffer.from([0x02, body.length]), body]);
	};
	const parts = Buffer.concat([integer(p1363.subarray(0, 32)), integer(p1363.subarray(32))]);
	return Buffer.concat([Buffer.from([0x30, parts.length]), parts]);
}

async function launch(name: "chromium" | "webkit"): Promise<Browser | null> {
	try {
		return await (name === "chromium" ? chromium : webkit).launch();
	} catch {
		return null;
	}
}

const captured: Record<string, Made> = {};

for (const name of ["chromium", "webkit"] as const) {
	describe(`${name}'s WebCrypto proof`, () => {
		it("is accepted, and refused when anything about it changes", { timeout: 120_000 }, async ctx => {
			const browser = await launch(name);
			if (!browser) return ctx.skip();
			try {
				const page = await browser.newPage();
				// WebCrypto needs a secure context: an https origin the page never reaches.
				await page.route("https://device.example/", route =>
					route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
				);
				await page.goto("https://device.example/");
				const made = await page.evaluate(inPage, NONCES);
				captured[name] = made;
				expect(made.proofs).toHaveLength(NONCES);
				for (const { nonce, signature } of made.proofs) {
					expect(verifyDeviceProof(made.publicKeyJwk, nonce, signature), "valid").toBe(true);
					expect(verifyDeviceProof(made.publicKeyJwk, `${nonce}x`, signature), "tampered nonce").toBe(false);
					const raw = Buffer.from(signature, "base64url");
					expect(raw.length).toBe(64);
					for (const at of [0, 31, 32, 63]) {
						const flipped = Buffer.from(raw);
						flipped[at] = (flipped[at] ?? 0) ^ 0x01;
						expect(
							verifyDeviceProof(made.publicKeyJwk, nonce, flipped.toString("base64url")),
							`bit flipped at ${at}`,
						).toBe(false);
					}
					expect(verifyDeviceProof(made.otherPublicKeyJwk, nonce, signature), "another key").toBe(false);
					expect(verifyDeviceProof(made.publicKeyJwk, nonce, der(raw).toString("base64url")), "DER").toBe(false);
					expect(
						verifyDeviceProof(made.publicKeyJwk, nonce, raw.subarray(0, 63).toString("base64url")),
						"63 bytes",
					).toBe(false);
					expect(
						verifyDeviceProof(
							made.publicKeyJwk,
							nonce,
							Buffer.concat([raw, Buffer.from([0])]).toString("base64url"),
						),
						"65 bytes",
					).toBe(false);
					expect(verifyDeviceProof(made.publicKeyJwk, nonce, ""), "empty").toBe(false);
				}
			} finally {
				await browser.close();
			}
		});
	});
}

describe("the Rust verifier's fixture", () => {
	it.skipIf(!WRITE)("is written from the browsers that ran", () => {
		expect(Object.keys(captured).length).toBeGreaterThan(0);
		writeFileSync(FIXTURE, `${JSON.stringify(captured, null, "\t")}\n`);
	});
});
