/**
 * Settings › Bot, while the bot is on: who the bot is (its avatar, tagline and persona: dots' character, Muse's
 * Identity and Soul, Grok's picture and label), where its notices reach the owner (dots' channel routing, Muse's and
 * Duet's "how often") and whether its replies are spoken. All of it is the desk's (`shared/bot-desk.ts`), so the
 * bot's prompt, its bar and sidebar row, and a paired device's view follow every change; each control writes through
 * `useBotDeskStore.edit` and shows what main kept.
 *
 * Who a bot is (`BotIdentityRows`) is edited for this computer's bot and for each paired host's (`device`): Settings
 * has a section per host whose bot is on (`HostBotIdentitySettings`), and the bot's bar opens the same rows in a
 * sheet for the bot it shows (`BotIdentitySheet`), on this computer, a paired computer and the phone's page alike.
 */
import { ImageUp, MessageSquareQuote, Palette, Sparkles, Tag, UserRound, Volume2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { BOT_AVATAR_PROMPT_MAX, type BotAvatarAnswer } from "../../../../resources/gui-bridge/bot-avatar-contracts";
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
import type { HostView } from "../../../shared/ipc-types";
import { useShellMode } from "../../hooks/use-shell-mode";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { onEscape } from "../../lib/keymap";
import { botDisplayName } from "../../lib/session-title";
import { useBotStore } from "../../stores/bot";
import { ensureBotDesk, useBotDesk, useBotDeskStore } from "../../stores/bot-desk";
import { useRemoteStore } from "../../stores/remote";
import { sessionListFeed } from "../../stores/session-list";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { AvatarImageError, avatarDataUrl, BOT_AVATAR_ACCEPT } from "../bot/avatar-image";
import { BOT_TILE_CLASSES, BotAvatar } from "../bot/BotAvatar";
import { useBotMotion } from "../bot/bot-motion";
import { BOT_SHAPE_ICONS } from "../bot/bot-shape-icons";
import { botState, tabBotFacts } from "../bot/bot-status";
import { Button, IconButton, Input, LinkButton, Select, Sheet, TextArea } from "../common";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";

/** The computer whose bot a row edits: this one's (no `device`) or a paired host's. */
interface BotOf {
	device?: string | undefined;
}

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

/** Whether the image model role can draw an avatar (read once, when the row appears); null until main answers. */
function useAvatarDrawing(): BotAvatarAnswer | null {
	const [answer, setAnswer] = useState<BotAvatarAnswer | null>(null);
	useEffect(() => {
		let live = true;
		void (async () => {
			let next: BotAvatarAnswer;
			try {
				next = await window.omp.sessions.botDesk.avatarStatus();
			} catch {
				next = { available: false, reason: "unavailable" };
			}
			if (live) setAnswer(next);
		})();
		return () => {
			live = false;
		};
	}, []);
	return answer;
}

/**
 * The bot's session file on its computer, while it is on: this computer's from pref `bot`, a paired host's from its
 * own list (the row it marks `bot: "on"`; the caller holds that list).
 */
export function useBotSessionPath(device: string | undefined): string | null {
	const local = useBotStore(state => (state.enabled ? state.path : null));
	const hostBot = useStore(sessionListFeed("global", device).store, state =>
		device === undefined ? null : (state.sessions.find(row => row.bot === "on")?.path ?? null),
	);
	return device === undefined ? local : hostBot;
}

/**
 * The bot's name: its session's own title, renamed through stock's rename like any session (a name the owner sets is
 * never replaced by an automatic title), on the host for a host's bot. A paired computer shows it on its fixed bot
 * row and the bot's bar, and the bot's prompt names it by it (`botSection`), each as soon as the rename lands.
 */
export function BotNameRow({ path, device }: { path: string } & BotOf) {
	const t = useT();
	const inputId = useId();
	const feed = sessionListFeed("global", device);
	const listed = useStore(feed.store, s => s.sessions.find(session => session.path === path));
	const name = botDisplayName(listed, t("sidebar.botBadge"));
	const [draft, setDraft] = useState(name);
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		if (!editing) setDraft(name);
	}, [editing, name]);
	const commit = (value: string) => {
		setEditing(false);
		const next = value.trim();
		if (!next || next === name) {
			setDraft(name);
			return;
		}
		// Through the list, so this window shows the new name at once, before the list pushes it.
		feed.renameSession(path, next).catch((error: unknown) => {
			setDraft(name);
			toastError({ title: t("botRules.renameFailed"), error });
		});
	};
	return (
		<SettingsRow
			control={
				<Input
					controlSize="sm"
					data-bot-name-field
					id={inputId}
					maxLength={64}
					onBlur={event => commit(event.currentTarget.value)}
					onChange={event => setDraft(event.target.value)}
					onFocus={() => setEditing(true)}
					onKeyDown={event => {
						if (isImeKeyEvent(event)) return;
						if (event.key === "Enter") event.currentTarget.blur();
						onEscape(event, () => {
							setDraft(name);
							setEditing(false);
						});
					}}
					value={draft}
				/>
			}
			description={t("botRules.nameDesc")}
			htmlFor={inputId}
			icon={<Tag />}
			label={t("botRules.name")}
		/>
	);
}

function AvatarRow({ device }: BotOf) {
	const t = useT();
	const { desk } = useBotDesk(device);
	const edit = useBotDeskStore(state => state.edit);
	const fileRef = useRef<HTMLInputElement>(null);
	const [generating, setGenerating] = useState(false);
	const drawing = useAvatarDrawing();
	const unavailable = drawing && !drawing.available ? (drawing.reason ?? "unavailable") : null;
	const avatar = desk.identity.avatar;
	const mark = avatar.kind === "mark" ? avatar : null;
	// The preview moves as the bot does now, as on its rows and bar: the tab holding its session, if any.
	const botPath = useBotSessionPath(device);
	const tab = useTabsStore(state =>
		botPath ? state.tabs.find(entry => entry.sessionPath === botPath && entry.device === device) : undefined,
	);
	const motion = useBotMotion({ state: botState(tabBotFacts(tab)), device, tabId: tab?.id });
	const upload = async (file: File | undefined) => {
		if (!file) return;
		try {
			const dataUrl = await avatarDataUrl(file);
			await edit({ op: "identity", avatar: { kind: "image", dataUrl } }, device);
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
			id={device === undefined ? "setting-bot-avatar" : undefined}
			label={t("botIdentity.avatar")}
		>
			<div className="flex flex-wrap items-start gap-4 pt-2" data-bot-avatar-editor>
				<BotAvatar avatar={avatar} label={t("botIdentity.avatarPreview")} motion={motion} size="lg" />
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
										void edit(
											{ op: "identity", avatar: { kind: "mark", shape, color: mark?.color ?? "accent" } },
											device,
										)
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
									void edit(
										{ op: "identity", avatar: { kind: "mark", shape: mark?.shape ?? "bot", color } },
										device,
									)
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
							aria-expanded={generating}
							data-bot-avatar-generate
							disabled={!drawing?.available}
							icon={<Sparkles />}
							onClick={() => setGenerating(open => !open)}
							size="sm"
							variant="secondary"
						>
							{t("botAvatar.generate")}
						</Button>
					</div>
					{unavailable && (
						<p className="text-sc-xs text-(--sc-text-muted)" data-bot-avatar-reason={unavailable}>
							{t(`botAvatar.reason.${unavailable}`)}
							{unavailable === "no_model" || unavailable === "no_credentials" ? (
								<>
									{" "}
									<LinkButton
										data-bot-avatar-role-link
										onClick={() => useUiStore.getState().openSettings("models:roles")}
									>
										{t("botAvatar.openRole")}
									</LinkButton>
								</>
							) : null}
						</p>
					)}
					{generating && <GenerateForm device={device} onClose={() => setGenerating(false)} />}
				</div>
			</div>
		</SettingsRow>
	);
}

/**
 * The owner describes the avatar; this computer draws it on its image model role and sets it (main,
 * `BOT_AVATAR_GENERATE`), on a paired host's desk for a host's bot. In place under the avatar, not a dialog: the same
 * rows sit in the bar's sheet, and a dialog never opens over a sheet.
 */
function GenerateForm({ device, onClose }: BotOf & { onClose: () => void }) {
	const t = useT();
	const id = useId();
	const [description, setDescription] = useState("");
	const [pending, setPending] = useState(false);
	const send = async () => {
		const text = description.trim();
		if (!text || pending) return;
		setPending(true);
		try {
			const botDesk = window.omp.sessions.botDesk;
			await (device === undefined ? botDesk.generateAvatar(text) : botDesk.generateAvatar(text, device));
			// A host's push can miss this page (a paired web page hears none), as after an edit.
			if (device !== undefined) void useBotDeskStore.getState().refresh(device);
			setDescription("");
			onClose();
		} catch (error) {
			toastError({ title: t("botAvatar.failed"), error });
		} finally {
			setPending(false);
		}
	};
	return (
		<div className="flex flex-col gap-2" data-bot-avatar-generate-form>
			<p className="text-sc-xs text-(--sc-text-muted)" id={id}>
				{t("botAvatar.desc")}
			</p>
			<TextArea
				aria-labelledby={id}
				data-bot-avatar-description
				disabled={pending}
				maxLength={BOT_AVATAR_PROMPT_MAX}
				onChange={event => setDescription(event.target.value)}
				onKeyDown={event => onEscape(event, () => !pending && onClose())}
				placeholder={t("botAvatar.placeholder")}
				value={description}
			/>
			<div className="flex justify-end gap-2">
				<Button disabled={pending} onClick={onClose} size="sm" variant="ghost">
					{t("common.cancel")}
				</Button>
				<Button
					data-bot-avatar-generate-send
					disabled={!description.trim()}
					loading={pending}
					onClick={() => void send()}
					size="sm"
				>
					{t("botAvatar.send")}
				</Button>
			</div>
		</div>
	);
}

function TaglineRow({ device }: BotOf) {
	const t = useT();
	const inputId = useId();
	const stored = useBotDesk(device).desk.identity.tagline;
	const edit = useBotDeskStore(state => state.edit);
	const { draft, setDraft, setEditing } = useDraft(stored);
	const commit = (value: string) => {
		setEditing(false);
		if (value.trim() !== stored) void edit({ op: "identity", tagline: value.trim() }, device);
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

function PersonaRow({ device }: BotOf) {
	const t = useT();
	const inputId = useId();
	const stored = useBotDesk(device).desk.identity.persona;
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
						if (next !== stored) void edit({ op: "identity", persona: next }, device);
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

/** Who a bot is: its name (given its session), avatar, tagline and persona, on this computer or a paired host. */
export function BotIdentityRows({ device, botPath }: BotOf & { botPath?: string | null }) {
	return (
		<>
			{botPath ? <BotNameRow device={device} path={botPath} /> : null}
			<AvatarRow device={device} />
			<TaglineRow device={device} />
			<PersonaRow device={device} />
		</>
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
				<BotIdentityRows />
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

/** One paired host's bot, while the host's own list marks it on: its name and identity, edited on that host. */
function HostBotIdentitySection({ host }: { host: Pick<HostView, "deviceId" | "name"> }) {
	const t = useT();
	const feed = sessionListFeed("global", host.deviceId);
	// Settings may be open with the sidebar folded away (a phone's drawer): the section holds the host's list itself.
	useEffect(() => feed.retain(), [feed]);
	const botPath = useBotSessionPath(host.deviceId);
	const { loaded } = useBotDesk(host.deviceId);
	useEffect(() => {
		if (botPath) ensureBotDesk(host.deviceId);
	}, [botPath, host.deviceId]);
	if (!botPath || !loaded) return null;
	return (
		<div data-bot-identity-host={host.deviceId}>
			<SettingsSection
				description={t("botIdentity.hostDesc", { device: host.name })}
				id={`settings-bot-identity-${host.deviceId}`}
				title={t("botIdentity.hostTitle", { device: host.name })}
			>
				<BotIdentityRows botPath={botPath} device={host.deviceId} />
			</SettingsSection>
		</div>
	);
}

/** Settings › Bot: a section per paired host that is online, shown while that host's bot is on. */
export function HostBotIdentitySettings() {
	const hosts = useRemoteStore(state => state.state?.hosts);
	return (
		<>
			{(hosts ?? [])
				.filter(host => host.state === "online")
				.map(host => (
					<HostBotIdentitySection host={host} key={host.deviceId} />
				))}
		</>
	);
}

/**
 * The bot's bar opens who the bot is in a sheet, for the bot it shows: this computer's, or a paired host's on a paired
 * computer and on the phone's page. A side chat's bar edits the bot it belongs to.
 */
export function BotIdentitySheet({ device, open, onClose }: BotOf & { open: boolean; onClose: () => void }) {
	const t = useT();
	const phone = useShellMode() === "phone";
	const botPath = useBotSessionPath(device);
	const computer = useRemoteStore(state =>
		device === undefined ? undefined : state.state?.hosts.find(host => host.deviceId === device)?.name,
	);
	return (
		<Sheet
			description={computer ? t("botIdentity.hostDesc", { device: computer }) : t("botIdentity.desc")}
			onClose={onClose}
			open={open}
			placement={phone ? "bottom" : "right"}
			size="md"
			title={t("botIdentity.sheetTitle")}
		>
			<div className="flex flex-col" data-bot-identity-sheet={device ?? "local"}>
				<BotIdentityRows botPath={botPath} device={device} />
			</div>
		</Sheet>
	);
}
