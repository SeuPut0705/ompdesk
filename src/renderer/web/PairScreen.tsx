/**
 * `/pair`: the page a phone opens from the QR code (`/pair#<CODE>`) or by hand. It makes the device key,
 * sends the code and a name to `POST /api/pair`, and waits while the computer asks its user to approve (the
 * request stays open up to a minute). The host answers 200 with the device cookie; the refusals are
 * pairing.ts `PAIR_FAILURE_BY_STATUS`.
 */
import { useRef, useState } from "react";
import { Banner, BrandMark, Button, Input } from "../components/common";
import { useT } from "../lib/i18n";
import { createDeviceKey, deviceKeySupported } from "./device-key";
import { defaultDeviceName, normalizePairCode, PAIR_FAILURE_BY_STATUS, type PairFailure } from "./pairing";

type PairState = "idle" | "working" | "approval" | "failed";

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

/** Read the code from `#<CODE>` once and drop it from the address bar. */
function takeFragmentCode(): string {
	const code = decodeURIComponent(location.hash.replace(/^#/, ""));
	if (code) history.replaceState(null, "", location.pathname + location.search);
	return code;
}

function deviceName(): string {
	return defaultDeviceName(navigator.userAgent, navigator.maxTouchPoints);
}

export function PairScreen() {
	const t = useT();
	const [code, setCode] = useState(takeFragmentCode);
	const [name, setName] = useState(deviceName);
	const [state, setState] = useState<PairState>("idle");
	const [failure, setFailure] = useState<PairFailure | null>(null);
	const submitting = useRef(false);

	const fail = (reason: PairFailure) => {
		setFailure(reason);
		setState("failed");
	};

	const submit = async () => {
		if (submitting.current) return;
		const normalized = normalizePairCode(code);
		if (!normalized) {
			fail("badCode");
			return;
		}
		submitting.current = true;
		setFailure(null);
		setState("working");
		try {
			let publicKeyJwk: JsonWebKey | undefined;
			if (deviceKeySupported()) {
				try {
					publicKeyJwk = (await createDeviceKey()).publicKeyJwk;
				} catch {
					fail("key");
					return;
				}
			}
			// The host asks its user before it answers: say that we are waiting for them.
			const waiting = setTimeout(() => setState("approval"), 1500);
			try {
				const response = await fetch("/api/pair", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						code: normalized,
						name: name.trim() || deviceName(),
						clientInstanceId: instanceId(),
						publicKeyJwk,
					}),
					credentials: "same-origin",
				});
				if (response.ok) {
					location.replace("/");
					return;
				}
				fail(PAIR_FAILURE_BY_STATUS[response.status] ?? "network");
			} finally {
				clearTimeout(waiting);
			}
		} catch {
			fail("network");
		} finally {
			submitting.current = false;
		}
	};

	const busy = state === "working" || state === "approval";
	return (
		<main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6">
			<div className="flex items-center gap-3">
				<BrandMark size={36} />
				<h1 className="text-sc-xl font-semibold text-(--sc-text)">{t("web.pair.title")}</h1>
			</div>
			<p className="text-sc-md text-(--sc-text-muted)">{t("web.pair.intro")}</p>
			<form
				className="flex flex-col gap-3"
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<Input
					label={t("web.pair.code")}
					value={code}
					onChange={event => setCode(event.target.value)}
					autoCapitalize="characters"
					autoCorrect="off"
					autoComplete="off"
					spellCheck={false}
					enterKeyHint="go"
					disabled={busy}
					controlSize="lg"
					className="font-mono tracking-[0.12em]"
				/>
				<Input
					label={t("web.pair.name")}
					hint={t("web.pair.nameHint")}
					value={name}
					onChange={event => setName(event.target.value)}
					autoComplete="off"
					enterKeyHint="go"
					disabled={busy}
					controlSize="lg"
				/>
				<Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.trim().length === 0}>
					{state === "approval" ? t("web.pair.waiting") : t("web.pair.submit")}
				</Button>
			</form>
			{state === "approval" ? (
				<Banner variant="info" live>
					{t("web.pair.approval")}
				</Banner>
			) : null}
			{failure ? (
				<Banner variant="danger" live>
					{t(`web.pair.error.${failure}`)}
				</Banner>
			) : null}
		</main>
	);
}
