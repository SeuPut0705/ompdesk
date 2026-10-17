/**
 * `/pair`: where a browser the computer does not know yet lands (the page sends it here when its session is
 * refused). No code and no form: the browser is on the tailnet and Tailscale vouched for its account, so this makes
 * the device key and asks `POST /api/pair` to connect it, then goes into the app. While the user asked to approve
 * new devices on the computer the request stays open (up to a minute) and the page says so. A refusal is shown
 * with its reason (blocked, account not allowed, declined, too many tries) and a Try again button. A browser that
 * is already connected just goes on to the app.
 */
import { useEffect, useRef, useState } from "react";
import { Banner, BrandMark, Button, Spinner } from "../components/common";
import { useT } from "../lib/i18n";
import { createDeviceKey, deviceKeySupported } from "./device-key";
import { defaultDeviceName, type PairFailure, pairFailureOf } from "./pairing";
import { fetchTicket } from "./session";

type PairState = "working" | "approval" | "failed";

const INSTANCE_KEY = "omp.web.instance";

function instanceId(): string {
	try {
		const stored = localStorage.getItem(INSTANCE_KEY);
		if (stored) return stored;
		const fresh = crypto.randomUUID();
		localStorage.setItem(INSTANCE_KEY, fresh);
		return fresh;
	} catch {
		return crypto.randomUUID();
	}
}

/**
 * This browser already holds a cookie the computer knows and the key that goes with it: it can get a session
 * ticket, so there is nothing to connect. (A cookie whose key is gone, or one the computer forgot, cannot.)
 */
async function alreadyConnected(): Promise<boolean> {
	try {
		await fetchTicket({ fetch: (input, init) => fetch(input, init) });
		return true;
	} catch {
		return false;
	}
}

/** The `{error}` a refused call carried, or null. */
async function errorOf(response: Response): Promise<string | null> {
	try {
		const body: unknown = await response.json();
		return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
			? body.error
			: null;
	} catch {
		return null;
	}
}

export function PairScreen() {
	const t = useT();
	const [state, setState] = useState<PairState>("working");
	const [failure, setFailure] = useState<PairFailure | null>(null);
	const running = useRef(false);

	const connect = async () => {
		if (running.current) return;
		running.current = true;
		setFailure(null);
		setState("working");
		const fail = (reason: PairFailure) => {
			setFailure(reason);
			setState("failed");
		};
		try {
			if (await alreadyConnected()) {
				location.replace("/");
				return;
			}
			let publicKeyJwk: JsonWebKey | undefined;
			if (deviceKeySupported()) {
				try {
					publicKeyJwk = (await createDeviceKey()).publicKeyJwk;
				} catch {
					fail("key");
					return;
				}
			}
			// The computer may ask its user first: say that we are waiting for them.
			const waiting = setTimeout(() => setState("approval"), 1500);
			try {
				const response = await fetch("/api/pair", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						name: defaultDeviceName(navigator.userAgent, navigator.maxTouchPoints),
						clientInstanceId: instanceId(),
						publicKeyJwk,
					}),
					credentials: "same-origin",
				});
				if (response.ok) {
					location.replace("/");
					return;
				}
				fail(pairFailureOf(response.status, await errorOf(response)));
			} finally {
				clearTimeout(waiting);
			}
		} catch {
			fail("network");
		} finally {
			running.current = false;
		}
	};

	// Once on arrival; Try again calls `connect` itself.
	// biome-ignore lint/correctness/useExhaustiveDependencies: connect reads only refs and setters
	useEffect(() => {
		void connect();
	}, []);

	return (
		<main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6" data-pair-state={state}>
			<div className="flex items-center gap-3">
				<BrandMark size={36} />
				<h1 className="text-sc-xl font-semibold text-(--sc-text)">{t("web.pair.title")}</h1>
			</div>
			{state === "failed" ? null : <p className="text-sc-md text-(--sc-text-muted)">{t("web.pair.intro")}</p>}
			{state === "working" ? <Spinner label={t("web.pair.waiting")} /> : null}
			{state === "approval" ? (
				<Banner variant="info" live>
					{t("web.pair.approval")}
				</Banner>
			) : null}
			{failure ? (
				<>
					<Banner variant="danger" live>
						{t(`web.pair.error.${failure}`)}
					</Banner>
					<Button variant="primary" size="lg" onClick={() => void connect()}>
						{t("web.pair.retry")}
					</Button>
				</>
			) : null}
		</main>
	);
}
