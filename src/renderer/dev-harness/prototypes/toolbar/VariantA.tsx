/**
 * Variant A (and `base`, the current production toolbar replayed with the same components): keep the structure
 * — + · Mode · Run settings · Delegation · … · model · context · mic · steer · Stop · Send — and fix it.
 *
 * `legacy` = production as of 79381e87: labels fold by the PANE width through the real `omp-workspace` container
 * ladder in components.css, Stop/steer mount and unmount with the turn, the accent of an active Mode chip is a
 * class that ties with the Button's own variant classes (DR-1).
 * A (not legacy): the toolbar is its own container (`tb`), the label ladder follows ITS width in four levels,
 * Stop and the steer chip keep a reserved slot (hidden, not unmounted), the accent is `data-active`.
 */

import { Brain, ChevronDown, Cpu, Network, ShieldCheck, Zap } from "lucide-react";
import { Button, Tooltip } from "../../../components/common";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { activeModes, modelOf, type ProtoProps, useFake } from "./fake";
import {
	ApprovalSelect,
	ChipPopover,
	ComposerFrame,
	ContextButton,
	DelegationList,
	FastSwitch,
	MicButton,
	ModelList,
	ModesPanel,
	modeGlyph,
	modeLabel,
	PlusMenu,
	SendButton,
	SteerChip,
	StopButton,
	ThinkingSelect,
	thinkingName,
} from "./parts";

const LEGACY_ACCENT = "bg-(--sc-accent-soft) text-(--sc-accent) hover:bg-(--sc-accent-soft) hover:text-(--sc-accent)";

export function VariantA({ width, initial, legacy = false }: ProtoProps & { legacy?: boolean }) {
	const t = useT();
	const [fake, set] = useFake(initial);
	const ctl = { fake, set };
	const modes = activeModes(fake);
	const model = modelOf(fake);
	const modesText = modes.length > 0 ? modes.map(mode => modeLabel(t, mode)).join(" · ") : t("input.modes.label");
	const withDraft = fake.draft.trim() !== "";

	// Production's markers (legacy) or the ladder level of this prototype.
	const label = (level: 1 | 2 | 3) =>
		(legacy ? "omp-composer-control-label" : "tb-label") + (legacy && level < 3 ? " omp-composer-label-early" : "");
	const chev = legacy ? "omp-composer-chevron text-(--sc-text-subtle)" : "tb-chev text-(--sc-text-subtle)";
	const chip = (level: 1 | 2 | 3 | 4) => cx("omp-composer-chip", !legacy && `tb-chip tbl-${level}`);

	const modeChip = (
		<ChipPopover
			ariaLabel={t("input.modes.label")}
			className="w-96 max-w-[calc(100vw-1rem)]"
			id="mode"
			trigger={({ ref, open, toggle }) => (
				<Tooltip content={t("input.modes.title")} describe={false} shortcut="⌥⇧P">
					<Button
						aria-expanded={open}
						aria-haspopup="dialog"
						aria-label={
							modes.length > 0 ? t("input.modes.activeTitle", { modes: modesText }) : t("input.modes.title")
						}
						className={cx(chip(2), legacy && modes.length > 0 && LEGACY_ACCENT)}
						data-active={!legacy && modes.length > 0 ? "" : undefined}
						data-proto="mode"
						icon={modeGlyph(modes)}
						onClick={toggle}
						ref={ref}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className={chev} />}
						variant="ghost"
					>
						<span className={cx(label(2), "max-w-64 truncate")}>{modesText}</span>
						{!legacy && modes.length > 1 && <span className="tb-count">{modes.length}</span>}
					</Button>
				</Tooltip>
			)}
		>
			{() => <ModesPanel {...ctl} />}
		</ChipPopover>
	);

	const runChip = (
		<ChipPopover
			ariaLabel={t("input.runSettings.title")}
			className="w-80"
			id="run"
			trigger={({ ref, open, toggle }) => (
				<Tooltip content={t("input.runSettings.title")} describe={false} shortcut="⌃T">
					<Button
						aria-expanded={open}
						aria-haspopup="dialog"
						aria-label={`${t("input.runSettings.title")}: ${thinkingName(t, fake)}, ${t("input.approval.title", { mode: t(`input.approval.${fake.approval}`) })}`}
						className={chip(3)}
						data-proto="run"
						icon={<Brain aria-hidden />}
						onClick={toggle}
						ref={ref}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className={chev} />}
						variant="ghost"
					>
						<span className={label(3)}>{thinkingName(t, fake)}</span>
						{legacy ? (
							<>
								{fake.fast && <Zap aria-hidden className="text-(--sc-accent)" />}
								{fake.approval !== "yolo" && <ShieldCheck aria-hidden className="text-(--sc-text-muted)" />}
							</>
						) : (
							<span className="tb-glyphs-a inline-flex items-center gap-1.5">
								{fake.fast && <Zap aria-hidden className="text-(--sc-accent)" />}
								{fake.approval !== "yolo" && <ShieldCheck aria-hidden className="text-(--sc-text-muted)" />}
							</span>
						)}
					</Button>
				</Tooltip>
			)}
		>
			{() => (
				<div className="flex flex-col gap-3">
					<h2 className="text-sc-sm font-semibold text-(--sc-text)">{t("input.runSettings.title")}</h2>
					<ThinkingSelect {...ctl} />
					<FastSwitch {...ctl} />
					<ApprovalSelect {...ctl} />
					<div className="-mx-3 -mb-1 border-t border-(--sc-divider) px-3 pt-1 text-sc-sm text-(--sc-text-muted)">
						{t("input.runSettings.advanced")} ›
					</div>
				</div>
			)}
		</ChipPopover>
	);

	const delegationChip = (
		<ChipPopover
			ariaLabel={t("input.delegation.title")}
			className="w-80"
			id="delegation"
			trigger={({ ref, open, toggle }) => (
				<Tooltip content={t("input.delegation.title")} describe={false}>
					<Button
						aria-expanded={open}
						aria-haspopup="dialog"
						aria-label={`${t("input.delegation.title")}: ${t(`input.delegation.mode.${fake.delegation}`)}`}
						className={chip(1)}
						data-proto="delegation"
						icon={<Network aria-hidden />}
						onClick={toggle}
						ref={ref}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className={chev} />}
						variant="ghost"
					>
						{fake.delegation !== "default" && (
							<span className={label(1)}>{t(`input.delegation.mode.${fake.delegation}`)}</span>
						)}
					</Button>
				</Tooltip>
			)}
		>
			{() => <DelegationList {...ctl} />}
		</ChipPopover>
	);

	const modelChip = (
		<ChipPopover
			ariaLabel={t("input.model")}
			className="w-72"
			id="model"
			placement="top-end"
			trigger={({ ref, open, toggle }) => (
				<Tooltip content={t("input.modelTooltip", { id: model.id })} shortcut="⌥M">
					<Button
						aria-expanded={open}
						aria-label={t("input.modelLabel", { model: model.name })}
						className={cx(chip(4), legacy ? "min-w-0 max-w-56" : "tb-model")}
						data-proto="model"
						icon={<Cpu aria-hidden className="omp-composer-model-icon" />}
						onClick={toggle}
						ref={ref}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className={chev} />}
						variant="ghost"
					>
						<span className={cx(legacy ? "omp-composer-model-label" : "tb-model-label", "truncate")}>
							{model.name}
						</span>
					</Button>
				</Tooltip>
			)}
		>
			{close => <ModelList {...ctl} onPick={close} />}
		</ChipPopover>
	);

	const ctx = legacy ? (
		<ContextButton fake={fake} pctClass="omp-context-usage-label" />
	) : (
		<ContextButton className="tbl-3" fake={fake} />
	);

	const stop = <StopButton {...ctl} />;
	const send = <SendButton {...ctl} />;
	const showSend = !fake.running || withDraft;

	const left = (
		<>
			<PlusMenu {...ctl} />
			{modeChip}
			{runChip}
			{delegationChip}
		</>
	);

	if (legacy) {
		return (
			<ComposerFrame frameClass="proto-frame--base" width={width} {...ctl}>
				<div
					aria-label={t("input.toolbar")}
					className="omp-composer-toolbar flex min-h-11 flex-wrap items-center gap-1 pr-2.5 pb-2.5 pl-2"
					data-proto-toolbar
					role="toolbar"
				>
					{left}
					<div className="flex-1" />
					<div className="omp-composer-send-cluster flex shrink-0 items-center gap-1">
						{modelChip}
						{ctx}
						<MicButton {...ctl} />
						{fake.running && (
							<SteerChip
								{...ctl}
								className="omp-composer-chip"
								labelClass="omp-composer-control-label omp-composer-label-early"
							/>
						)}
						<div className="ml-1 flex items-center gap-1.5">
							{fake.running && stop}
							{showSend && send}
						</div>
					</div>
				</div>
			</ComposerFrame>
		);
	}

	return (
		<ComposerFrame width={width} {...ctl}>
			<div className="tb-host">
				<div
					aria-label={t("input.toolbar")}
					className="tb-row omp-composer-toolbar"
					data-proto-toolbar
					role="toolbar"
				>
					<div className="tb-left">{left}</div>
					<div className="tb-spacer" />
					<div className="tb-right">
						{modelChip}
						{ctx}
						<MicButton {...ctl} />
						<span
							className="tb-slot"
							data-off={fake.running ? undefined : ""}
							data-slot="steer"
							inert={!fake.running}
						>
							<SteerChip {...ctl} className="tbl-1" />
						</span>
						<div className="tb-send-pair">
							<span
								className="tb-slot"
								data-off={fake.running ? undefined : ""}
								data-slot="stop"
								inert={!fake.running}
							>
								{stop}
							</span>
							<span className="tb-slot" data-slot="send">
								{send}
							</span>
						</div>
					</div>
				</div>
			</div>
		</ComposerFrame>
	);
}
