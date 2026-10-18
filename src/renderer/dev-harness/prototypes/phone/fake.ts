import { createContext, useContext } from "react";

export type VariantId = "a" | "b" | "c";
export const VARIANTS: readonly VariantId[] = ["a", "b", "c"];

export const STATES = [
	"idle",
	"typing",
	"multiline",
	"keyboard",
	"running",
	"running-draft",
	"attachments",
	"more-open",
	"menu-slash",
	"queue",
] as const;
export type StateName = (typeof STATES)[number];

export type ThinkingLevel = "off" | "auto" | "low" | "medium" | "high" | "max";
export const THINKING: readonly ThinkingLevel[] = ["off", "auto", "low", "medium", "high", "max"];
export type Approval = "yolo" | "write" | "always-ask";
export const APPROVALS: readonly Approval[] = ["yolo", "write", "always-ask"];
export type Delegation = "default" | "solo" | "assisted" | "collaborative" | "swarm";
export const DELEGATIONS: readonly Delegation[] = ["default", "solo", "assisted", "collaborative", "swarm"];
export type Mode = "agent" | "plan" | "goal" | "autopilot";
export const MODES: readonly Mode[] = ["agent", "plan", "goal", "autopilot"];
export type SendMode = "steer" | "followUp";
export type Lane = "steering" | "followUp";

export interface FakeModel {
	id: string;
	name: string;
	short: string;
}
export const MODELS: readonly FakeModel[] = [
	{ id: "sonnet-5.5", name: "Claude Sonnet 5.5", short: "Sonnet 5.5" },
	{ id: "opus-5", name: "Claude Opus 5", short: "Opus 5" },
	{ id: "haiku-5", name: "Claude Haiku 5", short: "Haiku 5" },
	{ id: "gpt-5.5", name: "GPT-5.5", short: "GPT-5.5" },
	{ id: "gemini-3", name: "Gemini 3 Pro", short: "Gemini 3 Pro" },
];

export interface FakeImage {
	id: number;
	src: string;
}
export interface QueueItem {
	id: number;
	lane: Lane;
	text: string;
}

export interface Session {
	text: string;
	running: boolean;
	sendMode: SendMode;
	model: string;
	thinking: ThinkingLevel;
	approval: Approval;
	delegation: Delegation;
	mode: Mode;
	context: number;
	images: FakeImage[];
	pastes: number;
	queue: QueueItem[];
	expanded: boolean;
	stt: boolean;
	suggestions: boolean;
}

/** A tiny gradient picture as a data URL, so thumbnails look like photos without any asset. */
export function fakePhoto(index: number): string {
	const canvas = document.createElement("canvas");
	canvas.width = 120;
	canvas.height = 120;
	const ctx = canvas.getContext("2d");
	if (!ctx) return "";
	const hue = (index * 47) % 360;
	const gradient = ctx.createLinearGradient(0, 0, 120, 120);
	gradient.addColorStop(0, `hsl(${hue} 65% 62%)`);
	gradient.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 38%)`);
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 120, 120);
	ctx.fillStyle = "rgba(255,255,255,0.55)";
	ctx.beginPath();
	ctx.arc(30 + (index % 4) * 20, 40 + (index % 3) * 15, 18, 0, Math.PI * 2);
	ctx.fill();
	return canvas.toDataURL("image/jpeg", 0.7);
}

export function photos(count: number): FakeImage[] {
	return Array.from({ length: count }, (_, index) => ({ id: index + 1, src: fakePhoto(index + 1) }));
}

export interface PresetText {
	sample: string;
	multi: string;
	running: string;
	q: [string, string, string];
}

export function presetFor(state: StateName, text: PresetText, query: URLSearchParams): Session {
	const base: Session = {
		text: "",
		running: false,
		sendMode: "steer",
		model: "sonnet-5.5",
		thinking: "auto",
		approval: "yolo",
		delegation: "assisted",
		mode: "agent",
		context: 4,
		images: [],
		pastes: 0,
		queue: [],
		expanded: query.get("expanded") === "1",
		stt: query.get("stt") !== "0",
		suggestions: query.get("sugg") !== "0",
	};
	const imageCount = Number(query.get("images") ?? 0);
	switch (state) {
		case "typing":
			base.text = text.sample;
			break;
		case "multiline":
			base.text = text.multi;
			break;
		case "running":
			base.running = true;
			break;
		case "running-draft":
			base.running = true;
			base.text = text.running;
			break;
		case "attachments":
			base.images = photos(imageCount > 0 ? imageCount : 7);
			base.pastes = 1;
			base.text = text.sample;
			break;
		case "menu-slash":
			base.text = "/";
			break;
		case "queue":
			base.running = true;
			base.queue = [
				{ id: 1, lane: "steering", text: text.q[0] },
				{ id: 2, lane: "followUp", text: text.q[1] },
				{ id: 3, lane: "followUp", text: text.q[2] },
			];
			break;
		default:
			break;
	}
	if (imageCount > 0 && state !== "attachments") base.images = photos(imageCount);
	if (query.get("plan") === "1") base.mode = "plan";
	return base;
}

/** The names the `slash` completion menu offers (descriptions come from the proto strings). */
export const COMMANDS: readonly { name: string; key: string }[] = [
	{ name: "/review", key: "pp.cmd.review" },
	{ name: "/compact", key: "pp.cmd.compact" },
	{ name: "/model", key: "pp.cmd.model" },
	{ name: "/plan", key: "pp.cmd.plan" },
	{ name: "/tree", key: "pp.cmd.tree" },
	{ name: "/share", key: "pp.cmd.share" },
	{ name: "/export", key: "pp.cmd.export" },
	{ name: "/fork", key: "pp.cmd.fork" },
	{ name: "/todo", key: "pp.cmd.todo" },
	{ name: "/memory", key: "pp.cmd.memory" },
	{ name: "/mcp", key: "pp.cmd.mcp" },
	{ name: "/skill:deploy", key: "pp.cmd.skill" },
];

export interface SessionApi {
	s: Session;
	set: (patch: Partial<Session> | ((current: Session) => Partial<Session>)) => void;
	/** One semantic event (send, set-thinking…), kept in `window.__proto.log` so a script can tell what a tap did. */
	act: (name: string, detail?: unknown) => void;
	fieldRef: React.RefObject<HTMLTextAreaElement | null>;
	variant: VariantId;
	state: StateName;
}

export const SessionContext = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
	const value = useContext(SessionContext);
	if (!value) throw new Error("useSession outside a prototype");
	return value;
}

declare global {
	interface Window {
		__proto?: {
			log: { name: string; detail?: unknown; at: number }[];
			session: () => Session;
			/** Scripts flip state a user action would (a turn starting) without a tap. */
			set: (patch: Partial<Session>) => void;
		};
	}
}

export function modelOf(id: string): FakeModel {
	return MODELS.find(model => model.id === id) ?? MODELS[0];
}
