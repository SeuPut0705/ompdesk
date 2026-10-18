/**
 * Variant B — fewer, richer controls. `+` on the left; ONE Run chip (active modes + thinking + approval + delegation
 * in one summary and one popover with sections); the model chip carries the effort ("Sonnet 5.5 · Auto") and opens
 * the model list with the effort row under it; context is a ring; Stop/Send (and the steer chip) have fixed slots.
 *
 * Where everything went: Plan / Goal / Autopilot / Auto mode → Run popover › Mode; Thinking → Run popover and the
 * model chip's popover; Tool approval, Delegation, Fast, Advanced → Run popover; + keeps Attach, History, Expand,
 * Set a goal, Skills.
 */

import { ChevronDown, Cpu, Network, Shield, ShieldAlert, ShieldCheck, SlidersHorizontal, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Tooltip } from "../../../components/common";
import { useT } from "../../../lib/i18n";
import { activeModes, modelOf, type ProtoProps, useFake } from "./fake";
import {
	ApprovalSelect,
	ChipPopover,
	ComposerFrame,
	ContextButton,
	DelegationSelect,
	FastSwitch,
	MicButton,
	ModelList,
	ModesPanel,
	modeGlyph,
	PlusMenu,
	SendButton,
	SteerChip,
	StopButton,
	ThinkingSegments,
	thinkingName,
} from "./parts";

export function VariantB({ width, initial }: ProtoProps) {
	const t = useT();
	const [fake, set] = useFake(initial);
	const ctl = { fake, set };
	const modes = activeModes(fake);
	const model = modelOf(fake);
	const summary =
		modes.length > 0 ? modes.map(mode => t(`input.modes.tab.${mode}`)).join(" · ") : t("input.runSettings.title");
	const ApprovalGlyph =
		fake.approval === "always-ask" ? ShieldCheck : fake.approval === "write" ? Shield : ShieldAlert;
	const full = [
		modes.length > 0 ? modes.map(mode => t(`input.modes.name.${mode}`)).join(" · ") : null,
		t("input.runSettings.summaryThinking", { level: thinkingName(t, fake) }),
		t("input.approval.title", { mode: t(`input.approval.${fake.approval}`) }),
		`${t("input.delegation.title")}: ${t(`input.delegation.mode.${fake.delegation}`)}`,
		fake.fast ? t("input.fast.on") : null,
	]
		.filter(Boolean)
		.join(" · ");

	const runChip = (
		<ChipPopover
			ariaLabel={t("input.runSettings.title")}
			className="w-96 max-w-[calc(100vw-1rem)]"
			id="run"
			trigger={({ ref, open, toggle }) => (
				<Tooltip content={full} describe={false} shortcut="⌃T">
					<Button
						aria-expanded={open}
						aria-haspopup="dialog"
						aria-label={`${t("input.runSettings.title")}: ${full}`}
						className="omp-composer-chip tb-chip tbl-2"
						data-active={modes.length > 0 ? "" : undefined}
						data-proto="run"
						icon={modes.length > 0 ? modeGlyph(modes) : <SlidersHorizontal aria-hidden />}
						onClick={toggle}
						ref={ref}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className="tb-chev text-(--sc-text-subtle)" />}
						variant="ghost"
					>
						<span className="tb-label max-w-64 truncate">{summary}</span>
						{modes.length > 1 && <span className="tb-count">{modes.length}</span>}
						<span className="tb-glyphs inline-flex items-center gap-1 text-(--sc-text-muted)">
							<ApprovalGlyph aria-hidden />
							{fake.delegation !== "default" && <Network aria-hidden />}
							{fake.fast && <Zap aria-hidden className="text-(--sc-accent)" />}
						</span>
					</Button>
				</Tooltip>
			)}
		>
			{() => (
				<div className="flex flex-col gap-3">
					<h2 className="text-sc-sm font-semibold text-(--sc-text)">{t("input.runSettings.title")}</h2>
					<Section title={t("input.modes.label")}>
						<ModesPanel {...ctl} dense />
					</Section>
					<ThinkingSegments {...ctl} />
					<ApprovalSelect {...ctl} />
					<DelegationSelect {...ctl} />
					<FastSwitch {...ctl} />
					<div className="-mx-3 -mb-1 border-t border-(--sc-divider) px-3 pt-1 text-sc-sm text-(--sc-text-muted)">
						{t("input.runSettings.advanced")} ›
					</div>
				</div>
			)}
		</ChipPopover>
	);

	const effort = t(`input.thinking.name.${fake.thinking}`);
	const modelChip = (
		<ChipPopover
			ariaLabel={t("input.model")}
			className="w-96 max-w-[calc(100vw-1rem)]"
			id="model"
			placement="top-end"
			trigger={({ ref, open, toggle }) => (
				<Tooltip content={t("input.modelTooltip", { id: model.id })} shortcut="⌥M">
					<Button
						aria-expanded={open}
						aria-label={`${t("input.modelLabel", { model: model.name })} · ${t("input.runSettings.thinking")}: ${thinkingName(t, fake)}`}
						className="omp-composer-chip tb-chip tb-model tbl-4"
						data-proto="model"
						icon={<Cpu aria-hidden />}
						onClick={toggle}
						ref={ref}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className="tb-chev text-(--sc-text-subtle)" />}
						variant="ghost"
					>
						<span className="tb-model-label truncate">{model.name}</span>
						<span className="tb-effort shrink-0 font-normal text-(--sc-text-muted)">· {effort}</span>
					</Button>
				</Tooltip>
			)}
		>
			{close => (
				<div className="flex flex-col gap-3">
					<ModelList {...ctl} onPick={close} />
					<div className="-mx-3 border-t border-(--sc-divider) px-3 pt-2">
						<ThinkingSegments {...ctl} />
					</div>
				</div>
			)}
		</ChipPopover>
	);

	return (
		<ComposerFrame width={width} {...ctl}>
			<div className="tb-host">
				<div
					aria-label={t("input.toolbar")}
					className="tb-row omp-composer-toolbar"
					data-proto-toolbar
					role="toolbar"
				>
					<div className="tb-left">
						<PlusMenu {...ctl} />
						{runChip}
					</div>
					<div className="tb-spacer" />
					<div className="tb-right">
						{modelChip}
						<ContextButton className="tbl-3" fake={fake} ringOnly />
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
								<StopButton {...ctl} />
							</span>
							<span className="tb-slot" data-slot="send">
								<SendButton {...ctl} />
							</span>
						</div>
					</div>
				</div>
			</div>
		</ComposerFrame>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-1">
			<h3 className="text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase">{title}</h3>
			{children}
		</section>
	);
}
