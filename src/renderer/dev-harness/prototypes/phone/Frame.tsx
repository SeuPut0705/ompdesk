import { Bot, ChevronDown, Ellipsis, Info, PanelLeft } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { IconButton } from "../../../components/common";
import { cx } from "../../../lib/format";
import { useP } from "./strings";

/** What the composer needs to know about the screen it sits on (keyboard up? how much is visible?). */
export interface Env {
	/** Height of the part of the screen no keyboard covers, CSS px. */
	visibleH: number;
	kbUp: boolean;
	landscape: boolean;
}

const EnvContext = createContext<Env>({ visibleH: 844, kbUp: false, landscape: false });
export const useEnv = (): Env => useContext(EnvContext);

/** `?fakekb=<px>` (or state=keyboard in a tall window) draws a keyboard and lifts the page the way `--kb-inset` does. */
function fakeKeyboardHeight(query: URLSearchParams, wantKeyboard: boolean): number {
	const explicit = query.get("fakekb");
	if (explicit !== null) return Number(explicit) || 0;
	if (!wantKeyboard || window.innerHeight < 700) return 0;
	return window.innerWidth > window.innerHeight ? 200 : 336;
}

export function useEnvValue(query: URLSearchParams, wantKeyboard: boolean): { env: Env; fakeKb: number } {
	const [fakeKb] = useState(() => fakeKeyboardHeight(query, wantKeyboard));
	const read = (): Env => {
		const visibleH = window.innerHeight - fakeKb;
		const real = document.documentElement.dataset.kb === "open";
		return { visibleH, kbUp: fakeKb > 0 || real, landscape: window.innerWidth > window.innerHeight };
	};
	const [env, setEnv] = useState<Env>(read);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `read` closes over fakeKb, which never changes after mount
	useEffect(() => {
		const update = () =>
			setEnv(previous => {
				const next = read();
				return previous.visibleH === next.visibleH &&
					previous.kbUp === next.kbUp &&
					previous.landscape === next.landscape
					? previous
					: next;
			});
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-kb"] });
		window.addEventListener("resize", update);
		window.visualViewport?.addEventListener("resize", update);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
			window.visualViewport?.removeEventListener("resize", update);
		};
	}, []);
	useEffect(() => {
		if (fakeKb === 0) return;
		const root = document.documentElement;
		const apply = () => {
			if (root.style.getPropertyValue("--kb-inset") !== `${fakeKb}px`)
				root.style.setProperty("--kb-inset", `${fakeKb}px`);
			if (root.style.getPropertyValue("--safe-b") !== "0px") root.style.setProperty("--safe-b", "0px");
		};
		apply();
		// The production keyboard-inset hook writes 0 on its first frame; a fake keyboard keeps its own value.
		const observer = new MutationObserver(apply);
		observer.observe(root, { attributes: true, attributeFilter: ["style"] });
		return () => {
			observer.disconnect();
			root.style.removeProperty("--kb-inset");
			root.style.removeProperty("--safe-b");
		};
	}, [fakeKb]);
	return { env, fakeKb };
}

function FakeKeyboard({ height }: { height: number }) {
	const p = useP();
	const rows = ["q w e r t y u i o p", "a s d f g h j k l", "z x c v b n m"];
	return (
		<div
			aria-hidden
			className="fixed inset-x-0 bottom-0 z-(--sc-z-toast) flex flex-col items-center justify-start gap-2 border-t border-(--sc-border-subtle) bg-(--sc-surface-3) pt-3 text-sc-sm text-(--sc-text-muted)"
			data-proto-fake-keyboard=""
			style={{ height }}
		>
			<span>
				{p("pp.keyboard")} · {height}px
			</span>
			{height > 250 &&
				rows.map(row => (
					<div className="flex gap-1.5" key={row}>
						{row.split(" ").map(key => (
							<span
								className="flex h-9 w-7 items-center justify-center rounded-(--sc-radius-sm) bg-(--sc-elevated) text-sc-md text-(--sc-text)"
								key={key}
							>
								{key}
							</span>
						))}
					</div>
				))}
		</div>
	);
}

/** The session chrome the composer sits in: the phone's 36 px bar, the 28 px work chip, a short transcript. */
export function Frame({
	children,
	fakeKb,
	running,
	hideWorkChip,
}: {
	children: ReactNode;
	fakeKb: number;
	running: boolean;
	hideWorkChip: boolean;
}) {
	const p = useP();
	return (
		<div className="flex h-full min-h-0 flex-col bg-(--sc-bg) text-(--sc-text)" data-proto-frame="">
			<header className="omp-titlebar omp-topbar flex h-12 min-w-0 shrink-0 items-center border-b border-(--sc-divider) px-3">
				<IconButton icon={<PanelLeft />} label={p("pp.sessions")} size="md" />
				<span className="min-w-0 flex-1 truncate px-2 text-sc-md font-medium" data-titlebar-session-name="">
					{p("pp.sessionTitle")}
				</span>
				<div className="flex items-center">
					<IconButton icon={<Info />} label="Info" size="md" />
					<IconButton icon={<Ellipsis />} label={p("pp.sessionActions")} size="md" />
				</div>
			</header>
			<main className="omp-workspace-main flex min-h-0 flex-1 flex-col">
				<section
					className="omp-session-pane relative flex min-h-0 flex-1 flex-col overflow-hidden"
					data-proto-pane=""
				>
					<div className="relative flex min-h-0 flex-1 flex-col">
						{!hideWorkChip && (
							<button
								className="omp-work-chip flex items-center gap-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-surface-1) text-left"
								data-state={running ? "working" : "idle"}
								data-work-chip=""
								type="button"
							>
								<span className="omp-work-chip-label flex min-w-0 flex-1 items-center gap-2" role="status">
									<span className="omp-work-chip-plan">
										<span className="omp-work-chip-bar">
											<span style={{ width: "40%" }} />
										</span>
										<span className="tabular-nums">2/5</span>
										<span className="omp-work-chip-active">{p("pp.workPlan")}</span>
									</span>
								</span>
								<span className="omp-work-chip-count" aria-hidden>
									<Bot className="size-(--sc-icon-sm)" />2
								</span>
								<ChevronDown aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
							</button>
						)}
						<div className="omp-transcript-scroll min-h-0 flex-1 overflow-y-auto" data-proto-transcript="">
							<div className="omp-transcript-editorial flex min-h-full flex-col justify-end gap-2 px-(--omp-column-pad) py-2">
								<div className="omp-user-bubble ml-auto max-w-[85%] rounded-(--sc-radius-lg) bg-(--sc-surface-2) text-sc-lg">
									{p("pp.userMsg1")}
								</div>
								<p className="text-sc-lg text-(--sc-text-secondary)">{p("pp.asst1")}</p>
								<div className="omp-user-bubble ml-auto max-w-[85%] rounded-(--sc-radius-lg) bg-(--sc-surface-2) text-sc-lg">
									{p("pp.userMsg2")}
								</div>
								<p className={cx("text-sc-lg text-(--sc-text-secondary)")}>{p("pp.asst2")}</p>
							</div>
						</div>
						{children}
					</div>
				</section>
			</main>
			{fakeKb > 0 && <FakeKeyboard height={fakeKb} />}
		</div>
	);
}

export { EnvContext };
