/**
 * Internal ompdesk style guide — every token and primitive on one page, in
 * the active theme, for design review. Not part of the product: reachable
 * only with OMP_GUI_STYLEGUIDE=1 (src/main/window.ts) or the #/styleguide
 * hash, so its copy is English-only and bypasses the locale files.
 *
 * The contrast matrix is computed from the live computed styles; the page
 * publishes it as `window.__scContrast` for a screenshot script to read.
 */

import {
	ArrowUp,
	BarChart3,
	Bot,
	Copy,
	FolderGit2,
	GitBranch,
	Inbox,
	MessageSquarePlus,
	MoreHorizontal,
	Pencil,
	Plus,
	Search,
	Settings,
	Sparkles,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { applyTheme, resolveTheme, type ThemeMode } from "../../lib/theme";
import {
	Badge,
	Banner,
	BrandMark,
	Button,
	Checkbox,
	CopyButton,
	EmptyState,
	IconButton,
	InlineNotice,
	Input,
	Kbd,
	LinkButton,
	ListRow,
	MenuButton,
	Modal,
	OptionRow,
	Popover,
	ProgressBar,
	Radio,
	SearchField,
	SegmentedChoice,
	Select,
	Sheet,
	Skeleton,
	SkeletonRows,
	Spinner,
	Switch,
	SwitchField,
	Tabs,
	TextArea,
	Tooltip,
} from "../common";
import { MenuItemView, MenuSurface, menuItemClasses } from "../common/ContextMenu";
import { DialogSurface } from "../common/Modal";
import { PopoverSurface } from "../common/Popover";
import { SheetSurface } from "../common/Sheet";
import { ToastCard } from "../common/Toast";
import { TooltipBubble } from "../common/Tooltip";

// ── Token inventory ─────────────────────────────────────────────────────────

const COLOR_GROUPS: { title: string; tokens: string[] }[] = [
	{ title: "Surfaces", tokens: ["bg", "surface-1", "surface-2", "surface-3", "elevated", "field", "overlay"] },
	{ title: "Text", tokens: ["text", "text-secondary", "text-muted", "text-subtle"] },
	{ title: "Lines", tokens: ["divider", "border-subtle", "border", "border-strong"] },
	{ title: "Accent", tokens: ["accent", "accent-hover", "accent-fg", "accent-soft", "accent-border", "focus-glow"] },
	{
		title: "Status",
		tokens: [
			"success",
			"warning",
			"danger",
			"info",
			"danger-fg",
			"success-soft",
			"warning-soft",
			"danger-soft",
			"info-soft",
		],
	},
	{ title: "Washes", tokens: ["hover", "pressed", "selected", "selection"] },
];

const TYPE_STEPS = [
	{ token: "3xl", use: "Empty-state hero", weight: "font-semibold" },
	{ token: "2xl", use: "Page title", weight: "font-semibold" },
	{ token: "xl", use: "Section heading", weight: "font-semibold" },
	{ token: "lg", use: "Reading body · dialog title", weight: "font-normal" },
	{ token: "md", use: "Default UI: buttons, fields, rows", weight: "font-normal" },
	{ token: "sm", use: "Secondary UI, descriptions", weight: "font-normal" },
	{ token: "xs", use: "Captions, meta, kbd", weight: "font-normal" },
	{ token: "2xs", use: "Badges, counters (floor)", weight: "font-medium" },
] as const;

const TYPE_CLASS: Record<(typeof TYPE_STEPS)[number]["token"], string> = {
	"3xl": "text-sc-3xl",
	"2xl": "text-sc-2xl",
	xl: "text-sc-xl",
	lg: "text-sc-lg",
	md: "text-sc-md",
	sm: "text-sc-sm",
	xs: "text-sc-xs",
	"2xs": "text-sc-2xs",
};

const SPACE_STEPS = ["0-5", "1", "1-5", "2", "3", "4", "5", "6", "8", "10", "12", "16"];
const RADII = ["xs", "sm", "md", "lg", "xl", "full"];
const SHADOWS = ["sm", "md", "lg"];
const DURATIONS = ["instant", "fast", "med", "slow"];
const LAYERS = ["raised", "sticky", "drawer", "dialog", "popover", "toast", "tooltip"];

// ── Contrast ────────────────────────────────────────────────────────────────

type Rgba = [number, number, number, number];

const TEXT_FOREGROUNDS = [
	"text",
	"text-secondary",
	"text-muted",
	"text-subtle",
	"accent",
	"success",
	"warning",
	"danger",
	"info",
];
const TEXT_SURFACES = ["bg", "surface-1", "surface-2", "surface-3", "elevated"];

/** [label, foreground, background, layered-over, minimum] — non-matrix pairs. */
const EXTRA_PAIRS: [string, string, string, string, number][] = [
	["Primary button label", "accent-fg", "accent", "bg", 4.5],
	["Danger button label", "danger-fg", "danger", "bg", 4.5],
	["Tooltip text", "bg", "text", "bg", 4.5],
	["Accent badge", "accent", "accent-soft", "bg", 4.5],
	["Success badge", "success", "success-soft", "bg", 4.5],
	["Warning badge", "warning", "warning-soft", "bg", 4.5],
	["Danger badge", "danger", "danger-soft", "bg", 4.5],
	["Info badge", "info", "info-soft", "bg", 4.5],
	["Selected row text", "text", "selected", "surface-1", 4.5],
	["Placeholder (subtle) in field", "text-subtle", "field", "bg", 4.5],
	["Field border on field", "border", "field", "bg", 3],
	["Border on bg", "border", "bg", "bg", 3],
	["Border on surface-1", "border", "surface-1", "bg", 3],
	["Border on elevated", "border", "elevated", "bg", 3],
	["Focus ring on bg", "accent", "bg", "bg", 3],
	["Focus ring on surface-1", "accent", "surface-1", "bg", 3],
	["Focus ring on elevated", "accent", "elevated", "bg", 3],
	["Switch on-track vs bg", "accent", "bg", "bg", 3],
	["Switch knob on (accent-fg on accent)", "accent-fg", "accent", "bg", 3],
	["Switch knob off (text-muted on field)", "text-muted", "field", "bg", 3],
	["Card edge (border-subtle on bg) — decorative", "border-subtle", "bg", "bg", 0],
	["Divider on bg — decorative", "divider", "bg", "bg", 0],
];

export interface ContrastRow {
	label: string;
	foreground: string;
	background: string;
	ratio: number;
	minimum: number;
}

function parseColor(value: string): Rgba | null {
	const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value);
	if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
	const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(value);
	if (srgb) {
		return [
			Number(srgb[1]) * 255,
			Number(srgb[2]) * 255,
			Number(srgb[3]) * 255,
			srgb[4] === undefined ? 1 : Number(srgb[4]),
		];
	}
	return null;
}

function over(top: Rgba, below: Rgba): Rgba {
	const a = top[3];
	return [top[0] * a + below[0] * (1 - a), top[1] * a + below[1] * (1 - a), top[2] * a + below[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
	return [r, g, b].reduce((sum, value, i) => {
		const c = value / 255;
		return sum + [0.2126, 0.7152, 0.0722][i] * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	}, 0);
}

function contrastRatio(a: Rgba, b: Rgba): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** Reads every --sc-* color as the browser resolves it right now. */
function readColors(probe: HTMLElement, tokens: readonly string[]): Map<string, Rgba> {
	const colors = new Map<string, Rgba>();
	for (const token of tokens) {
		probe.style.color = `var(--sc-${token})`;
		const parsed = parseColor(getComputedStyle(probe).color);
		if (parsed) colors.set(token, parsed);
	}
	return colors;
}

function computeContrast(probe: HTMLElement): ContrastRow[] {
	const tokens = new Set([...TEXT_FOREGROUNDS, ...TEXT_SURFACES]);
	for (const [, fg, bg, base] of EXTRA_PAIRS) {
		tokens.add(fg);
		tokens.add(bg);
		tokens.add(base);
	}
	const colors = readColors(probe, [...tokens]);
	const page = colors.get("bg") ?? [255, 255, 255, 1];
	const pair = (label: string, fg: string, bg: string, base: string, minimum: number): ContrastRow | null => {
		const f = colors.get(fg);
		const b = colors.get(bg);
		const under = colors.get(base);
		if (!f || !b || !under) return null;
		const ground = over(b, over(under, page));
		return { label, foreground: fg, background: bg, ratio: contrastRatio(over(f, ground), ground), minimum };
	};
	const rows: ContrastRow[] = [];
	for (const fg of TEXT_FOREGROUNDS) {
		for (const bg of TEXT_SURFACES) {
			const row = pair(`${fg} on ${bg}`, fg, bg, "bg", 4.5);
			if (row) rows.push(row);
		}
	}
	for (const [label, fg, bg, base, minimum] of EXTRA_PAIRS) {
		const row = pair(label, fg, bg, base, minimum);
		if (row) rows.push(row);
	}
	return rows;
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
	return (
		<section aria-labelledby={`${id}-title`} className="border-t border-(--sc-divider) py-10">
			<h2 className="text-sc-2xl font-semibold tracking-(--sc-tracking-tight)" id={`${id}-title`}>
				{title}
			</h2>
			{intro && <p className="mt-1.5 max-w-2xl text-sc-md text-(--sc-text-muted)">{intro}</p>}
			<div className="mt-6 space-y-8">{children}</div>
		</section>
	);
}

function Block({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
	return (
		<div>
			<div className="mb-3 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">{label}</div>
			<div className={className}>{children}</div>
		</div>
	);
}

function Swatch({ token, value }: { token: string; value: string }) {
	return (
		<div className="overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle)">
			<div
				className="relative h-12"
				// Checkerboard so translucent washes read as translucent.
				style={{
					backgroundImage:
						"conic-gradient(var(--sc-surface-3) 25%, transparent 0 50%, var(--sc-surface-3) 0 75%, transparent 0)",
					backgroundSize: "12px 12px",
				}}
			>
				<div className="absolute inset-0" style={{ background: `var(--sc-${token})` }} />
			</div>
			<div className="px-2 py-1.5">
				<div className="truncate font-mono text-sc-2xs text-(--sc-text)">--sc-{token}</div>
				<div className="truncate font-mono text-sc-2xs text-(--sc-text-muted)">{value || "…"}</div>
			</div>
		</div>
	);
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function StyleGuide() {
	const [mode, setMode] = useState<ThemeMode>("system");
	const [approval, setApproval] = useState<"ask" | "remember" | "full">("ask");
	const [measureKey, setMeasureKey] = useState(0);
	const [values, setValues] = useState<Record<string, string>>({});
	const [contrast, setContrast] = useState<ContrastRow[]>([]);
	const probeRef = useRef<HTMLSpanElement>(null);
	const popoverAnchor = useRef<HTMLButtonElement>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [switches, setSwitches] = useState({ a: true, b: false, c: true });
	const [query, setQuery] = useState("");
	const [tab, setTab] = useState("changes");
	const [segment, setSegment] = useState("plan");

	// The app shell locks html/body/#root to the viewport; this page scrolls the document instead.
	useEffect(() => {
		const nodes = [document.documentElement, document.body, document.getElementById("root")];
		for (const node of nodes) {
			node?.style.setProperty("overflow", "visible");
			node?.style.setProperty("height", "auto");
		}
		document.title = "OMPdesk — style guide";
	}, []);

	useEffect(() => {
		applyTheme(mode);
		const frame = requestAnimationFrame(() => setMeasureKey(key => key + 1));
		return () => cancelAnimationFrame(frame);
	}, [mode]);

	useEffect(() => {
		const probe = probeRef.current;
		if (!probe || measureKey === 0) return;
		const resolved = readColors(
			probe,
			COLOR_GROUPS.flatMap(group => group.tokens),
		);
		const next: Record<string, string> = {};
		for (const [token, [r, g, b, a]] of resolved) {
			const hex = `#${[r, g, b].map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
			next[token] = a === 1 ? hex : `${hex} · ${Math.round(a * 100)}%`;
		}
		setValues(next);
		const rows = computeContrast(probe);
		setContrast(rows);
		Reflect.set(window, "__scContrast", { theme: resolveTheme(mode), rows });
	}, [measureKey, mode]);

	const menuItems = [
		{ id: "rename", label: "Rename", icon: Pencil, shortcut: "⌘R", onSelect: () => {} },
		{ id: "copy", label: "Copy link", icon: Copy, onSelect: () => {} },
		{ id: "pin", label: "Pin to top", checked: true, onSelect: () => {} },
		{ id: "delete", label: "Delete session", icon: Trash2, danger: true, onSelect: () => {} },
	];

	return (
		<div className="min-h-screen bg-(--sc-bg) text-(--sc-text)">
			<span aria-hidden className="pointer-events-none fixed -left-[9999px]" ref={probeRef} />
			<header className="sticky top-0 z-(--sc-z-sticky) border-b border-(--sc-divider) bg-(--sc-bg)/90 backdrop-blur">
				<div className="mx-auto flex max-w-[1180px] items-center gap-3 px-10 py-3">
					<BrandMark size={22} />
					<span className="text-sc-lg font-semibold tracking-(--sc-tracking-tight)">OMPdesk</span>
					<span className="text-sc-md text-(--sc-text-muted)">Design system · internal style guide</span>
					<div className="ml-auto">
						<Tabs
							activeId={mode}
							ariaLabel="Theme"
							onChange={id => setMode(id as ThemeMode)}
							tabs={[
								{ id: "light", label: "Light" },
								{ id: "dark", label: "Dark" },
								{ id: "system", label: "System" },
							]}
							variant="segmented"
						/>
					</div>
				</div>
			</header>

			<main className="mx-auto max-w-[1180px] px-10 pb-24">
				<div className="py-12">
					<h1 className="text-sc-3xl font-semibold tracking-(--sc-tracking-tight)">OMPdesk</h1>
					<p className="mt-2 max-w-2xl text-sc-lg text-(--sc-text-secondary)">
						Calm, content-first, one confident accent. Tokens are CSS custom properties (--sc-*) in
						src/renderer/styles; primitives live in components/common. Rules: components/common/README.md.
					</p>
				</div>

				<Section
					id="color"
					intro="Palette primitives come from theme-light.css / theme-dark.css; washes and soft tints are derived with color-mix, so named themes retint them."
					title="Color"
				>
					{COLOR_GROUPS.map(group => (
						<Block className="grid grid-cols-6 gap-3" key={group.title} label={group.title}>
							{group.tokens.map(token => (
								<Swatch key={token} token={token} value={values[token] ?? ""} />
							))}
						</Block>
					))}
				</Section>

				<Section
					id="contrast"
					intro="Computed from the live styles of this theme (WCAG 2.x). Text needs 4.5:1; structural boundaries and focus indicators need 3:1; decorative hairlines have no minimum."
					title="Contrast"
				>
					<Block label="Text on surfaces">
						<table className="w-full border-collapse text-sc-sm">
							<thead>
								<tr className="text-left text-(--sc-text-muted)">
									<th className="py-1.5 pr-3 font-medium">Foreground</th>
									{TEXT_SURFACES.map(surface => (
										<th className="py-1.5 pr-3 font-medium" key={surface}>
											{surface}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{TEXT_FOREGROUNDS.map(fg => (
									<tr className="border-t border-(--sc-divider)" key={fg}>
										<td className="py-1.5 pr-3 font-mono text-sc-xs" style={{ color: `var(--sc-${fg})` }}>
											{fg}
										</td>
										{TEXT_SURFACES.map(bg => {
											const row = contrast.find(
												r => r.foreground === fg && r.background === bg && r.label.includes(" on "),
											);
											return (
												<td className="py-1.5 pr-3 tabular-nums" key={bg}>
													{row ? (
														<span
															className={
																row.ratio >= row.minimum ? "text-(--sc-text)" : "text-(--sc-danger)"
															}
														>
															{row.ratio.toFixed(2)}
														</span>
													) : (
														"…"
													)}
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					</Block>
					<Block label="Controls, boundaries and focus">
						<table className="w-full border-collapse text-sc-sm">
							<tbody>
								{contrast.slice(TEXT_FOREGROUNDS.length * TEXT_SURFACES.length).map(row => (
									<tr className="border-t border-(--sc-divider)" key={row.label}>
										<td className="py-1.5 pr-3">{row.label}</td>
										<td className="py-1.5 pr-3 font-mono text-sc-xs text-(--sc-text-muted)">
											{row.foreground} / {row.background}
										</td>
										<td className="py-1.5 pr-3 tabular-nums">{row.ratio.toFixed(2)}</td>
										<td className="py-1.5">
											{row.minimum === 0 ? (
												<Badge variant="muted">decorative</Badge>
											) : row.ratio >= row.minimum ? (
												<Badge variant="success">≥ {row.minimum}</Badge>
											) : (
												<Badge variant="error">below {row.minimum}</Badge>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</Block>
				</Section>

				<Section
					id="type"
					intro="Inter for Latin, the system Korean face for Hangul, JetBrains Mono for code. Steps scale with the user font-size preference (default 15px)."
					title="Typography"
				>
					<Block className="divide-y divide-(--sc-divider)" label="Scale (text-sc-*)">
						{TYPE_STEPS.map(step => (
							<div className="flex items-baseline gap-6 py-2.5" key={step.token}>
								<span className="w-14 shrink-0 font-mono text-sc-xs text-(--sc-text-muted)">{step.token}</span>
								<span className={cx("min-w-0 flex-1 truncate", TYPE_CLASS[step.token], step.weight)}>
									세션을 이어서 작업하기 · Continue the session
								</span>
								<span className="w-64 shrink-0 text-right text-sc-xs text-(--sc-text-muted)">{step.use}</span>
							</div>
						))}
					</Block>
					<Block className="grid grid-cols-3 gap-6" label="Weights, text roles and mono">
						<div className="space-y-1 text-sc-lg">
							<div className="font-normal">Regular 400 — 본문</div>
							<div className="font-medium">Medium 500 — 레이블</div>
							<div className="font-semibold">Semibold 600 — 제목</div>
						</div>
						<div className="space-y-1 text-sc-md">
							<div className="text-(--sc-text)">text — primary content</div>
							<div className="text-(--sc-text-secondary)">text-secondary — supporting</div>
							<div className="text-(--sc-text-muted)">text-muted — metadata</div>
							<div className="text-(--sc-text-subtle)">text-subtle — placeholders</div>
						</div>
						<pre className="rounded-(--sc-radius-md) bg-(--omp-code-bg) p-3 font-mono text-sc-sm text-(--sc-text)">
							{"const session = await omp.resume(id);\n// 계획 모드: plan first"}
						</pre>
					</Block>
				</Section>

				<Section id="scales" title="Space, shape, depth, motion">
					<Block className="space-y-1.5" label="Spacing (4px base)">
						{SPACE_STEPS.map(step => (
							<div className="flex items-center gap-4" key={step}>
								<span className="w-28 font-mono text-sc-xs text-(--sc-text-muted)">--sc-space-{step}</span>
								<span
									className="h-3 rounded-[2px] bg-(--sc-accent)"
									style={{ width: `var(--sc-space-${step})` }}
								/>
							</div>
						))}
					</Block>
					<Block className="flex flex-wrap gap-4" label="Radii">
						{RADII.map(radius => (
							<div className="text-center" key={radius}>
								<div
									className="size-16 border border-(--sc-border) bg-(--sc-surface-2)"
									style={{ borderRadius: `var(--sc-radius-${radius})` }}
								/>
								<div className="mt-1.5 font-mono text-sc-2xs text-(--sc-text-muted)">{radius}</div>
							</div>
						))}
					</Block>
					<Block
						className="grid grid-cols-3 gap-6 rounded-(--sc-radius-lg) bg-(--sc-surface-1) p-6"
						label="Elevation"
					>
						{SHADOWS.map(shadow => (
							<div
								className="flex h-24 items-center justify-center rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) font-mono text-sc-xs text-(--sc-text-muted)"
								key={shadow}
								style={{ boxShadow: `var(--sc-shadow-${shadow})` }}
							>
								--sc-shadow-{shadow}
							</div>
						))}
					</Block>
					<div className="grid grid-cols-3 gap-6">
						<Block className="space-y-1 font-mono text-sc-xs" label="Controls · icons">
							<div>--sc-control-sm 28 · md 32 · lg 36</div>
							<div>--sc-hit-min 28</div>
							<div>--sc-icon-sm 14 · md 16 · lg 20</div>
						</Block>
						<Block className="space-y-1 font-mono text-sc-xs" label="Motion">
							{DURATIONS.map(duration => (
								<div key={duration}>--sc-duration-{duration}</div>
							))}
							<div>--sc-ease-standard · enter · exit</div>
						</Block>
						<Block className="space-y-1 font-mono text-sc-xs" label="Layers (z-index)">
							{LAYERS.map(layer => (
								<div key={layer}>--sc-z-{layer}</div>
							))}
						</Block>
					</div>
				</Section>

				<Section
					id="actions"
					intro="One primary per view. Icon-only actions always carry a label (accessible name + tooltip)."
					title="Actions"
				>
					<Block className="space-y-3" label="Button — variants × sizes">
						{(["primary", "secondary", "ghost", "danger"] as const).map(variant => (
							<div className="flex items-center gap-3" key={variant}>
								<span className="w-20 font-mono text-sc-xs text-(--sc-text-muted)">{variant}</span>
								<Button size="sm" variant={variant}>
									Small
								</Button>
								<Button variant={variant}>Medium</Button>
								<Button size="lg" variant={variant}>
									Large
								</Button>
								<Button icon={<Plus />} variant={variant}>
									With icon
								</Button>
								<Button disabled variant={variant}>
									Disabled
								</Button>
								<Button loading variant={variant}>
									Loading
								</Button>
							</div>
						))}
					</Block>
					<Block className="flex items-center gap-6" label="IconButton — sizes, variants, toggle">
						<div className="flex items-center gap-1">
							<IconButton icon={<Search />} label="Search" shortcut="⌘K" size="sm" />
							<IconButton icon={<Search />} label="Search" shortcut="⌘K" />
							<IconButton icon={<Search />} label="Search" shortcut="⌘K" size="lg" />
						</div>
						<div className="flex items-center gap-1">
							<IconButton icon={<Settings />} label="Settings" variant="secondary" />
							<IconButton icon={<ArrowUp />} label="Send" variant="primary" />
							<IconButton icon={<Trash2 />} label="Delete" variant="danger" />
							<IconButton icon={<Sparkles />} label="Plan mode" pressed />
							<IconButton disabled icon={<Copy />} label="Copy" />
						</div>
						<MenuButton icon={<MoreHorizontal />} items={menuItems} label="Session actions" />
						<MenuButton items={menuItems} label="Session actions">
							Actions
						</MenuButton>
					</Block>
					<Block className="flex items-center gap-4" label="Kbd (platform-formatted)">
						<Kbd shortcut="⌘K" />
						<Kbd shortcut="⇧⌘T" />
						<Kbd shortcut="⌥A" />
						<Kbd shortcut="⌘K / ⌃K" />
						<Kbd shortcut="⎋" />
					</Block>
				</Section>

				<Section id="inputs" title="Inputs">
					<div className="grid grid-cols-3 gap-6">
						<Input hint="Shown in the sidebar and tabs." label="Session name" placeholder="e.g. Fix login flow" />
						<Input defaultValue="sk-live-…" error="That key was rejected by the provider." label="API key" mono />
						<Input disabled label="Base URL" placeholder="https://api.example.com" />
						<SearchField
							label="Search sessions"
							onValueChange={setQuery}
							placeholder="Search sessions"
							shortcut="⌘K"
							value={query}
						/>
						<SearchField
							label="Search providers"
							onValueChange={() => {}}
							placeholder="Search providers"
							value="anthropic"
						/>
						<Select
							defaultValue="ask"
							label="Tool approval"
							options={[
								{ value: "full", label: "Full access" },
								{ value: "edits", label: "Auto-approve edits" },
								{ value: "ask", label: "Ask every time" },
							]}
						/>
						<div className="flex items-end gap-2">
							<Input controlSize="sm" label="Small row" placeholder="28px" />
							<Button size="sm">Apply</Button>
						</div>
						<div className="col-span-2">
							<TextArea autoGrow label="Instructions" placeholder="Describe the task…" rows={2} />
						</div>
					</div>
					<Block className="grid grid-cols-2 gap-x-10" label="Switch · SwitchField">
						<div className="space-y-1">
							<SwitchField
								checked={switches.a}
								description="Compact the conversation when the context window fills up."
								label="Auto-compact"
								onCheckedChange={a => setSwitches(s => ({ ...s, a }))}
							/>
							<SwitchField
								checked={switches.b}
								description="Retry failed requests with backoff."
								label="Auto-retry"
								onCheckedChange={b => setSwitches(s => ({ ...s, b }))}
							/>
							<SwitchField
								badge={<Badge variant="accent">Beta</Badge>}
								checked={false}
								disabled
								label="Voice input"
								onCheckedChange={() => {}}
							/>
						</div>
						<div className="flex items-center gap-4">
							<Switch checked={switches.c} label="On" onCheckedChange={c => setSwitches(s => ({ ...s, c }))} />
							<Switch checked={false} label="Off" onCheckedChange={() => {}} />
							<Switch checked label="Small on" onCheckedChange={() => {}} size="sm" />
							<Switch checked={false} label="Small off" onCheckedChange={() => {}} size="sm" />
							<Switch checked disabled label="Disabled" onCheckedChange={() => {}} />
						</div>
					</Block>
					<Block className="flex flex-wrap items-center gap-6" label="Checkbox · Radio (applied on submit)">
						<label className="flex items-center gap-2 text-sc-sm">
							<Checkbox defaultChecked />
							Include environment
						</label>
						<label className="flex items-center gap-2 text-sc-sm">
							<Checkbox indeterminate />
							Select all (some)
						</label>
						<label className="flex items-center gap-2 text-sc-sm">
							<Checkbox disabled />
							Disabled
						</label>
						<label className="flex items-center gap-2 text-sc-sm">
							<Radio defaultChecked name="styleguide-radio" />
							HEAD
						</label>
						<label className="flex items-center gap-2 text-sc-sm">
							<Radio name="styleguide-radio" />
							Default branch
						</label>
					</Block>
				</Section>

				<Section id="navigation" title="Navigation & lists">
					<div className="grid grid-cols-2 gap-10">
						<Block className="space-y-6" label="Tabs — underline · segmented">
							<Tabs
								activeId={tab}
								ariaLabel="Inspector"
								onChange={setTab}
								tabs={[
									{ id: "changes", label: "Changes", badge: 3 },
									{ id: "files", label: "Files" },
									{ id: "logs", label: "Logs" },
								]}
							/>
							<Tabs
								activeId={segment}
								ariaLabel="Mode"
								onChange={setSegment}
								tabs={[
									{ id: "plan", label: "Plan" },
									{ id: "goal", label: "Goal" },
									{ id: "autopilot", label: "Autopilot" },
								]}
								variant="segmented"
							/>
						</Block>
						<Block
							className="rounded-(--sc-radius-lg) bg-(--sc-surface-1) p-2"
							label="ListRow (sidebar sessions)"
						>
							<ListRow
								actions={
									<>
										<IconButton icon={<Pencil />} label="Rename" size="sm" />
										<IconButton icon={<Trash2 />} label="Delete" size="sm" />
									</>
								}
								leading={<span className="size-2 rounded-full bg-(--sc-accent)" />}
								meta="2m"
								onClick={() => {}}
								selected
								title="Redesign the settings page"
							/>
							<ListRow
								leading={<span className="size-2 rounded-full bg-(--sc-success)" />}
								meta="1h"
								onClick={() => {}}
								title="Fix flaky e2e on Windows"
							/>
							<ListRow
								description="omp-gui · main"
								leading={<FolderGit2 />}
								meta={<Kbd shortcut="⌘1" />}
								onClick={() => {}}
								title="Bundle size investigation"
							/>
							<ListRow disabled leading={<GitBranch />} meta="3d" onClick={() => {}} title="Archived worktree" />
						</Block>
						<Block className="space-y-3" label="SegmentedChoice (a value, applied at once)">
							<SegmentedChoice
								aria-label="Tool approval"
								onChange={setApproval}
								optionAttr="data-styleguide-approval"
								options={[
									{ value: "ask", label: "Ask" },
									{ value: "remember", label: "Remember", name: "Ask and remember" },
									{ value: "full", label: "Full", name: "Full access" },
								]}
								value={approval}
							/>
						</Block>
						<Block className="space-y-2" label="OptionRow (a picker's rows) · LinkButton">
							<div aria-label="Branches" role="listbox">
								<OptionRow active id="styleguide-option-0">
									<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
									main
								</OptionRow>
								<OptionRow active={false} id="styleguide-option-1" size="sm">
									<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
									feature/settings
								</OptionRow>
							</div>
							<p className="text-sc-sm text-(--sc-text-secondary)">
								The judge model needs a key from <LinkButton onClick={() => {}}>OpenRouter</LinkButton>.{" "}
								<LinkButton onClick={() => {}} tone="muted">
									Add a note
								</LinkButton>
							</p>
						</Block>
					</div>
				</Section>

				<Section id="feedback" title="Status & feedback">
					<Block className="flex flex-wrap items-center gap-2" label="Badge">
						<Badge>12 files</Badge>
						<Badge variant="accent">Plan</Badge>
						<Badge dot pulse variant="success">
							Running
						</Badge>
						<Badge variant="warning">Needs approval</Badge>
						<Badge variant="error">Failed</Badge>
						<Badge variant="info">New</Badge>
						<Badge variant="muted">Draft</Badge>
					</Block>
					<Block className="grid grid-cols-2 gap-3" label="Banner">
						<Banner actions={<Button size="sm">Reconnect</Button>} title="omp disconnected" variant="danger">
							The agent process exited. Your session is saved.
						</Banner>
						<Banner onDismiss={() => {}} title="Update ready" variant="info">
							OMPdesk 0.2.0 installs on restart.
						</Banner>
						<Banner variant="warning">omp 18.7 or newer is required. Run omp update.</Banner>
						<Banner onDismiss={() => {}} variant="success">
							Provider connected.
						</Banner>
					</Block>
					<Block className="grid grid-cols-2 items-start gap-3" label="Toast">
						<ToastCard message="Link copied to clipboard." onDismiss={() => {}} variant="success" />
						<ToastCard
							count={3}
							message="The provider rejected the request (401)."
							onDismiss={() => {}}
							title="Couldn't send"
							variant="error"
						/>
						<ToastCard message="Context compacted to 42%." variant="info" />
						<ToastCard message="Rate limited — retrying in 8s." title="Waiting" variant="warning" />
					</Block>
					<div className="grid grid-cols-3 gap-6">
						<Block className="flex items-center gap-4" label="Spinner">
							<Spinner size="sm" />
							<Spinner />
							<Spinner size="lg" />
							<Spinner label="Starting omp…" />
						</Block>
						<Block className="space-y-3" label="ProgressBar">
							<ProgressBar label="Context" value={0.42} />
							<ProgressBar label="Quota" value={0.81} />
							<ProgressBar label="Usage" value={0.94} />
							<ProgressBar ariaLabel="Download" tone="progress" value={0.42} />
							<ProgressBar ariaLabel="Updating omp" tone="progress" />
						</Block>
						<Block label="Tooltip (inline render)">
							<TooltipBubble content="Search sessions" shortcut="⌘K" />
						</Block>
					</div>
					<div className="grid grid-cols-3 gap-6" data-styleguide-wave4>
						<Block className="space-y-3" label="InlineNotice">
							<InlineNotice
								action={<Button size="sm">Retry</Button>}
								detail="ENOENT: no such file or directory, open '~/.omp/agent/sessions'"
								title="Couldn't load sessions."
								tone="danger"
							/>
							<InlineNotice title="Nothing matched this filter." tone="info" />
						</Block>
						<Block className="space-y-3" label="Skeleton">
							<Skeleton className="h-4 w-2/3" />
							<SkeletonRows label="Loading sessions…" widths={[72, 54, 64]} />
						</Block>
						<Block className="flex items-center gap-3" label="CopyButton">
							<code className="font-mono text-sc-sm">omp update</code>
							<CopyButton label="Copy command" text="omp update" />
						</Block>
					</div>
					<div className="grid grid-cols-2 gap-6">
						<Block
							className="rounded-(--sc-radius-lg) border border-(--sc-border-subtle)"
							label="EmptyState — page"
						>
							<EmptyState
								actions={
									<>
										<Button icon={<MessageSquarePlus />} variant="primary">
											New session
										</Button>
										<Button>Open project</Button>
									</>
								}
								description="Start a session to ask omp to read, plan or change code in this project."
								icon={<Bot />}
								title="No sessions yet"
							/>
						</Block>
						<Block
							className="rounded-(--sc-radius-lg) border border-(--sc-border-subtle)"
							label="EmptyState — panel (sm)"
						>
							<EmptyState
								actions={<Button size="sm">Connect GitHub</Button>}
								description="Pull requests appear here once the repository has a GitHub remote."
								icon={<Inbox />}
								size="sm"
								title="No pull requests"
							/>
						</Block>
					</div>
				</Section>

				<Section
					id="overlays"
					intro="Container policy: Dialog for short tasks and pickers, Sheet for contextual detail, Popover for quick anchored controls, Menu for action lists. Never stack overlays. Surfaces are shown inline; the buttons open the live components."
					title="Overlays"
				>
					<div className="flex flex-wrap gap-2">
						<Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
						<Button onClick={() => setSheetOpen(true)}>Open sheet</Button>
						<Button onClick={() => setPopoverOpen(open => !open)} ref={popoverAnchor}>
							Open popover
						</Button>
						<MenuButton items={menuItems} label="Open menu">
							Open menu
						</MenuButton>
						<Tooltip content="Tooltips show after a short hover or on keyboard focus" shortcut="⌘/">
							<Button variant="ghost">Hover for tooltip</Button>
						</Tooltip>
					</div>
					<div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-start gap-6 rounded-(--sc-radius-xl) bg-(--sc-surface-1) p-6">
						<DialogSurface
							footer={
								<>
									<Button variant="ghost">Cancel</Button>
									<Button variant="danger">Delete</Button>
								</>
							}
							onClose={() => {}}
							title="Delete this session?"
						>
							<p className="text-sc-md text-(--sc-text-secondary)">
								“Redesign the settings page” and its 48 messages will be removed from this Mac. This can't be
								undone.
							</p>
						</DialogSurface>
						<div className="space-y-4">
							<MenuSurface>
								{menuItems.map((item, index) => (
									<div className={menuItemClasses(item, index === 0)} key={item.id}>
										<MenuItemView item={item} />
									</div>
								))}
							</MenuSurface>
							<PopoverSurface className="w-72">
								<div className="mb-2 text-sc-sm font-semibold">Run settings</div>
								<SwitchField checked label="Fast mode" onCheckedChange={() => {}} />
								<SwitchField checked={false} label="Auto-retry" onCheckedChange={() => {}} />
							</PopoverSurface>
						</div>
					</div>
					<div className="h-80 overflow-hidden rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-overlay)">
						<div className="ml-auto h-full w-[420px]">
							<SheetSurface
								description="3 files changed · +42 −7"
								footer={<Button variant="primary">Commit</Button>}
								onClose={() => {}}
								title="Changes"
							>
								<ListRow
									leading={<BarChart3 />}
									meta="+30 −2"
									onClick={() => {}}
									title="src/renderer/styles/tokens.css"
								/>
								<ListRow
									leading={<BarChart3 />}
									meta="+10 −5"
									onClick={() => {}}
									title="src/renderer/lib/themes.ts"
								/>
							</SheetSurface>
						</div>
					</div>
				</Section>
			</main>

			<Modal
				footer={
					<>
						<Button onClick={() => setDialogOpen(false)} variant="ghost">
							Cancel
						</Button>
						<Button onClick={() => setDialogOpen(false)} variant="primary">
							Rename
						</Button>
					</>
				}
				onClose={() => setDialogOpen(false)}
				open={dialogOpen}
				size="sm"
				title="Rename session"
			>
				<Input aria-label="Session name" defaultValue="Redesign the settings page" />
			</Modal>
			<Sheet description="Session details" onClose={() => setSheetOpen(false)} open={sheetOpen} title="Session">
				<ListRow meta="acme-opus-5" title="Model" />
				<ListRow meta="42%" title="Context" />
				<ListRow meta="$0.06" title="Cost" />
			</Sheet>
			<Popover
				anchorRef={popoverAnchor}
				ariaLabel="Run settings"
				onClose={() => setPopoverOpen(false)}
				open={popoverOpen}
			>
				<div className="w-64">
					<SwitchField checked label="Fast mode" onCheckedChange={() => {}} />
					<SwitchField checked={false} label="Auto-retry" onCheckedChange={() => {}} />
				</div>
			</Popover>
		</div>
	);
}
