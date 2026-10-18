/**
 * Variant C — Codex-style footer. `+` · permissions chip on the left; model + effort as ONE chip (combined picker),
 * context ring, mic, steer chip, Stop, Send on the right. The session mode is not a chip: it is painted on the whole
 * composer box (accent outline + a tag sitting on the border, `:has([data-active-modes])`).
 *
 * Where everything went: Plan / Goal / Autopilot / Auto mode → the + menu (toggles) and the tag's popover (while a
 * mode is on); Thinking → the model chip's picker; Tool approval + Delegation + Fast + Advanced → the permissions
 * chip's popover; Attach / History / Expand / Skills stay in +. Label collapse is one container query at 440 px of
 * the COMPOSER's width.
 */

import { ChevronDown, Cpu, Network, Shield, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
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

export function VariantC({ width, initial }: ProtoProps) {
	const t = useT();
	const [fake, set] = useFake(initial);
	const ctl = { fake, set };
	const modes = activeModes(fake);
	const model = modelOf(fake);
	const modesText = modes.map(mode => t(`input.modes.name.${mode}`)).join(" · ");
	const ApprovalGlyph =
		fake.approval === "always-ask" ? ShieldCheck : fake.approval === "write" ? Shield : ShieldAlert;
	const approvalName = t(`input.approval.${fake.approval}`);

	const tag =
		modes.length > 0 ? (
			<ChipPopover
				ariaLabel={t("input.modes.label")}
				className="w-96 max-w-[calc(100vw-1rem)]"
				id="mode"
				trigger={({ ref, open, toggle }) => (
					<Tooltip content={t("input.modes.title")} describe={false} shortcut="⌥⇧P">
						<button
							aria-expanded={open}
							aria-haspopup="dialog"
							aria-label={t("input.modes.activeTitle", { modes: modesText })}
							className="tb-c-tag"
							data-active-modes={modes.join(" ")}
							data-proto="mode"
							onClick={toggle}
							ref={ref}
							type="button"
						>
							{modeGlyph(modes)}
							<span>{modesText}</span>
							<ChevronDown aria-hidden />
						</button>
					</Tooltip>
				)}
			>
				{() => <ModesPanel {...ctl} />}
			</ChipPopover>
		) : null;

	const permissionsChip = (
		<ChipPopover
			ariaLabel={t("input.runSettings.title")}
			className="w-80"
			id="run"
			trigger={({ ref, open, toggle }) => (
				<Tooltip
					content={`${t("input.approval.title", { mode: approvalName })} · ${t("input.delegation.title")}: ${t(`input.delegation.mode.${fake.delegation}`)}`}
					describe={false}
				>
					<Button
						aria-expanded={open}
						aria-haspopup="dialog"
						aria-label={`${t("input.runSettings.title")}: ${t("input.approval.title", { mode: approvalName })}, ${t("input.delegation.title")}: ${t(`input.delegation.mode.${fake.delegation}`)}`}
						className="omp-composer-chip tb-chip tbc-1"
						data-proto="run"
						icon={<ApprovalGlyph aria-hidden />}
						onClick={toggle}
						ref={ref}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className="tb-chev text-(--sc-text-subtle)" />}
						variant="ghost"
					>
						<span className="tb-label">{approvalName}</span>
						{fake.delegation !== "default" && <Network aria-hidden className="text-(--sc-text-muted)" />}
						{fake.fast && <Zap aria-hidden className="text-(--sc-accent)" />}
					</Button>
				</Tooltip>
			)}
		>
			{() => (
				<div className="flex flex-col gap-3">
					<h2 className="text-sc-sm font-semibold text-(--sc-text)">{t("input.runSettings.title")}</h2>
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
						className="omp-composer-chip tb-chip tb-model tbc-1"
						data-proto="model"
						icon={<Cpu aria-hidden />}
						onClick={toggle}
						ref={ref}
						size="sm"
						trailingIcon={<ChevronDown aria-hidden className="tb-chev text-(--sc-text-subtle)" />}
						variant="ghost"
					>
						<span className="tb-model-label truncate">{model.name}</span>
						<span className="tb-effort shrink-0 font-normal text-(--sc-text-muted)">
							· {t(`input.thinking.name.${fake.thinking}`)}
						</span>
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
		<ComposerFrame boxClass="tb-c-box" extra={tag} frameClass="proto-frame--c" width={width} {...ctl}>
			<div aria-label={t("input.toolbar")} className="tb-row omp-composer-toolbar" data-proto-toolbar role="toolbar">
				<div className="tb-left">
					<PlusMenu {...ctl} withModes />
					{permissionsChip}
				</div>
				<div className="tb-spacer" />
				<div className="tb-right">
					{modelChip}
					<ContextButton fake={fake} ringOnly />
					<MicButton {...ctl} />
					<span
						className="tb-slot"
						data-off={fake.running ? undefined : ""}
						data-slot="steer"
						inert={!fake.running}
					>
						<SteerChip {...ctl} className="tbc-1" />
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
		</ComposerFrame>
	);
}
