/**
 * Settings › Bot, while the bot is on: who the bot is (its avatar, tagline and persona: dots' character, Muse's
 * Identity and Soul, Grok's picture and label), where its notices reach the owner (dots' channel routing, Muse's and
 * Duet's "how often") and whether its replies are spoken. All of it is the desk's (`shared/bot-desk.ts`), so the
 * bot's prompt, its bar and sidebar row, and a paired device's view follow every change; each control writes through
 * `useBotDeskStore.edit` and shows what main kept.
 */
import { ImageUp, MessageSquareQuote, Palette, Sparkles, UserRound, Volume2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
	BOT_AVATAR_COLORS,
	BOT_AVATAR_SHAPES,
	BOT_NOTIFY_KINDS,
	BOT_NOTIFY_ROUTES,
	BOT_PERSONA_MAX,
	BOT_PROGRESS_EVERY,
	BOT_TAGLINE_MAX,
	type BotNotify,
	type BotNotifyKind,
	type BotNotifyRoute,
} from "../../../shared/bot-desk";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { ensureBotDesk, useBotDesk, useBotDeskStore } from "../../stores/bot-desk";
import { toast, toastError } from "../../stores/toast";
import { AvatarImageError, avatarDataUrl, BOT_AVATAR_ACCEPT } from "../bot/avatar-image";
import { BOT_SHAPE_ICONS, BOT_TILE_CLASSES, BotAvatar } from "../bot/BotAvatar";
import { Button, IconButton, Input, Modal, Select, TextArea } from "../common";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";

function notifyField(kind: BotNotifyKind, route: BotNotifyRoute): Partial<Pick<BotNotify, BotNotifyKind>> {
	return { [kind]: route };
}
/** A text field that saves when it loses focus (or Enter, single line), and shows main's value otherwise. */
function useDraft(stored: string) {
	const [draft, setDraft] = useState(stored);
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		if (!editing) setDraft(stored);
	}, [editing, stored]);
	return { draft, setDraft, editing, setEditing };
}

function AvatarRow() {
	const t = useT();
	const { desk } = useBotDesk();
	const edit = useBotDeskStore(state => state.edit);
	const fileRef = useRef<HTMLInputElement>(null);
	const [generating, setGenerating] = useState(false);
	const avatar = desk.identity.avatar;
	const mark = avatar.kind === "mark" ? avatar : null;
	const upload = async (file: File | undefined) => {
		if (!file) return;
		try {
			const dataUrl = await avatarDataUrl(file);
			await edit({ op: "identity", avatar: { kind: "image", dataUrl } });
		} catch (error) {
			toastError({
				title: t("botIdentity.uploadFailed"),
				error: error instanceof AvatarImageError ? t(`botIdentity.uploadError.${error.reason}`) : error,
			});
		}
	};
	return (
		<SettingsRow
			description={t("botIdentity.avatarDesc")}
			icon={<Palette />}
			id="setting-bot-avatar"
			label={t("botIdentity.avatar")}
		>
			<div className="flex flex-wrap items-start gap-4 pt-2" data-bot-avatar-editor>
				<BotAvatar avatar={avatar} label={t("botIdentity.avatarPreview")} size="lg" />
				<div className="flex min-w-0 flex-1 flex-col gap-2">
					<div aria-label={t("botIdentity.shape")} className="flex flex-wrap gap-1" role="group">
						{BOT_AVATAR_SHAPES.map(shape => {
							const Icon = BOT_SHAPE_ICONS[shape];
							return (
								<IconButton
									data-bot-avatar-shape={shape}
									icon={<Icon />}
									key={shape}
									label={t(`botIdentity.shapes.${shape}`)}
									onClick={() =>
										void edit({
											op: "identity",
											avatar: { kind: "mark", shape, color: mark?.color ?? "accent" },
										})
									}
									pressed={mark?.shape === shape}
									size="sm"
								/>
							);
						})}
					</div>
					<div aria-label={t("botIdentity.color")} className="flex flex-wrap gap-1" role="group">
						{BOT_AVATAR_COLORS.map(color => (
							<IconButton
								data-bot-avatar-color={color}
								icon={
									<span
										aria-hidden
										className={`size-3.5 rounded-full border border-(--sc-border) ${BOT_TILE_CLASSES[color]}`}
									/>
								}
								key={color}
								label={t(`botIdentity.colors.${color}`)}
								onClick={() =>
									void edit({ op: "identity", avatar: { kind: "mark", shape: mark?.shape ?? "bot", color } })
								}
								pressed={mark?.color === color}
								size="sm"
							/>
						))}
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							data-bot-avatar-upload
							icon={<ImageUp />}
							onClick={() => fileRef.current?.click()}
							size="sm"
							variant="secondary"
						>
							{t("botIdentity.upload")}
						</Button>
						<input
							accept={BOT_AVATAR_ACCEPT}
							aria-hidden
							className="hidden"
							data-bot-avatar-file
							onChange={event => {
								void upload(event.target.files?.[0]);
								event.target.value = "";
							}}
							ref={fileRef}
							tabIndex={-1}
							type="file"
						/>
						<Button
							data-bot-avatar-generate
							icon={<Sparkles />}
							onClick={() => setGenerating(true)}
							size="sm"
							variant="secondary"
						>
							{t("botIdentity.generate")}
						</Button>
					</div>
				</div>
			</div>
			<GenerateDialog onClose={() => setGenerating(false)} open={generating} />
		</SettingsRow>
	);
}

/** The owner describes the avatar; the bot draws it (`generate_image`) and sets it itself. */
function GenerateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const id = useId();
	const [description, setDescription] = useState("");
	const send = async () => {
		const text = description.trim();
		if (!text) return;
		if (await edit({ op: "avatar_generate", description: text })) {
			toast({ message: t("botIdentity.generateSent") });
			setDescription("");
			onClose();
		}
	};
	return (
		<Modal
			description={t("botIdentity.generateDesc")}
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button data-bot-avatar-generate-send disabled={!description.trim()} onClick={() => void send()}>
						{t("botIdentity.generateSend")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="sm"
			title={t("botIdentity.generateTitle")}
		>
			<TextArea
				aria-labelledby={id}
				data-bot-avatar-description
				maxLength={500}
				onChange={event => setDescription(event.target.value)}
				placeholder={t("botIdentity.generatePlaceholder")}
				value={description}
			/>
			<span className="sr-only" id={id}>
				{t("botIdentity.generateTitle")}
			</span>
		</Modal>
	);
}

function TaglineRow() {
	const t = useT();
	const inputId = useId();
	const stored = useBotDesk().desk.identity.tagline;
	const edit = useBotDeskStore(state => state.edit);
	const { draft, setDraft, setEditing } = useDraft(stored);
	const commit = (value: string) => {
		setEditing(false);
		if (value.trim() !== stored) void edit({ op: "identity", tagline: value.trim() });
	};
	return (
		<SettingsRow
			control={
				<Input
					controlSize="sm"
					data-bot-tagline-field
					id={inputId}
					maxLength={BOT_TAGLINE_MAX}
					onBlur={event => commit(event.currentTarget.value)}
					onChange={event => setDraft(event.target.value)}
					onFocus={() => setEditing(true)}
					onKeyDown={event => {
						if (isImeKeyEvent(event)) return;
						if (event.key === "Enter") event.currentTarget.blur();
					}}
					placeholder={t("botIdentity.taglinePlaceholder")}
					value={draft}
				/>
			}
			description={t("botIdentity.taglineDesc")}
			htmlFor={inputId}
			icon={<MessageSquareQuote />}
			label={t("botIdentity.tagline")}
		/>
	);
}

function PersonaRow() {
	const t = useT();
	const inputId = useId();
	const stored = useBotDesk().desk.identity.persona;
	const edit = useBotDeskStore(state => state.edit);
	const { draft, setDraft, setEditing } = useDraft(stored);
	return (
		<SettingsRow
			description={t("botIdentity.personaDesc")}
			htmlFor={inputId}
			icon={<UserRound />}
			label={t("botIdentity.persona")}
		>
			<div className="pt-2">
				<TextArea
					data-bot-persona-field
					id={inputId}
					maxLength={BOT_PERSONA_MAX}
					onBlur={event => {
						setEditing(false);
						const next = event.currentTarget.value.trim();
						if (next !== stored) void edit({ op: "identity", persona: next });
					}}
					onChange={event => setDraft(event.target.value)}
					onFocus={() => setEditing(true)}
					placeholder={t("botIdentity.personaPlaceholder")}
					value={draft}
				/>
			</div>
		</SettingsRow>
	);
}

function NotifyRows() {
	const t = useT();
	const notify = useBotDesk().desk.notify;
	const edit = useBotDeskStore(state => state.edit);
	const routes = BOT_NOTIFY_ROUTES.map(value => ({ value, label: t(`botNotify.route.${value}`) }));
	return (
		<>
			{BOT_NOTIFY_KINDS.map(kind => (
				<SettingsRow
					control={
						<div className="w-44">
							<Select
								aria-label={t(`botNotify.kind.${kind}`)}
								controlSize="sm"
								data-bot-notify={kind}
								onChange={event => {
									const route = BOT_NOTIFY_ROUTES.find(value => value === event.target.value);
									if (route) void edit({ op: "notify", ...notifyField(kind, route) });
								}}
								options={routes}
								value={notify[kind]}
							/>
						</div>
					}
					description={t(`botNotify.kindDesc.${kind}`)}
					key={kind}
					label={t(`botNotify.kind.${kind}`)}
				/>
			))}
			<SettingsRow
				control={
					<div className="w-44">
						<Select
							aria-label={t("botNotify.every")}
							controlSize="sm"
							data-bot-notify-every
							disabled={notify.progress === "quiet"}
							onChange={event => {
								const every = BOT_PROGRESS_EVERY.find(value => value === event.target.value);
								if (every) void edit({ op: "notify", progressEvery: every });
							}}
							options={BOT_PROGRESS_EVERY.map(value => ({ value, label: t(`botNotify.everyOption.${value}`) }))}
							value={notify.progressEvery}
						/>
					</div>
				}
				description={t("botNotify.everyDesc")}
				label={t("botNotify.every")}
			/>
		</>
	);
}

export function BotIdentitySettings() {
	const t = useT();
	const { desk, loaded } = useBotDesk();
	const edit = useBotDeskStore(state => state.edit);
	// The sidebar reads the desk at launch; a phone's page may never have opened its drawer.
	useEffect(() => ensureBotDesk(), []);
	if (!loaded) return null;
	return (
		<>
			<SettingsSection description={t("botIdentity.desc")} id="settings-bot-identity" title={t("botIdentity.title")}>
				<AvatarRow />
				<TaglineRow />
				<PersonaRow />
			</SettingsSection>
			<SettingsSection description={t("botNotify.desc")} id="settings-bot-notify" title={t("botNotify.title")}>
				<NotifyRows />
			</SettingsSection>
			<SettingsSection id="settings-bot-voice">
				<SettingsSwitchRow
					checked={desk.voice.speakReplies}
					description={t("botVoice.speakDesc")}
					icon={<Volume2 />}
					id="setting-bot-speak-replies"
					label={t("botVoice.speak")}
					onCheckedChange={next => void edit({ op: "voice", speakReplies: next })}
				/>
			</SettingsSection>
		</>
	);
}
