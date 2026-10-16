/**
 * The Korean UI glossary: one name per concept, and the spellings that name replaces.
 * `ko-glossary.test.ts` fails when any ko string (locale, settings schema, main-process
 * text) uses an `avoid` spelling, so a new string cannot reintroduce a second name.
 *
 * Not listed here because the existing guards in `locales.test.ts` already own them:
 * 추가 지시 (a steer; never 스티어링) and 중단 (stopping a run; 중지 only for pages,
 * recordings and forwards).
 */
export interface GlossaryTerm {
	/** The one name. */
	term: string;
	/** What it names, for the next person adding a string. */
	concept: string;
	/** Spellings of the same concept that must not appear. */
	avoid: RegExp;
}

export const KO_GLOSSARY: readonly GlossaryTerm[] = [
	{ term: "프로바이더", concept: "model provider (OpenAI, Anthropic, …)", avoid: /공급자|제공자|제공업체/ },
	{ term: "서브에이전트", concept: "an agent a task tool starts", avoid: /하위 에이전트|서브 에이전트/ },
	{ term: "추가 지시", concept: "a steer sent while a turn runs", avoid: /스티어/ },
	{ term: "모델 역할", concept: "a model role (default, slow, plan, …)", avoid: /모델 롤/ },
	{ term: "세션", concept: "one conversation with the agent", avoid: /대화방/ },
	{ term: "미리보기", concept: "preview (panel, toolbar, file)", avoid: /미리 보기/ },
	{ term: "새로고침", concept: "refresh / reload", avoid: /새로 고침/ },
	{ term: "폴더", concept: "a directory the user picks or sees", avoid: /디렉터리|디렉토리/ },
	{ term: "일시정지", concept: "pause (goal, agents, debugger)", avoid: /일시 ?중지/ },
	{ term: "풀 리퀘스트", concept: "pull request in prose; PR #12 names one", avoid: /풀리퀘스트/ },
	{ term: "단축키", concept: "keyboard shortcut", avoid: /핫키|키보드 단축(?!키)/ },
	{ term: "로그인", concept: "sign in / sign-in state", avoid: /로그 인|사인 ?인/ },
	{ term: "사이드 패널", concept: "the right panel", avoid: /측면 패널|옆 패널|사이드패널/ },
];

/** Hedged particles ("을(를)") read as unfinished; word the sentence around a noun instead. */
export const HEDGED_PARTICLE = /(을\(를\)|이\(가\)|은\(는\)|와\(과\)|\(으\)로)/;

/**
 * 합니다체 endings (…ㅂ니다). The UI speaks 해요체. `아니다` and other words that only contain
 * 니다 are fine, so the syllable before 니다 must end in ㅂ (jongseong 17).
 */
export function formalEnding(text: string): string | null {
	for (const match of text.matchAll(/([가-힣])니다/g)) {
		const code = match[1].charCodeAt(0) - 0xac00;
		if (code % 28 === 17) return `${match[1]}니다`;
	}
	return null;
}
