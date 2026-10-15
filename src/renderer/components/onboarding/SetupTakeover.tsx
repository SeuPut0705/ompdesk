/**
 * The full-window machine setup: while a required tool (Bun, Git Bash on
 * Windows, omp) is missing or installing on this computer, omp cannot run, so
 * this screen covers the whole window — sidebar and title bar included — and
 * App makes everything beneath it inert. Only the drag strip (and the OS window
 * controls) stay live. It is one modal dialog: focus moves in and is trapped,
 * screen readers announce it as modal, and chords never reach the app behind
 * it. When required setup finishes it fades out into the normal first-run flow
 * (`FirstRunGate` → provider step); reduced motion skips the fade.
 */

import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { useT } from "../../lib/i18n";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { useUiStore } from "../../stores/ui";
import { BrandMark } from "../common";
import { useModalLayer } from "../common/use-modal-layer";
import { MachineSetupView, useMachineSetupNeeded } from "./MachineSetupView";

const NOOP = () => {};

export function SetupTakeover({ open }: { open: boolean }) {
	const t = useT();
	const titleId = useId();
	const descriptionId = useId();
	const panelRef = useRef<HTMLDivElement>(null);
	const { mounted, closing } = useOverlayPresence(open);

	// The setup screen cannot be dismissed: Escape is swallowed by the layer.
	useModalLayer(open, panelRef, NOOP);

	// App shortcuts, the palette and menus are chords: none may reach the app
	// behind. Tab (the focus trap) and plain keys (buttons, text selection) pass.
	useEffect(() => {
		if (!open) return;
		const block = (event: KeyboardEvent) => {
			if (event.key === "Tab") return;
			if (event.metaKey || event.ctrlKey || event.altKey) event.stopImmediatePropagation();
		};
		window.addEventListener("keydown", block, true);
		return () => window.removeEventListener("keydown", block, true);
	}, [open]);

	if (!mounted) return null;
	return (
		<div
			aria-describedby={descriptionId}
			aria-labelledby={titleId}
			aria-modal={!closing}
			className={`fixed inset-0 z-(--sc-z-dialog) flex flex-col bg-(--sc-bg) text-(--sc-text) outline-none ${closing ? "omp-fade-out" : "omp-fade-in"}`}
			data-testid="setup-takeover"
			inert={closing}
			// Dropped files and links never reach the composer behind.
			onDragOver={event => {
				event.preventDefault();
				event.dataTransfer.dropEffect = "none";
			}}
			onDrop={event => event.preventDefault()}
			ref={panelRef}
			// An exiting screen leaves the dialog role so it cannot cover a dialog opened above it.
			role={closing ? "presentation" : "dialog"}
			tabIndex={-1}
		>
			{/* The window's drag strip: clear of the macOS traffic lights and the Windows caption buttons. */}
			<div
				aria-hidden
				className="drag-region h-12 shrink-0"
				style={{
					paddingLeft: "var(--sc-traffic-lights)",
					paddingRight: "var(--sc-caption-buttons)",
				}}
			/>
			<div className="no-drag min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-2xl flex-col px-4 pb-10 sm:px-6">
					<BrandMark size={48} />
					<h1
						className="mt-5 text-sc-3xl font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)"
						id={titleId}
					>
						{t("machineSetup.install.title")}
					</h1>
					<p className="mt-2 text-sc-lg text-(--sc-text-muted)" id={descriptionId}>
						{t("machineSetup.install.description")}
					</p>
					<div className="mt-8">
						<MachineSetupView />
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * Decides, from the focused tab's runtime, whether the screen is up: publishes
 * it to `useMachineSetupStore.takeover` (App's inert flag and the non-React
 * entry points) and clears what was open beneath when it appears.
 */
export function SetupTakeoverHost() {
	const needed = useMachineSetupNeeded();
	useLayoutEffect(() => {
		useMachineSetupStore.getState().setTakeover(needed);
		if (!needed) return;
		const ui = useUiStore.getState();
		ui.closeCommandPalette();
		ui.closeDestination();
		return () => useMachineSetupStore.getState().setTakeover(false);
	}, [needed]);
	return <SetupTakeover open={needed} />;
}
