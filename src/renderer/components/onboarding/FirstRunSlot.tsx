/**
 * Where the first-run setup goes, apart from FirstRunSetup.tsx: its provider steps and forms (about 60 KB) were a
 * paired phone's first-screen JavaScript although a phone almost never shows them. The setup renders from its loaded
 * module, never through lazy() and its Suspense throttle. The desktop loads it at start, so its first launch shows the
 * setup as before; a paired web page starts loading it as soon as the setup becomes active (`useFirstRunActive`) and
 * draws the setup's still frame until it lands. A failed load is tried again at the next touch or key
 * (lib/deferred-chunk.ts).
 */
import { type ComponentType, useEffect, useState } from "react";
import { loadChunk } from "../../lib/chunk-load";
import { loadDeferredChunk } from "../../lib/deferred-chunk";
import { useT } from "../../lib/i18n";
import { useFirstRunStore } from "../../stores/first-run";
import { BrandMark, Skeleton } from "../common";
import { useMachineSetupNeeded } from "./MachineSetupView";

let loadedSetup: ComponentType | null = null;
let loadingSetup: Promise<ComponentType> | null = null;

function loadFirstRunSetup(): Promise<ComponentType> {
	loadingSetup ??= loadChunk(() => import("./FirstRunSetup")).then(
		module => {
			loadedSetup = module.FirstRunSetup;
			return module.FirstRunSetup;
		},
		(error: unknown) => {
			// The next try loads it again; loadChunk has marked a build whose chunk will not load stale.
			loadingSetup = null;
			throw error;
		},
	);
	return loadingSetup;
}

if (typeof document !== "undefined" && document.documentElement.dataset.platform !== "web") {
	void loadFirstRunSetup().catch(() => {});
}

/**
 * True while the first-run setup replaces the empty-session hero: a provider
 * step is open, or this local tab's omp is not usable yet because machine
 * setup is still installing it. The setup's chunk starts loading then.
 */
export function useFirstRunActive(): boolean {
	const phase = useFirstRunStore(state => state.phase);
	const installing = useMachineSetupNeeded();
	const active = phase !== "idle" || installing;
	useEffect(() => {
		if (active && !loadedSetup) void loadFirstRunSetup().catch(() => {});
	}, [active]);
	return active;
}

/** The setup's frame, still, in its own layout (logo, title, rows), until its module lands: no spinner. */
function FirstRunSetupSkeleton() {
	const t = useT();
	return (
		<section
			aria-label={t("common.loading")}
			className="mx-auto flex w-full max-w-2xl flex-col px-4 py-8 sm:px-6 sm:py-10"
			data-testid="first-run-skeleton"
			role="status"
		>
			<BrandMark size={48} />
			<Skeleton className="mt-5 h-8 w-2/3" />
			<Skeleton className="mt-3 h-4 w-5/6" />
			<div aria-hidden className="mt-8 flex flex-col gap-3">
				{[0, 1, 2, 3, 4].map(row => (
					<Skeleton className="h-14" key={row} />
				))}
			</div>
		</section>
	);
}

export function FirstRunSetupSlot() {
	const phase = useFirstRunStore(state => state.phase);
	const [Setup, setSetup] = useState<ComponentType | null>(() => loadedSetup);
	useEffect(
		() =>
			Setup
				? undefined
				: loadDeferredChunk({
						load: loadFirstRunSetup,
						onLoaded: component => setSetup(() => component),
						start: "now",
					}),
		[Setup],
	);
	if (Setup) return <Setup />;
	// The setup itself draws nothing while only machine setup is installing (no provider step yet).
	return phase === "idle" ? null : <FirstRunSetupSkeleton />;
}
