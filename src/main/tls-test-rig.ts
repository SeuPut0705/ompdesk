/**
 * A certificate authority made for one test and a server certificate it signed for 127.0.0.1 and localhost, for tests
 * that point the core's HTTPS client at a stand-in on loopback: the core trusts the authority through
 * `NODE_EXTRA_CA_CERTS`, as Node's `fetch` did. Written by hand in DER because node can sign but not issue a
 * certificate. Valid for a day from an hour ago: macOS refuses a server certificate valid for more than 825 days.
 */
import { generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

export interface TestCertificates {
	/** The authority, PEM. */
	ca: string;
	/** The server's certificate and its private key, PEM. */
	cert: string;
	key: string;
}

function der(tag: number, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	const n = body.length;
	const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
	return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Buffer[]) => der(0x30, ...parts);

function oid(dotted: string): Buffer {
	const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
	const bytes = [40 * first + second];
	for (let value of rest) {
		const chunk = [value & 0x7f];
		for (value >>>= 7; value; value >>>= 7) chunk.unshift((value & 0x7f) | 0x80);
		bytes.push(...chunk);
	}
	return der(0x06, Buffer.from(bytes));
}

/** UTCTime, `YYMMDDHHMMSSZ`. */
const utcTime = (at: Date) => der(0x17, Buffer.from(`${at.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
const commonName = (name: string) => sequence(der(0x31, sequence(oid("2.5.4.3"), der(0x0c, Buffer.from(name)))));
const extension = (id: string, critical: boolean, value: Buffer) =>
	sequence(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

function certificate(subject: string, issuer: string, publicKey: KeyObject, signer: KeyObject, extensions: Buffer[]) {
	const serial = randomBytes(8);
	serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40;
	const now = Date.now();
	const tbs = sequence(
		der(0xa0, der(0x02, Buffer.from([2]))),
		der(0x02, serial),
		ECDSA_SHA256,
		commonName(issuer),
		sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
		commonName(subject),
		publicKey.export({ type: "spki", format: "der" }),
		der(0xa3, sequence(...extensions)),
	);
	const signature = sign("sha256", tbs, signer);
	const body = sequence(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), signature));
	const lines = body.toString("base64").match(/.{1,64}/g) ?? [];
	return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export function testCertificates(): TestCertificates {
	const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const server = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const ca = certificate("OMPdesk test CA", "OMPdesk test CA", authority.publicKey, authority.privateKey, [
		// basicConstraints CA:TRUE; keyUsage keyCertSign and cRLSign.
		extension("2.5.29.19", true, sequence(der(0x01, Buffer.from([0xff])))),
		extension("2.5.29.15", true, der(0x03, Buffer.from([0x01, 0x06]))),
	]);
	const cert = certificate("127.0.0.1", "OMPdesk test CA", server.publicKey, authority.privateKey, [
		extension("2.5.29.19", false, sequence()),
		// keyUsage digitalSignature; extKeyUsage serverAuth; subjectAltName localhost and 127.0.0.1.
		extension("2.5.29.15", true, der(0x03, Buffer.from([0x07, 0x80]))),
		extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
		extension(
			"2.5.29.17",
			false,
			sequence(der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1]))),
		),
	]);
	return { ca, cert, key: server.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
