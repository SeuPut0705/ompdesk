/**
 * Message shapes of the remote-device protocol, validated at the socket
 * boundary. `HANDSHAKE_VERSION` is the `v` of pair-init/auth-init;
 * `PROTOCOL_VERSION` is the `protocol` of the encrypted hello.
 */
import { z } from "zod";
import { authTranscript, isRawKey, pairTranscript } from "./crypto";

export const HANDSHAKE_VERSION = 1;
export const PROTOCOL_VERSION = 1;

/** Pairing failures the host reports in `pair-fail`. */
export const PAIR_FAIL_CODES = ["wrong_code", "expired", "locked"] as const;
export type PairFailCode = (typeof PAIR_FAIL_CODES)[number];

const rawKey = z.string().refine(isRawKey, "not a raw X25519 key");
const deviceId = z.string().min(1).max(64);
const deviceName = z.string().max(256);
const mac = z.string().max(64);

/** First frame of any connection; `v` is checked before the full shape. */
export const Opening = z.object({ t: z.enum(["pair-init", "auth-init"]), v: z.unknown() });

export const PairInit = z.object({
	t: z.literal("pair-init"),
	v: z.number(),
	deviceId,
	name: deviceName,
	ephPub: rawKey,
	staticPub: rawKey,
});
export type PairInit = z.infer<typeof PairInit>;

export const PairChallenge = z.object({
	t: z.literal("pair-challenge"),
	deviceId,
	name: deviceName,
	ephPub: rawKey,
	staticPub: rawKey,
});
export type PairChallenge = z.infer<typeof PairChallenge>;

export const PairProof = z.object({ t: z.literal("pair-proof"), mac });

export const ErrorMessage = z.object({ t: z.literal("error"), code: z.string().max(64) });

export const PairResult = z.discriminatedUnion("t", [
	z.object({ t: z.literal("pair-ok"), mac }),
	z.object({ t: z.literal("pair-fail"), code: z.enum(PAIR_FAIL_CODES) }),
	ErrorMessage,
]);

export const AuthInit = z.object({ t: z.literal("auth-init"), v: z.number(), deviceId, ephPub: rawKey });
export type AuthInit = z.infer<typeof AuthInit>;

export const AuthReply = z.discriminatedUnion("t", [
	z.object({ t: z.literal("auth-resp"), deviceId, ephPub: rawKey }),
	z.object({ t: z.literal("auth-fail"), code: z.string().max(64) }),
	ErrorMessage,
]);

/** Any hello; `protocol` is checked before the side-specific shape. */
export const HelloVersion = z.object({ t: z.literal("hello"), protocol: z.unknown() });

export const ClientHello = z.object({
	t: z.literal("hello"),
	protocol: z.number(),
	appVersion: z.string().max(64),
	name: deviceName,
});

export const HostHelloMessage = z.object({
	t: z.literal("hello"),
	protocol: z.number(),
	appVersion: z.string().max(64),
	name: deviceName,
	platform: z.string().max(32),
	ompVersion: z.string().max(64).nullable(),
	home: z.string(),
	sep: z.string().max(1),
});

export const WireRequest = z.object({
	t: z.literal("req"),
	id: z.number().int().nonnegative(),
	method: z.string().min(1).max(128),
	params: z.unknown(),
});

export const WireResponse = z.discriminatedUnion("ok", [
	z.object({ t: z.literal("res"), id: z.number(), ok: z.literal(true), result: z.unknown() }),
	z.object({
		t: z.literal("res"),
		id: z.number(),
		ok: z.literal(false),
		error: z.object({ code: z.string(), message: z.string() }),
	}),
]);

export const WireEvent = z.object({ t: z.literal("evt"), event: z.string().min(1).max(128), data: z.unknown() });

/** The pairing transcript hash, in message order: pair-init then pair-challenge. */
export function pairTranscriptOf(init: PairInit, challenge: PairChallenge): Buffer {
	return pairTranscript([
		init.deviceId,
		init.name,
		init.ephPub,
		init.staticPub,
		challenge.deviceId,
		challenge.name,
		challenge.ephPub,
		challenge.staticPub,
	]);
}

export interface AuthParty {
	deviceId: string;
	ephPub: string;
	staticPub: string;
}

/** The auth transcript hash: client (A) fields, then host (B) fields. */
export function authTranscriptOf(client: AuthParty, host: AuthParty): Buffer {
	return authTranscript([
		client.deviceId,
		client.ephPub,
		client.staticPub,
		host.deviceId,
		host.ephPub,
		host.staticPub,
	]);
}
