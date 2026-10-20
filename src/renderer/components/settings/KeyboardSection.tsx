/**
 * Settings › Keyboard: the shortcut reference with per-row remap (plan/17
 * §6.2, B3) — the data-driven replacement for the TUI's static /hotkeys
 * markdown. Remappable rows come from lib/keymap.ts's action table and
 * non-remappable rows from its reserved-chord table, so an action can exist
 * only with a row here, and the same chords the recorder conflict-checks
 * against are the ones on display. Unmodified keys (Enter, @, /) and the
 * Esc global stay static; terminal-only TUI rows
 * (suspend, display reset, $EDITOR) are deliberately absent.
 *
 * The page search passes `query`; it filters rows by label and chord.
 */

import { Keyboard, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
	chordFromEvent,
	chordOwner,
	detectConflicts,
	formatChord,
	formatShortcut,
	type HotkeyGroupId,
	KEYMAP_ACTION_BY_ID,
	KEYMAP_ACTIONS,
	type KeymapActionId,
	type KeymapConflict,
	keymapActionsForGroup,
	platformDefaults,
	type ReservedChordGroup,
	reservedChordsForGroup,
} from "../../lib/keymap";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Kbd, SettingInfo } from "../common";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

interface StaticHotkeyRow {
	/** macOS spelling (⌘ = CmdOrCtrl); formatted for the platform on display. */
	keys: string;
	labelKey: string;
}

/** Remappable row: label + current chords resolve from the keymap action table. */
interface RemapHotkeyRow {
	actionId: KeymapActionId;
}

type HotkeyRow = StaticHotkeyRow | RemapHotkeyRow;

interface HotkeyGroup {
	id: string;
	titleKey: string;
	rows: HotkeyRow[];
}

/** Remappable rows for a group, straight from the registry. */
function remapRows(group: HotkeyGroupId): HotkeyRow[] {
	return keymapActionsForGroup(group).map(action => ({ actionId: action.id }));
}

/** Non-remappable rows for an owner class (composer keys, native chords). */
function reservedRows(group: ReservedChordGroup): HotkeyRow[] {
	return reservedChordsForGroup(group).map(entry => ({ keys: entry.chord, labelKey: entry.labelKey }));
}

const HOTKEY_GROUPS: HotkeyGroup[] = [
	{
		id: "input",
		titleKey: "hotkeys.group.input",
		rows: [
			{ keys: "Enter", labelKey: "hotkeys.row.send" },
			{ keys: "⇧Enter", labelKey: "hotkeys.row.newline" },
			{ keys: "-> / =>", labelKey: "hotkeys.row.queueShorthand" },
			{ keys: "!", labelKey: "hotkeys.row.bashMode" },
			{ keys: "$", labelKey: "hotkeys.row.pythonMode" },
			{ keys: "@", labelKey: "hotkeys.row.mention" },
			{ keys: "/", labelKey: "hotkeys.row.commands" },
			{ keys: "↑ / ↓", labelKey: "hotkeys.row.historyNav" },
			...reservedRows("input"),
		],
	},
	{
		id: "generation",
		titleKey: "hotkeys.group.generation",
		rows: [{ keys: "Esc", labelKey: "hotkeys.row.abort" }, ...remapRows("generation")],
	},
	{ id: "view", titleKey: "hotkeys.group.view", rows: remapRows("view") },
	{ id: "session", titleKey: "hotkeys.group.session", rows: remapRows("session") },
	{ id: "native", titleKey: "hotkeys.group.native", rows: reservedRows("native") },
];

interface ResolvedRow {
	label: string;
	/** macOS spelling handed to Kbd (alternatives joined by " / "). */
	shortcut: string;
	/** Platform-formatted text the filter matches against. */
	display: string;
	actionId: KeymapActionId | null;
}

interface CaptureState {
	actionId: KeymapActionId;
	chord: string | null;
}

/** Hover-revealed row controls: opacity + focus-within, never display:none. */
const REVEAL_CLASS =
	"opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

export function KeyboardSection({ query }: { query: string }) {
	const t = useT();
	const overrides = useUiStore(s => s.keymapOverrides);
	const setKeymapOverride = useUiStore(s => s.setKeymapOverride);
	const resetKeymapOverrides = useUiStore(s => s.resetKeymapOverrides);
	const [capture, setCapture] = useState<CaptureState | null>(null);
	const [confirmingResetAll, setConfirmingResetAll] = useState(false);

	// Capture mode: swallow every key at window-capture phase so nothing leaks
	// to App's global handler (window bubble) or the page's Escape-back
	// (document) — later phases than window capture. Esc cancels.
	useEffect(() => {
		if (!capture) return;
		const onCaptureKey = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") {
				setCapture(null);
				return;
			}
			const chord = chordFromEvent(event);
			if (chord) setCapture(current => (current ? { ...current, chord } : current));
		};
		window.addEventListener("keydown", onCaptureKey, true);
		return () => window.removeEventListener("keydown", onCaptureKey, true);
	}, [capture]);

	// A new search can hide the row being rebound; drop the capture rather than
	// keep swallowing keys for a row the user no longer sees.
	const [captureQuery, setCaptureQuery] = useState(query);
	if (captureQuery !== query) {
		setCaptureQuery(query);
		setCapture(null);
	}

	const captureAction = capture ? KEYMAP_ACTION_BY_ID[capture.actionId] : null;

	// Live conflict display for the captured chord: a native owner or a second
	// user binding blocks the save, a shadowed default or the composer's own key
	// only warns (the user binding wins the slot outside those contexts).
	const captureConflict: KeymapConflict | null = useMemo(() => {
		if (!capture?.chord) return null;
		const candidate = { ...overrides, [capture.actionId]: [capture.chord] };
		return detectConflicts(KEYMAP_ACTIONS, candidate).find(conflict => conflict.chord === capture.chord) ?? null;
	}, [capture, overrides]);

	const captureConflictLabel = useMemo(() => {
		if (!capture || !captureConflict) return null;
		const otherId = captureConflict.actionIds.find(id => id !== capture.actionId);
		const other = otherId ? chordOwner(otherId) : undefined;
		const params = { action: other ? t(other.labelKey) : (otherId ?? "") };
		if (other && other.holds !== "action")
			return t(other.holds === "native" ? "hotkeys.remap.conflictNative" : "hotkeys.remap.conflictInput", params);
		return captureConflict.kind === "error"
			? t("hotkeys.remap.conflictUser", params)
			: t("hotkeys.remap.conflictShadow", params);
	}, [capture, captureConflict, t]);

	const groups = useMemo(() => {
		const resolve = (row: HotkeyRow): ResolvedRow => {
			if ("actionId" in row) {
				const action = KEYMAP_ACTION_BY_ID[row.actionId];
				const chords = overrides[action.id] ?? platformDefaults(action);
				return {
					label: t(action.labelKey),
					shortcut: chords.join(" / "),
					display: chords.map(chord => formatChord(chord)).join(" / "),
					actionId: row.actionId,
				};
			}
			return { label: t(row.labelKey), shortcut: row.keys, display: formatShortcut(row.keys), actionId: null };
		};
		const q = query.trim().toLowerCase();
		return HOTKEY_GROUPS.map(group => ({
			...group,
			rows: group.rows
				.map(resolve)
				.filter(row => !q || row.label.toLowerCase().includes(q) || row.display.toLowerCase().includes(q)),
		})).filter(group => group.rows.length > 0);
	}, [query, t, overrides]);

	const saveCapture = () => {
		if (!capture?.chord || !captureAction || captureConflict?.kind === "error") return;
		setKeymapOverride(capture.actionId, [capture.chord]);
		toast({
			variant: "success",
			message: t("hotkeys.remap.saved", { action: t(captureAction.labelKey), chord: formatChord(capture.chord) }),
		});
		setCapture(null);
	};

	const resetRow = (actionId: KeymapActionId) => {
		setKeymapOverride(actionId, []);
		toast({
			variant: "success",
			message: t("hotkeys.remap.resetDone", { action: t(KEYMAP_ACTION_BY_ID[actionId].labelKey) }),
		});
	};

	const confirmResetAll = () => {
		resetKeymapOverrides();
		setConfirmingResetAll(false);
		setCapture(null);
		toast({ variant: "success", message: t("hotkeys.remap.resetAllDone") });
	};

	const hasOverrides = Object.keys(overrides).length > 0;

	return (
		<div>
			{/* Reset all and the how-to belong to the page, not to its first group. 20 px apart on every input: on
			    touch the glyph and the button each reach 10 px, and never each other's. */}
			<div className="mb-2 flex items-center justify-end gap-5 [--hit-gap-x:20px]" data-hotkeys-toolbar>
				<SettingInfo text={t("hotkeys.description")} />
				<Button
					disabled={!hasOverrides}
					icon={<RotateCcw />}
					onClick={() => setConfirmingResetAll(true)}
					size="sm"
					variant="ghost"
				>
					{t("hotkeys.remap.resetAll")}
				</Button>
			</div>
			{groups.length === 0 && <EmptyState icon={<Keyboard />} size="sm" title={t("hotkeys.empty")} />}
			{groups.map(group => (
				<SettingsSection id={`keyboard-${group.id}`} key={group.id} title={t(group.titleKey)}>
					{group.rows.map(row => {
						const actionId = row.actionId;
						const hasOverride = actionId ? overrides[actionId] !== undefined : false;
						const capturing = actionId !== null && capture?.actionId === actionId;
						return (
							<SettingsRow
								badge={hasOverride ? <Badge variant="accent">{t("hotkeys.remap.custom")}</Badge> : undefined}
								className="group"
								compactControl
								control={
									<span className="flex items-center justify-end gap-1">
										{actionId && (
											<>
												{hasOverride && (
													<IconButton
														className={REVEAL_CLASS}
														icon={<RotateCcw />}
														label={t("hotkeys.remap.reset")}
														onClick={() => resetRow(actionId)}
														size="sm"
													/>
												)}
												<IconButton
													className={cx(!capturing && REVEAL_CLASS)}
													icon={<Pencil />}
													label={t("hotkeys.remap.rebind")}
													onClick={() => setCapture({ actionId, chord: null })}
													size="sm"
												/>
											</>
										)}
										<span className="ml-1" data-hotkey-keys="" data-hotkey-action={actionId ?? undefined}>
											{/* An action with no chord says so in words, never an empty key box. */}
											{row.shortcut ? (
												<Kbd shortcut={row.shortcut} />
											) : (
												<span className="text-sc-xs text-(--sc-text-muted)">{t("hotkeys.unbound")}</span>
											)}
										</span>
									</span>
								}
								footer={
									capturing && captureAction ? (
										<div className="mt-2 flex flex-col gap-1 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-2) px-3 py-2">
											<div className="flex flex-wrap items-center gap-2">
												<span className="min-w-0 flex-1 truncate text-sc-md text-(--sc-text)" role="status">
													{t("hotkeys.remap.rebinding", { action: t(captureAction.labelKey) })}
												</span>
												{capture?.chord ? (
													<Kbd shortcut={capture.chord} />
												) : (
													<span className="text-sc-sm text-(--sc-text-muted)">
														{t("hotkeys.remap.pressChord")}
													</span>
												)}
												<Button onClick={() => setCapture(null)} size="sm" variant="ghost">
													{t("common.cancel")}
												</Button>
												<Button
													disabled={!capture?.chord || captureConflict?.kind === "error"}
													onClick={saveCapture}
													size="sm"
													variant="primary"
												>
													{t("common.save")}
												</Button>
											</div>
											<span className="text-sc-xs text-(--sc-text-muted)">
												{t("hotkeys.remap.captureHint")}
											</span>
											{captureConflictLabel && (
												<span
													className={cx(
														"text-sc-sm",
														captureConflict?.kind === "error"
															? "text-(--sc-danger)"
															: "text-(--sc-warning)",
													)}
													role="alert"
												>
													{captureConflictLabel}
												</span>
											)}
										</div>
									) : undefined
								}
								id={actionId ? `keyboard-action-${actionId}` : undefined}
								key={actionId ?? row.label}
								label={row.label}
							/>
						);
					})}
				</SettingsSection>
			))}
			<ConfirmDialog
				confirmLabel={t("hotkeys.remap.resetAll")}
				message={t("hotkeys.remap.resetAllConfirm")}
				onCancel={() => setConfirmingResetAll(false)}
				onConfirm={confirmResetAll}
				open={confirmingResetAll}
				title={t("hotkeys.remap.resetAllTitle")}
			/>
		</div>
	);
}
