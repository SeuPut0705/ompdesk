/**
 * Korean (ko) translations for the agent settings schema content:
 * group titles keyed by schema group name, setting labels/descriptions
 * keyed by setting path. SettingsWindow consults these only when the
 * active language is ko and falls back to the schema's English text
 * for anything missing.
 *
 * Boundary: the named tabs (appearance…providers) and the Advanced tab
 * (schema settings without ui metadata) are both fully covered.
 */

/** Section headings declared in the schema's TAB_GROUPS. */
export const KO_GROUP_TITLES: Record<string, string> = {
	Theme: "테마",
	"Status Line": "상태 표시줄",
	Display: "표시",
	Images: "이미지",
	Thinking: "사고",
	Sampling: "샘플링",
	Prompt: "프롬프트",
	"Retry & Fallback": "재시도 및 폴백",
	Advisor: "어드바이저",
	Prewalk: "사전 탐색",
	Vision: "비전",
	Input: "입력",
	Approvals: "승인",
	Notifications: "알림",
	Speech: "음성",
	Collab: "협업",
	"Magic Keywords": "매직 키워드",
	"Startup & Updates": "시작 및 업데이트",
	Power: "전원",
	Agent: "에이전트",
	Git: "Git",
	General: "일반",
	Compaction: "압축",
	"Rules (TTSR)": "규칙(TTSR)",
	Experimental: "실험적 기능",
	"Auto-Learn": "자동 학습",
	Mnemopi: "Mnemopi",
	Hindsight: "Hindsight",
	Editing: "편집",
	Reading: "읽기",
	"Read Summaries": "읽기 요약",
	LSP: "LSP",
	Bash: "Bash",
	"Eval & Runtimes": "Eval 및 런타임",
	"Available Tools": "사용 가능한 도구",
	Todos: "할 일",
	"Grep & Browser": "Grep 및 브라우저",
	Computer: "데스크톱 제어",
	GitHub: "GitHub",
	"Output Limits": "출력 제한",
	Execution: "실행",
	"Discovery & MCP": "탐색 및 MCP",
	Extensions: "확장",
	Developer: "개발자",
	Modes: "모드",
	Subagents: "서브에이전트",
	Isolation: "격리",
	"Commands & Skills": "명령 및 스킬",
	Services: "서비스",
	Fireworks: "Fireworks",
	"Tiny Model": "초소형 모델",
	Protocol: "프로토콜",
	Timeouts: "타임아웃",
	Privacy: "개인정보",
	Composer: "입력창",
	Sharpshooter: "Sharpshooter",
	Skills: "스킬",
	"IDA Pro": "IDA Pro",
	Stream: "스트림",
};

/** Per-setting row text, keyed by schema setting path. */
export const KO_SETTINGS: Record<string, { label: string; description?: string }> = {
	"auth.accountPolicies": { label: "계정별 인증 정책" },
	modelPresets: { label: "모델 프리셋" },
	"terminal.programStatus": {
		label: "프로그램 상태 (OSC 7501)",
		description: "터미널 탭 표시와 에이전트 수신함을 위해 작업 중, 입력 대기, 완료, 실패 상태를 OSC 7501로 알려요.",
	},
	"composer.predictions": {
		label: "다음 메시지 예측",
		description:
			"턴이 끝나면 현재 모델이 다음 메시지를 예측해 빈 입력창에 흐린 텍스트로 보여줘요. Tab이나 오른쪽 화살표로 전송 없이 입력할 수 있어요. 추가 사용량: 완료된 턴마다 전체 대화를 포함한 유료 요청이 한 번 더 발생해요 (/stats에 집계돼요).",
	},
	"retry.fallbackOn": {
		label: "폴백 전환 조건",
		description: "어떤 요청 실패 시 설정된 폴백 모델로 전환할지 정해요.",
	},
	"providers.anthropic.slowMode": { label: "Anthropic 저속 모드" },
	"tts.localSpeed": {
		label: "로컬 TTS 속도",
		description: "로컬 TTS 백엔드의 말하기 속도예요 (tts 도구, omp say). 1은 보통 속도이며 0.5–2.5 범위로 제한돼요.",
	},
	"speech.speed": {
		label: "응답 읽기 속도",
		description: "어시스턴트 출력을 소리 내어 읽는 속도예요. 1은 보통 속도이며 0.5–2.5 범위로 제한돼요.",
	},
	"contextFiles.extra": {
		label: "추가 컨텍스트 파일",
		description:
			'AGENTS.md와 함께 불러올 추가 지침 파일 이름이에요. 경로가 아닌 이름의 JSON 목록을 사용해요 (예: ["AGENTS.local.md"]). []로 설정하면 추가 파일을 불러오지 않아요. 새 세션을 시작해야 적용돼요.',
	},
	"compaction.modelThresholds": { label: "모델별 압축 임계값" },
	"compaction.modelThresholdsEnabled": { label: "모델별 압축 임계값 사용" },
	"edit.modelVariants": { label: "모델별 편집 방식" },
	"bash.gitGuard": {
		label: "Git 보호",
		description:
			"bash 도구에서 공유 작업을 버리거나 이동하는 git 명령을 거부해요. stash, reset --hard 또는 다른 커밋으로의 reset, 병합·리베이스 충돌 해결 외의 checkout/switch/restore가 대상이에요.",
	},
	"worktree.onStart": {
		label: "시작 시 워크트리",
		description: "새 대화형 세션을 새 연결 워크트리에서 시작할지 정해요.",
	},
	"worktree.onExit": {
		label: "종료 시 워크트리",
		description: "omp 시작 이후 만들어진 워크트리(시작 시 또는 `/wt`로 생성)를 종료 시 어떻게 처리할지 정해요.",
	},
	"task.structured": {
		label: "구조화된 작업 결과",
		description:
			"task 도구에 outputSchema/schemaMode를 제공하고, 호출자 또는 에이전트의 출력 스키마로 검증한 서브에이전트 결과를 yield 도구로 반환해요. 끄면 task 서브에이전트는 yield 도구 없이 마지막 메시지를 일반 텍스트로 반환해요. Eval의 agent()/workpool로 실행한 에이전트는 항상 구조화된 결과를 사용해요.",
	},
	"task.agentCompactionThresholdOverrides": { label: "에이전트별 압축 임계값 재정의" },
	"task.agentAccountPools": { label: "에이전트별 계정 풀" },
	"task.agentSoftRequestBudget": { label: "에이전트별 요청 예산" },
	"gc.stale": { label: "오래된 세션 정리" },
	"gc.staleRetainNewest": { label: "최근 세션 보관 수" },
	"gc.staleRetainDays": { label: "오래된 세션 보관 일수" },
	"providers.openai-codex.codeMode": {
		label: "Codex 코드 모드",
		description:
			"eval을 통해 코드 모드 모델을 사용해요. 다른 세션 도구는 eval에서 호출해요. 자동 모드는 모델 카탈로그의 기능 플래그를 따라요.",
	},
	"providers.openai-codex.codeModeDirectTools": {
		label: "코드 모드 추가 직접 도구",
		description: "eval, ask, todo, yield, think, checkpoint, rewind 외에 직접 호출을 허용할 도구예요.",
	},
	"update.channel": {
		label: "omp 업데이트 채널",
		description:
			'omp update와 Core 시작 시 업데이트 확인에 사용할 채널이에요. 데스크톱 앱 업데이트는 "업데이트" 페이지에서 관리해요.',
	},
	"edit.autoRepair.enabled": {
		label: "파싱 오류 자동 복구",
		description:
			"편집으로 파일을 파싱할 수 없게 되면 작은 모델이 오류 영역을 고치고 다시 파싱해 검증해요. 복구에 실패하면 경고를 표시해요.",
	},
	"providers.cacheRetention": {
		label: "프롬프트 캐시 보존 기간",
		description:
			"지원하는 프로바이더에 캐시 보존 정책을 보내요. 자동은 프로바이더 기본값을 쓰고, 끄면 캐시 친화 라우팅도 함께 비활성화돼요.",
	},
	"commit.mapReduceThreshold": { label: "커밋 메시지 분할 생성 임계값" },
	"commit.mapBatchTokenBudget": { label: "커밋 분석 배치당 토큰 예산" },
	"commit.cacheEnabled": { label: "커밋 분석 결과 캐시" },
	"commit.cacheTtlDays": { label: "커밋 분석 캐시 보관 일수" },
	"extensionHandlers.toolCallTimeoutMs": {
		label: "확장 도구 호출 타임아웃(ms)",
		description:
			"확장 tool_call 핸들러의 실제 경과 시간 제한이에요. omp 대화상자를 기다리는 동안은 계산하지 않으며, 잘못된 값은 30000ms로 대체돼요.",
	},
	// ── appearance ──────────────────────────────────────────────────────────
	"theme.dark": { label: "다크 테마", description: "TUI와 GUI가 다크 모드일 때 사용할 테마 색상" },
	"theme.light": { label: "라이트 테마", description: "TUI와 GUI가 라이트 모드일 때 사용할 테마 색상" },
	symbolPreset: { label: "기호 프리셋", description: "아이콘과 기호에 쓸 글리프 세트(Unicode, Nerd Font, ASCII)" },
	colorBlindMode: { label: "색맹 모드", description: "diff 추가 줄을 초록색 대신 파란색으로 표시" },
	"statusLine.preset": {
		label: "상태 프리셋",
		description: "TUI 상태 표시줄과 GUI 하단 상태 표시줄이 공유하는 레이아웃 프리셋",
	},
	"statusLine.separator": { label: "상태 표시줄 구분자", description: "세그먼트 사이 구분자 스타일" },
	"statusLine.sessionAccent": {
		label: "세션 강조색",
		description: "세션 이름 색상을 에디터 테두리와 상태 표시줄 간격에 적용",
	},
	"statusLine.transparent": {
		label: "투명 상태 표시줄",
		description:
			"상태 표시줄에 테마의 `statusLineBg` 대신 터미널 기본 배경을 사용해요. Powerline 끝 캡은 주변 터미널 영역으로 이어지려면 대비색 채움이 필요하므로 생략돼요.",
	},
	"statusLine.compactThinkingLevel": {
		label: "간결한 사고 수준 표시",
		description: "별도의 ` · <수준>` 접미사를 붙이는 대신 모델 이름에 아이콘 하나로 사고 수준을 표시해요.",
	},
	"statusLine.showHookStatus": { label: "훅 상태 표시", description: "상태 표시줄 아래에 훅 상태 메시지를 표시" },
	"terminal.showImages": { label: "인라인 이미지 표시", description: "터미널에서 이미지를 인라인으로 렌더링" },
	"images.autoResize": {
		label: "이미지 자동 크기 조정",
		description: "모델 호환성을 위해 큰 이미지를 최대 2000x2000으로 축소",
	},
	"images.blockImages": { label: "이미지 차단", description: "이미지가 LLM 프로바이더로 전송되지 않도록 차단" },
	"terminal.showProgress": {
		label: "네이티브 실행 진행률",
		description: "네이티브 실행 진행률 표시: 터미널은 OSC 9;4, GUI는 Dock 배지와 창 진행 막대 사용",
	},
	"tui.textSizing": {
		label: "큰 제목(Kitty)",
		description:
			"Kitty의 OSC 66 텍스트 크기 프로토콜로 Markdown H1 제목을 2배 크기로 렌더링해요. Kitty 터미널에서만 동작하고 다른 터미널은 무시해요. 기본값은 꺼짐이에요.",
	},
	"tui.renderMermaid": {
		label: "Mermaid 다이어그램 렌더링",
		description: "에이전트가 Mermaid 다이어그램을 사용할 수 있게 해요. TUI는 ASCII로, GUI는 그래픽으로 렌더링해요",
	},
	"tui.reactions": {
		label: "에이전트 이모지 반응",
		description: "에이전트가 답장 말풍선에 이모지 배지로 내 메시지에 반응할 수 있게 해요",
	},
	"tui.codexResetFireworks": {
		label: "Codex 리셋 불꽃놀이",
		description:
			"Codex 주간 사용량이 예기치 않게 리셋되거나 새로 적립된 리셋이 있으면 Escape를 누를 때까지 화면 상단 1/3에 불꽃놀이로 축하해요",
	},
	"tui.titleState": {
		label: "제목에 실행 상태 표시",
		description: "터미널 제목이나 GUI 창 제목에 에이전트의 작업 중, 대기 중, 사용자 차례 상태를 표시해요",
	},
	"tui.hyperlinks": {
		label: "터미널 하이퍼링크",
		description:
			"경로와 URL을 OSC 8 하이퍼링크로 감싸 터미널에서 바로 클릭해 열 수 있게 해요(auto: 지원 감지, off: 사용 안 함, always: 항상)",
	},
	"tui.tight": { label: "촘촘한 UI 밀도", description: "TUI 출력과 GUI 인터페이스 간격을 줄여요" },
	"display.shimmer": { label: "쉬머 애니메이션", description: "작업 중/로딩 메시지의 애니메이션 스타일" },
	"display.smoothStreaming": {
		label: "부드러운 스트리밍",
		description: "청크가 도착할 때 어시스턴트 텍스트와 스트리밍 도구 입력을 부드럽게 표시",
	},
	"display.showTokenUsage": { label: "토큰 사용량 표시", description: "어시스턴트 메시지에 턴별 토큰 사용량 표시" },
	"display.cacheMissMarker": {
		label: "캐시 미스 표시",
		description: "어시스턴트 요청이 프롬프트 캐시를 놓친(미스) 턴 위에 구분선을 표시",
	},
	"display.collapseCompacted": {
		label: "압축된 기록 접기",
		description:
			"실시간 세션 기록에서 압축 이전 기록을 요약 구분선 뒤로 접어요. 끄면 전체 기록을 유지하고 압축 지점마다 구분선을 표시해요",
	},
	showHardwareCursor: { label: "하드웨어 커서 표시", description: "입력기(IME) 지원을 위해 터미널 커서 표시" },
	"tui.imeSafeCursor": {
		label: "IME 안전 프롬프트 레이아웃",
		description: "macOS 입력기의 조합 중 텍스트가 프롬프트를 밀어내지 않도록 프롬프트 하단 테두리를 별도 줄로 옮겨요",
	},
	"task.showResolvedModelBadge": {
		label: "확정된 모델 배지 표시",
		description: "태스크 위젯 상태 줄에 각 서브에이전트가 실제로 사용한 모델 ID를 표시",
	},

	// ── model ───────────────────────────────────────────────────────────────
	"advisor.enabled": {
		label: "어드바이저 사용",
		description: "두 번째 모델('advisor' 역할에 할당)을 붙여 매 턴을 수동적으로 검토하고 주석을 주입해요.",
	},
	"prewalk.enabled": {
		label: "사전 탐색 사용",
		description:
			"현재 모델로 시작한 뒤, 계획 프롬프트의 할 일 목록이 만들어지고 첫 편집/쓰기가 일어날 때 빠르고 저렴한 모델(기본 'smol' 역할)로 전환해요. 강한 모델이 계획을 세우고 할 일을 등록해 구현을 시작한 다음 핸드오프해요. --prewalk / --no-prewalk로 세션별로 덮어쓸 수 있어요.",
	},
	// 17.3.0에서 전역 advisor.subagents가 제거됨(task.agentAdvisor로 이전).
	"task.agentAdvisor": {
		label: "서브에이전트 어드바이저(에이전트별)",
		description:
			'에이전트 이름별 어드바이저 모델 설정(제거된 advisor.subagents 대체). 예: { task: "on" }은 task 서브에이전트에 기본 어드바이저를 켜요.',
	},
	"advisor.syncBacklog": {
		label: "어드바이저 동기화 백로그",
		description:
			"어드바이저가 이 턴 수만큼 뒤처지면 메인 에이전트를 최대 30초 멈춰요. Off는 따라잡기 지연을 끄는 설정이에요.",
	},
	"advisor.immuneTurns": {
		label: "어드바이저 면제 턴 수",
		description:
			"어드바이저의 우려나 차단으로 한 번 중단된 뒤, 이 수만큼의 메인 턴 동안은 이후 우려/차단을 중단 없이 전달해요.",
	},
	modelRoleStorage: { label: "모델 역할 저장 위치", description: "모델 선택기의 역할 할당을 저장할 위치" },
	"images.describeForTextModels": {
		label: "텍스트 전용 모델용 이미지 설명",
		description:
			"비전을 지원하지 않는 모델에 이미지를 첨부하면 버리지 않고 local://에 저장한 뒤 비전 모델의 설명을 주입해요",
	},
	"images.urls.enabled": {
		label: "이미지를 URL로 전송",
		description:
			"설정된 백엔드로 이미지를 게시하고, URL을 가져올 수 있는 프로바이더에는 짧은 링크를 보내요. 모든 백엔드가 실패하면 인라인 이미지로 자동 폴백해요",
	},
	"images.urls.backends": { label: "이미지 URL 백엔드", description: "이미지 게시 시 순서대로 시도할 대상" },
	"images.urls.options": { label: "이미지 URL 백엔드 옵션", description: "각 게시 백엔드에서 사용할 JSON 옵션" },
	"images.urls.credentials": {
		label: "이미지 URL 백엔드 자격 증명",
		description: "각 게시 백엔드에서 사용할 자격 증명. UI에서 값은 숨겨져요",
	},
	"images.urls.command": { label: "이미지 업로드 명령", description: "command 백엔드가 사용할 argv 템플릿" },
	"images.urls.publicBaseUrl": {
		label: "이미지 공개 URL",
		description: "이미지 프록시 서비스의 외부 접근 가능한 기본 URL",
	},
	"images.urls.ttlHours": {
		label: "이미지 URL 유효 기간",
		description: "이미지 링크의 유효 시간(시간 단위). 0이면 broker가 실행되는 동안 계속 유효해요",
	},
	"images.urls.bindHost": {
		label: "이미지 서비스 바인드 주소",
		description: "이미지 blob 서비스가 수신할 호스트 주소",
	},
	"images.urls.sshTarget": { label: "이미지 SSH 대상", description: "SSH 리버스 포워딩을 설정할 user@host 대상" },
	"images.urls.sshRemotePort": {
		label: "이미지 SSH 원격 포트",
		description: "SSH 리버스 포워딩에 사용할 원격 수신 포트",
	},
	defaultThinkingLevel: { label: "사고 수준", description: "사고를 지원하는 모델의 사고 깊이" },
	hideThinkingBlock: { label: "사고 블록 숨기기", description: "어시스턴트 응답에서 사고 블록 숨기기" },
	proseOnlyThinking: { label: "산문 전용 사고", description: "사고 요약에서 코드 블록을 생략하고 줄임표로 대체" },
	omitThinking: {
		label: "사고 요약 생략",
		description: "상위 프로바이더에 응답에서 사고 요약을 완전히 생략하도록 지시(지원되는 경우)",
	},
	"model.loopGuard.enabled": {
		label: "루프 가드",
		description: "모델 사고 과정과 산문 출력에 자동 스트리밍 루프 감지 사용",
	},
	"model.loopGuard.checkAssistantContent": {
		label: "루프 가드 산문 검사",
		description: "사고 로그뿐 아니라 어시스턴트 산문 메시지에도 루프 가드 적용",
	},
	"model.loopGuard.toolCallReminder": {
		label: "루프 가드 도구 호출 알림",
		description:
			"Gemini 사고 스트림이 도구를 호출하지 않고 계획 제목만 연달아 출력하면 중단하고 도구 호출을 요구하는 알림을 주입해요(루프 가드 활성화 필요)",
	},
	"model.toolCallLoopGuard.enabled": {
		label: "도구 호출 루프 가드",
		description: "여러 턴에 걸친 연속된 동일 도구 호출을 감지하고 교정 안내를 주입",
	},
	"model.toolCallLoopGuard.threshold": {
		label: "도구 호출 루프 임계값",
		description: "교정 안내를 주입하기 위한 연속 동일 도구 호출 횟수",
	},
	"model.toolCallLoopGuard.exemptTools": {
		label: "루프 가드 예외 도구",
		description: "여러 턴 루프 가드를 발동하지 않고 연속 반복이 허용되는 도구 이름",
	},
	inlineToolDescriptors: {
		label: "인라인 도구 설명자",
		description:
			"시스템 프롬프트에 전체 도구 설명자를 렌더링하고 프로바이더 도구 스키마에서 최상위/중첩 설명을 제거해 설명 텍스트를 한 번만 보내요. Auto는 Gemini 모델에서 켜고 다른 모델에서는 꺼요",
	},
	includeModelInPrompt: {
		label: "프롬프트에 모델 포함",
		description: "시스템 프롬프트에 현재 모델 식별자를 노출해 에이전트가 어떤 모델을 쓰는지 알 수 있게 해요",
	},
	includeWorkspaceTree: {
		label: "프로젝트 트리 포함",
		description:
			"시스템 프롬프트에 프로젝트 폴더 트리를 렌더링해요. 경고: 파일이 바뀌면 세션 간 프롬프트 캐시가 깨질 수 있어요.",
	},
	skillful: {
		label: "프롬프트에 스킬 나열",
		description:
			"시스템 프롬프트에 사용 가능한 스킬을 나열해요. 끄면 컨텍스트를 절약할 수 있고 /skillful로 세션별 전환이 가능해요",
	},
	personality: { label: "성격", description: "시스템 프롬프트의 성격 블록에 렌더링되는 소통 스타일" },
	temperature: { label: "온도", description: "샘플링 온도(0 = 결정적, 1 = 창의적, -1 = 프로바이더 기본값)" },
	topP: { label: "Top P", description: "누클리어스 샘플링 컷오프(0-1, -1 = 프로바이더 기본값)" },
	topK: { label: "Top K", description: "확률 상위 K개 토큰에서 샘플링(-1 = 프로바이더 기본값)" },
	minP: { label: "Min P", description: "최소 확률 임계값(0-1, -1 = 프로바이더 기본값)" },
	presencePenalty: {
		label: "존재 페널티",
		description: "이미 등장한 토큰 도입에 대한 페널티(-1 = 프로바이더 기본값)",
	},
	repetitionPenalty: { label: "반복 페널티", description: "반복 토큰에 대한 페널티(-1 = 프로바이더 기본값)" },
	textVerbosity: { label: "텍스트 상세도", description: "OpenAI Responses와 Codex의 응답 상세도(low, medium, high)" },
	"tier.openai": {
		label: "서비스 티어 — OpenAI",
		description:
			"OpenAI / OpenAI-Codex 요청과 OpenRouter로 라우팅되는 OpenAI 계열 모델의 처리 티어(none = 보내지 않음). `service_tier`로 전송돼요.",
	},
	"tier.anthropic": {
		label: "서비스 티어 — Anthropic",
		description:
			'Claude 요청의 처리 티어예요. `priority`는 지원되는 Anthropic 직접 연결 모델에서 빠른 모드(`speed: "fast"`)를 구현해요. Bedrock/Vertex Claude와 OpenRouter 경유 시에는 무시돼요.',
	},
	"tier.google": {
		label: "서비스 티어 — Google",
		description:
			"Gemini(Google AI Studio + Vertex) 요청과 OpenRouter로 라우팅되는 Google 계열 모델의 처리 티어(none = 보내지 않음). 최상위 `serviceTier` 필드로 전송돼요.",
	},
	"tier.subagent": {
		label: "서비스 티어 — 서브에이전트",
		description:
			"생성된 task/eval 서브에이전트의 서비스 티어예요. Inherit = 메인 에이전트의 현재 벤더별 티어를 따름(/fast에 따라 변경). 특정 값을 고르면 서브에이전트 모델의 벤더에 적용돼요.",
	},
	"tier.advisor": {
		label: "서비스 티어 — 어드바이저",
		description:
			"어드바이저 모델의 서비스 티어예요. None = 표준 처리, Inherit = 메인 에이전트의 현재 벤더별 티어를 따름. 특정 값을 고르면 어드바이저 모델의 벤더에 적용돼요.",
	},
	"retry.maxRetries": { label: "재시도 횟수", description: "API 오류 시 최대 재시도 횟수" },
	"retry.maxDelayMs": {
		label: "최대 재시도 지연",
		description:
			"재시도 사이 최대 대기 시간(ms)이에요. 프로바이더가 이보다 긴 대기를 요구하고 자격 증명이나 모델 폴백도 성공하지 못하면 대기하지 않고 바로 실패해요(예: Anthropic의 최대 3시간 속도 제한 창).",
	},
	"retry.modelFallback": { label: "재시도 모델 폴백", description: "재시도 복구 시 설정된 폴백 모델로 전환 허용" },
	"retry.waitForUsageReset": {
		label: "사용량 리셋 대기",
		description:
			"프로바이더가 명확한 사용량 리셋 시각을 알려주면 최대 재시도 지연을 넘더라도 리셋 후 재시도해요. 대기는 언제든 중단할 수 있고, 하위 태스크도 함께 대기해요.",
	},
	"retry.usageAwareFallback": {
		label: "사용량 인식 폴백",
		description:
			"신뢰할 수 있는 코딩 요금제 사용량 보고를 활용해, 사용량 하드 한도에 닿기 전에 같은 프로바이더 계정을 우선 선택하고 그다음 설정된 폴백 모델을 써요. 일반 API 키는 대상이 아니에요.",
	},
	"retry.usageReservePct": {
		label: "예비 여유분",
		description:
			"남은 사용량이 이 비율 아래로 떨어지면 코딩 요금제 모델을 한도 근접으로 간주해요. 사용량을 모르거나 매핑되지 않으면 기본 모델을 유지해요.",
	},
	"retry.usageReservePolicy": {
		label: "예비 정책",
		description: "같은 프로바이더의 모든 코딩 요금제 계정이 예비 여유분에 들어갔을 때의 처리 방식이에요.",
	},
	"retry.fallbackChains": {
		label: "재시도 폴백 체인",
		description:
			'모델 역할, 모델 선택자("provider/model-id") 또는 프로바이더 와일드카드("provider/*")를 순서가 있는 폴백 선택자 목록에 매핑하는 JSON 객체예요. 예: {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}. 모델 대상 키는 역할과 무관하게 해당 모델/프로바이더가 활성일 때 적용되고, "provider/*" 항목은 실패한 모델의 id를 유지한 채 프로바이더만 바꿔요. id 접두사가 붙은 와일드카드("openrouter/google/*")는 실패한 모델의 순수 id에 접두사를 다시 붙이며(google-antigravity/gemini-x -> openrouter/google/gemini-x), 키로 쓰면 해당 프로바이더의 그 접두사 아래 id에만 일치해요.',
	},
	"retry.fallbackRevertPolicy": { label: "폴백 복귀 정책", description: "폴백 후 언제 기본 모델로 돌아갈지" },
	"providers.anthropic.serverSideFallback": {
		label: "Anthropic 서버 측 폴백(Fable 5)",
		description:
			"Claude Fable 5 / Mythos 5 요청이 Anthropic 안전 분류기에 막히면 서버 측에서 Claude Opus 4.8로 재시도해요(Anthropic `server-side-fallback-2026-06-01` 베타). 직접 켜야 하며, 꺼 두면 모든 요청이 폴백 이전 동작을 유지해요.",
	},
	"providers.autoThinkingMaxEffort": {
		label: "자동 사고 최대 강도",
		description:
			"`auto` 분류기가 선택할 수 있는 최고 강도예요. `xhigh`는 분류기를 최고 단계보다 한 단계 낮게 제한해 명시적인 `ultrathink`만 `max`에 도달하게 해요. `max`는 분류기가 이례적이라고 판단한 턴을 해당 단계를 제공하는 모델에서 최고 단계로 과금할 수 있게 해요.",
	},

	// ── interaction ─────────────────────────────────────────────────────────
	autoResume: { label: "자동 재개", description: "현재 폴더의 가장 최근 세션을 자동으로 재개해요" },
	"power.sleepPrevention": {
		label: "잠자기 방지",
		description: "활성 세션 동안 macOS 잠자기를 막아요. 각 단계는 누적되어 하위 단계의 플래그를 모두 포함해요.",
	},
	"git.enabled": {
		label: "Git 연동 사용",
		description: "TUI에 git 브랜치, 상태, PR 정보를 표시하고 저장소 메타데이터를 감시해요.",
	},
	steeringMode: { label: "추가 지시 모드", description: "에이전트 실행 중 대기열 메시지 처리 방식" },
	followUpMode: { label: "후속 모드", description: "턴이 끝난 뒤 후속 메시지를 내보내는 방식" },
	interruptMode: { label: "중단 모드", description: "추가 지시 메시지가 도구 실행을 중단하는 시점" },
	"loop.mode": { label: "루프 모드", description: "/loop 반복 사이, 프롬프트를 다시 제출하기 전에 수행할 동작" },
	doubleEscapeAction: {
		label: "Escape 두 번 동작",
		description: "에디터가 비어 있을 때 Escape를 두 번 누르면 실행할 동작",
	},
	treeFilterMode: { label: "세션 트리 필터", description: "세션 트리를 열 때의 기본 필터 모드" },
	autocompleteMaxVisible: {
		label: "자동 완성 항목 수",
		description: "자동 완성 드롭다운에 보이는 최대 항목 수(3-20)",
	},
	emojiAutocomplete: {
		label: "이모지 자동 완성",
		description: "`:name:` 단축 코드로 이모지를 제안하고 `:D`나 `:-)` 같은 텍스트 이모티콘을 펼쳐요",
	},
	"paste.largeMenuThreshold": {
		label: "대용량 붙여넣기 메뉴",
		description:
			"붙여넣기가 이 줄 수에 도달하면 코드 블록으로 감싸기, XML 태그로 감싸기, 파일로 저장하기 메뉴를 제공해요. 0이면 메뉴를 끄며, 큰 붙여넣기는 여전히 [Paste] 표시로 접혀요.",
	},
	"startup.quiet": { label: "조용한 시작", description: "환영 화면과 시작 상태 메시지 건너뛰기" },
	"startup.showSplash": {
		label: "스플래시 화면 표시",
		description:
			"일반 대화형 시작 시 설정을 다시 실행하지 않고 전체 애니메이션 설정 화면을 보여줘요. 조용한 시작에서는 계속 숨겨져요.",
	},
	"startup.setupWizard": { label: "설정 마법사", description: "설정 버전마다 새로 추가된 온보딩 단계를 한 번씩 표시" },
	"startup.checkUpdate": { label: "업데이트 확인", description: "시작 시 omp 업데이트 확인" },
	"marketplace.autoUpdate": {
		label: "플러그인 마켓플레이스 자동 업데이트",
		description: "시작 시 플러그인 업데이트 확인",
	},
	"startup.changelogMode": {
		label: "시작 시 변경 로그",
		description: "업데이트 노트를 요약, 전체 내용으로 시작하거나 숨길지 선택",
	},
	"magicKeywords.enabled": {
		label: "매직 키워드",
		description: "단독으로 쓴 ultrathink, orchestrate, workflowz 키워드에 숨은 프롬프트 사용",
	},
	"magicKeywords.ultrathink": {
		label: "Ultrathink 키워드",
		description: "단독 ultrathink가 최대 자동 사고를 요청하고 숨은 프롬프트를 붙일 수 있게 해요",
	},
	"magicKeywords.orchestrate": {
		label: "Orchestrate 키워드",
		description: "단독 orchestrate가 숨은 멀티 에이전트 오케스트레이션 프롬프트를 붙일 수 있게 해요",
	},
	"magicKeywords.workflow": {
		label: "Workflow 키워드",
		description: "단독 workflowz가 숨은 eval 워크플로 프롬프트를 붙일 수 있게 해요",
	},
	"magicKeywords.jevify": {
		label: "Jevify 키워드",
		description: "단독으로 쓴 jevify가 숨겨진 일괄 판정 분류 안내를 덧붙이도록 해요.",
	},
	"completion.notify": { label: "완료 알림", description: "에이전트가 턴을 마치면 알림" },
	"error.notify": { label: "오류 알림", description: "에이전트가 오류로 멈추면 알림" },
	"ask.timeout": {
		label: "질문 타임아웃",
		description: "이 초가 지나면 추천 질문 옵션을 자동 선택(0이면 사용 안 함)",
	},
	"ask.notify": { label: "질문 알림", description: "ask 도구가 입력을 기다릴 때 알림" },
	"recap.enabled": {
		label: "유휴 요약",
		description: "터미널이 한동안 유휴 상태면 현재 진행 상황을 짧게 정리한 LLM 요약을 생성",
	},
	"recap.idleSeconds": { label: "유휴 요약 지연", description: "요약을 표시하기 전 유휴 대기 시간(초)" },
	"collab.relayUrl": { label: "릴레이 URL", description: "/collab이 사용할 릴레이(wss://host[:port])" },
	"collab.webUrl": {
		label: "웹 UI URL",
		description:
			"/collab 링크에 사용할 브라우저 UI. 비워 두면 collab.relayUrl에서 유도해요. 명시적 http://는 localhost만 허용돼요",
	},
	"collab.displayName": {
		label: "표시 이름",
		description: "다른 협업 참여자에게 보이는 이름(기본값: OS 사용자 이름)",
	},
	"share.serverUrl": {
		label: "공유 서버",
		description:
			"/share가 사용할 공유 보기/업로드 기본 주소(암호화된 blob 업로드 + 뷰어, 링크 형식 <base>/<id>#<key>)",
	},
	"share.store": { label: "공유 저장소", description: "/share가 암호화된 세션 blob을 업로드할 위치" },
	"share.redactSecrets": {
		label: "공유 시 비밀 정보 가리기",
		description: "업로드 전에 /share 스냅샷에 비밀 정보 난독화기를 실행(secrets.* 설정 사용)",
	},
	"stt.enabled": { label: "음성 인식", description: "마이크를 통한 음성 텍스트 변환 입력 사용" },
	"stt.submitTrigger": {
		label: "음성 받아쓰기 제출 트리거",
		description:
			'음성 받아쓰기를 자동 제출할 시점을 선택해요: 안 함, 키를 뗄 때(2단어 이상), 키를 떼고 문장이 끝났을 때, "제출"이라고 말할 때.',
	},
	"tools.approval": {
		label: "도구 승인 정책",
		description:
			"도구별 승인 정책이에요. 'allow'는 자동 승인, 'prompt'는 확인 요청, 'deny'는 차단이에요. 이 설정은 어떤 승인 모드에서도 적용돼요.",
	},
	"tools.approvalMode": {
		label: "도구 승인",
		description:
			"도구 호출의 기본 승인 동작이에요. '항상 묻기'는 읽기 전용 도구만 자동 승인하고, '쓰기'는 읽기와 프로젝트 쓰기 도구를 자동 승인하며, 'Yolo'는 모든 단계를 자동 승인하지만 사용자 정책으로 여전히 확인하거나 차단할 수 있어요.",
	},
	"features.unexpectedStopDetection": {
		label: "예기치 않은 중단 감지",
		description:
			"어시스턴트가 계속하겠다고 해 놓고 도구 호출 없이 멈추는 경우를 작은 모델로 감지해 자동으로 계속하도록 요청해요.",
	},

	// ── context ─────────────────────────────────────────────────────────────
	"workspace.additionalDirectories": {
		label: "추가 프로젝트 폴더",
		description:
			"모든 세션의 프로젝트에 추가 루트로 넣을 폴더예요(멀티 루트). /add-dir와 /remove-dir로 실시간 관리할 수 있어요. 경로는 cwd 기준으로 해석되며 절대 경로를 권장해요. 에이전트는 이 루트들의 존재를 알고 read/grep/glob을 사용할 수 있어요.",
	},
	"contextPromotion.enabled": {
		label: "컨텍스트 자동 승격",
		description: "컨텍스트가 넘치면 압축하는 대신 더 큰 컨텍스트 모델로 승격",
	},
	extendedContext: {
		label: "확장 컨텍스트",
		description:
			"지원하는 모델에서 더 큰 컨텍스트 창을 사용해요. 비용이 늘 수 있으며, 끄면 기본 또는 표준 과금 창을 사용해요.",
	},
	"compaction.enabled": { label: "자동 압축", description: "컨텍스트가 너무 커지면 자동으로 압축" },
	"compaction.midTurnEnabled": {
		label: "턴 중 압축",
		description: "다음 프로바이더 요청 전에 안전한 턴 중 도구 루프 경계에서 임계값 확인",
	},
	"compaction.methodOrder": {
		label: "압축 방법 순서",
		description:
			"자동 컨텍스트 관리 시 이 순서대로 시도해요. 현재 방법을 쓸 수 없거나 실패하면 다음 방법으로 넘어가요.",
	},
	"compaction.thresholdPercent": {
		label: "압축 임계값",
		description: "컨텍스트 관리의 비율 임계값. Default로 설정하면 기존 예약량 기반 동작을 사용해요",
	},
	"compaction.thresholdTokens": {
		label: "압축 토큰 한도",
		description: "컨텍스트 관리의 고정 토큰 한도. 설정하면 비율 임계값보다 우선해요",
	},
	"compaction.handoffSaveToDisk": {
		label: "핸드오프 문서 저장",
		description: "자동 핸드오프 과정에서 생성된 핸드오프 문서를 markdown 파일로 저장",
	},
	"compaction.remoteStreamingV2Enabled": {
		label: "원격 압축 V2",
		description: "호환되는 원격 압축 모델에 Responses 스트리밍 압축 사용",
	},
	"compaction.asyncEnabled": {
		label: "비동기 압축",
		description:
			"임계값에 가까워지면 백그라운드에서 압축 결과를 미리 만들고, 임계값에 도달하면 바로 현재 세션에 적용해요.",
	},
	"compaction.idleEnabled": { label: "유휴 압축", description: "토큰 수가 임계값을 넘으면 유휴 시간에 컨텍스트 압축" },
	"compaction.idleThresholdTokens": { label: "유휴 압축 임계값", description: "유휴 압축을 발동하는 토큰 수" },
	"compaction.idleTimeoutSeconds": { label: "유휴 압축 지연", description: "압축을 시작하기 전 유휴 대기 시간(초)" },
	"compaction.supersedeReads": {
		label: "오래된 읽기 대체",
		description: "같은 파일을 다시 읽으면 이전 읽기 결과를 정리(캐시 인식, 매 턴 실행)",
	},
	"compaction.dropUseless": {
		label: "쓸모없는 결과 생략",
		description:
			"도구 결과가 소비된 뒤 컨텍스트에 쓸모없다고 표시된 결과(일치 없음, 대기 타임아웃)를 정리(캐시 인식)",
	},
	"snapcompact.systemPrompt": {
		label: "Snapcompact 시스템 프롬프트",
		description:
			"실험적: 선택한 시스템 프롬프트 텍스트를 고밀도 PNG 이미지로 렌더링해 첫 사용자 메시지에 첨부해요(비전 모델 전용). 토큰을 아끼지만 이미지화된 텍스트는 프롬프트 캐시를 잃어요.",
	},
	"snapcompact.toolResults": {
		label: "Snapcompact 도구 결과",
		description:
			"실험적: 큰 과거 도구 결과를 텍스트 대신 고밀도 PNG 이미지로 렌더링해요(비전 모델 전용). 누적된 읽기/검색 출력의 토큰을 절약해요.",
	},
	"tools.format": {
		label: "도구 호출 모드",
		description:
			"도구를 모델에 노출하는 방식을 제어해요. Auto는 프로바이더 네이티브 도구 호출을 쓰되, 선택한 모델이 미지원으로 표시되어 있으면 GLM 자체 방언으로 폴백해요. Native는 프로바이더 네이티브 도구를 강제하고, 다른 값은 지정한 자체 방언을 강제해요. 세션 시작 시 적용돼요.",
	},
	"snapcompact.shape": {
		label: "Snapcompact 형태",
		description:
			"snapcompact가 텍스트를 찍을 프레임 형태(압축 아카이브와 인라인 이미지화). Auto는 현재 모델에 맞춰진 형태를 골라요.",
	},
	"branchSummary.enabled": { label: "브랜치 요약", description: "브랜치를 떠날 때 요약 생성을 제안" },
	"ttsr.enabled": {
		label: "TTSR",
		description: "출력이 규칙 패턴과 일치하면 에이전트 스트리밍을 중단(Time-Traveling Stream Rules)",
	},
	"ttsr.contextMode": { label: "TTSR 컨텍스트 모드", description: "TTSR이 발동했을 때 부분 출력 처리 방식" },
	"ttsr.interruptMode": { label: "TTSR 중단 모드", description: "스트림 중 바로 중단할지, 완료 후 경고를 주입할지" },
	"ttsr.repeatMode": {
		label: "TTSR 반복 모드",
		description: "규칙 재발동 방식: 세션당 한 번 또는 일정 메시지 간격 후",
	},
	"ttsr.repeatGap": { label: "TTSR 반복 간격", description: "규칙이 다시 발동하기 전에 필요한 메시지 수" },
	"ttsr.builtinRules": {
		label: "내장 규칙",
		description: "에이전트에 포함된 기본 규칙 불러오기(ttsr.disabledRules로 개별 재정의 가능)",
	},
	"ttsr.disabledRules": {
		label: "비활성 규칙",
		description: "완전히 무시할 규칙 이름(내장 기본 규칙과 직접 만든 규칙 모두 적용)",
	},
	"ttsr.judge": {
		label: "판정 규칙",
		description:
			"완료된 응답, 사고 과정, 도구 호출에 대해 judge 모델 역할에 각 `question` 규칙을 물어보고, yes이면 규칙을 경고로 주입해요.",
	},

	// ── memory ──────────────────────────────────────────────────────────────
	"memory.backend": {
		label: "메모리 백엔드",
		description:
			"끔, 로컬 요약 파이프라인, Mnemopi SQLite, Hindsight 원격 메모리, Sharpshooter 프로젝트 결정 메모리 중 선택",
	},
	"sharpshooter.model": {
		label: "Sharpshooter 모델",
		description: "프로젝트 결정을 추출하고 병합할 모델 선택자. 비워 두면 smol 역할을 사용해요",
	},
	"sharpshooter.intervalMinutes": {
		label: "Sharpshooter 병합 간격",
		description: "대기 중인 프로젝트 결정을 백그라운드에서 병합하는 간격(분)",
	},
	"sharpshooter.injectionTokenLimit": {
		label: "Sharpshooter 주입 한도",
		description: "턴마다 컨텍스트에 주입할 프로젝트 결정 메모리의 최대 토큰 수",
	},
	"autolearn.enabled": {
		label: "자동 학습(실험적)",
		description: "에이전트가 멈춘 뒤 배운 점을 메모리에 정리하고 격리된 관리형 스킬을 만들거나 다듬도록 알려요",
	},
	"autolearn.autoContinue": {
		label: "중단 시 자동 정리",
		description: "켜면 중단 후 비공개 정리 턴을 자동 실행해요(추가 토큰 소모). 끄면 상시 자동 학습 안내만 유지해요.",
	},
	"mnemopi.dbPath": {
		label: "Mnemopi 데이터베이스 경로",
		description: "선택적 SQLite 데이터베이스 경로예요. 기본값은 에이전트 메모리 폴더예요.",
	},
	"mnemopi.bank": {
		label: "Mnemopi 메모리 뱅크",
		description: "선택적 공유 메모리 뱅크 기본 이름. 프로젝트별 모드에서는 여기서 프로젝트 로컬 뱅크를 파생해요.",
	},
	"mnemopi.scoping": {
		label: "Mnemopi 범위",
		description:
			"global = 공유 뱅크 하나, per-project = cwd마다 별도 뱅크, per-project-tagged = 프로젝트 로컬 쓰기 + 전역 회상 노출",
	},
	"mnemopi.embeddingVariant": {
		label: "임베딩 모델 변형",
		description:
			"로컬 임베딩 모델 계열이에요. en = 더 강한 영어 모델, multilingual = 다국어 모델. 바꾸면 다음 시작 시 기존 메모리 임베딩을 다시 만들어요.",
	},
	"mnemopi.autoRecall": { label: "Mnemopi 자동 회상", description: "각 세션의 첫 턴에 로컬 메모리 회상" },
	"mnemopi.autoRetain": { label: "Mnemopi 자동 보존", description: "완료된 턴을 로컬 Mnemopi 메모리에 보존" },
	"mnemopi.polyphonicRecall": {
		label: "Mnemopi 다성부 회상",
		description: "4가지 회상(벡터, 그래프, 사실, 시간)을 켜고 역순위 융합(RRF)으로 병합",
	},
	"mnemopi.enhancedRecall": {
		label: "Mnemopi 향상된 회상",
		description: "반복되거나 비슷한 회상 쿼리에 계층형 쿼리 결과 캐시 사용",
	},
	"mnemopi.proactiveLinking": {
		label: "Mnemopi 능동 연결",
		description: "새 메모리를 저장할 때 바로 에피소드 그래프에 넣어 관련 엔티티와 메모리에 연결",
	},
	"mnemopi.noEmbeddings": {
		label: "Mnemopi 임베딩 끄기",
		description: "벡터 임베딩 대신 결정적인 FTS 전용 회상 강제",
	},
	"mnemopi.embeddingModel": {
		label: "Mnemopi 임베딩 모델",
		description: "고급: 변형 설정을 덮어쓰는 명시적 임베딩 모델 id. 비워 두면 mnemopi.embeddingVariant를 사용해요.",
	},
	"mnemopi.embeddingApiUrl": {
		label: "Mnemopi 임베딩 API URL",
		description: "Mnemopi에 전달할 선택적 OpenAI 호환 임베딩 엔드포인트",
	},
	"mnemopi.embeddingApiKey": { label: "Mnemopi 임베딩 API 키", description: "Mnemopi에 전달할 선택적 임베딩 API 키" },
	"mnemopi.llmMode": {
		label: "Mnemopi LLM 모드",
		description:
			"LLM 사용 안 함, 온라인 초소형 모델(/models의 TINY 역할, 없으면 @smol), 원격 OpenAI 호환 엔드포인트 중 선택",
	},
	"mnemopi.llmBaseUrl": {
		label: "Mnemopi LLM 기본 URL",
		description: "Mnemopi 원격 모드용 선택적 OpenAI 호환 LLM 엔드포인트",
	},
	"mnemopi.llmApiKey": { label: "Mnemopi LLM API 키", description: "Mnemopi 원격 모드용 선택적 LLM API 키" },
	"mnemopi.llmModel": { label: "Mnemopi LLM 모델", description: "Mnemopi 원격 모드용 선택적 LLM 모델 이름" },
	"hindsight.apiUrl": { label: "Hindsight API URL", description: "Hindsight 서버 URL(클라우드 또는 자체 호스팅)" },
	"hindsight.apiToken": { label: "Hindsight API 토큰", description: "인증이 필요한 Hindsight 서버용 Bearer 토큰" },
	"hindsight.bankId": { label: "Hindsight 메모리 뱅크 ID", description: "메모리 뱅크 식별자(기본값: 프로젝트 이름)" },
	"hindsight.scoping": {
		label: "Hindsight 범위",
		description:
			"global = 공유 뱅크 하나, per-project = cwd마다 별도 뱅크, per-project-tagged = 프로젝트 태그가 붙은 공유 뱅크로 회상 시 전역과 프로젝트 메모리를 병합",
	},
	"hindsight.autoRecall": { label: "Hindsight 자동 회상", description: "각 세션의 첫 턴에 메모리 회상" },
	"hindsight.autoRetain": {
		label: "Hindsight 자동 보존",
		description: "N턴마다, 그리고 세션 경계에서 세션 기록 보존",
	},
	"hindsight.retainMode": {
		label: "Hindsight 보존 모드",
		description: "full-session = 세션마다 문서 하나를 업서트, last-turn = 청크 단위",
	},
	"hindsight.mentalModelsEnabled": {
		label: "Hindsight 멘탈 모델",
		description:
			"시작 시 선별된 회고 요약(멘탈 모델)을 개발자 지침에 불러와요. 메모리 뱅크에 이미 있는 모델만 불러오고 쓰지는 않아요. hindsight.mentalModelAutoSeed와 함께 쓰면 내장 시드 세트도 자동으로 만들어요.",
	},
	"hindsight.mentalModelAutoSeed": {
		label: "Hindsight 멘탈 모델 자동 시드",
		description:
			"세션 시작 시 메모리 뱅크에 아직 없는 내장 멘탈 모델(project-conventions, project-decisions, user-preferences)을 만들어요.",
	},

	// ── files ───────────────────────────────────────────────────────────────
	"edit.mode": { label: "편집 모드", description: "편집 도구 변형 선택(replace, patch, hashline, apply_patch)" },
	"edit.fuzzyMatch": { label: "퍼지 매칭", description: "공백 차이에 대해 신뢰도 높은 퍼지 매칭 허용" },
	"edit.fuzzyThreshold": { label: "퍼지 매칭 임계값", description: "퍼지 매칭을 허용할 유사도 임계값(0-1)" },
	"edit.streamingAbort": {
		label: "미리보기 실패 시 중단",
		description: "패치 미리보기가 실패하면 스트리밍 편집 도구 호출 중단",
	},
	"edit.recoverInlineEdits": {
		label: "인라인 편집 내용 복구",
		description: "모델이 일반 텍스트로 출력한 편집 내용을 edit 도구 호출로 변환해 실행",
	},
	"edit.blockAutoGenerated": {
		label: "자동 생성 파일 차단",
		description: "자동 생성된 것으로 보이는 파일(protoc, sqlc, swagger 등) 편집 차단",
	},
	"edit.enforceSeenLines": {
		label: "본 줄 가드 강제",
		description: "이전 읽기/검색에서 전체가 표시된 적 없는 줄에 고정된 편집을 거부",
	},
	"edit.blackbox.enabled": {
		label: "편집 파싱 회귀 기록",
		description: "편집으로 AST 파싱이 실패하면 수정 전후 소스와 호출 정보를 로컬 진단 로그에 추가",
	},
	readLineNumbers: { label: "줄 번호", description: "기본적으로 읽기 도구 출력 앞에 줄 번호 추가" },
	"read.defaultLimit": {
		label: "기본 읽기 줄 수",
		description: "에이전트가 줄 수 제한 없이 read를 호출할 때 기본으로 반환하는 줄 수",
	},
	"read.renderMarkdown": {
		label: "Markdown 미리보기",
		description: "Markdown 읽기 결과를 원본 소스 대신 서식 있는 터미널 Markdown 미리보기로 렌더링",
	},
	"read.summarize.enabled": {
		label: "읽기 요약",
		description: "명시적 선택자 없이 read를 호출하면 구조화된 코드 요약 반환",
	},
	"read.summarize.prose": { label: "산문 요약", description: "Markdown과 일반 텍스트 읽기에 구조화된 요약 반환" },
	"read.summarize.minBodyLines": {
		label: "요약 접기 본문 줄 수",
		description: "여러 줄 함수 본문이나 리터럴이 이 줄 수를 넘어야 읽기 요약에서 접어요",
	},
	"read.summarize.minCommentLines": {
		label: "요약 접기 주석 줄 수",
		description: "여러 줄 블록 주석이 이 줄 수를 넘어야 읽기 요약에서 접어요",
	},
	"read.summarize.minTotalLines": {
		label: "요약 최소 파일 줄 수",
		description: "전체 줄 수가 이 값보다 적은 파일은 구조화 요약 없이 원문 그대로 읽어요",
	},
	"read.summarize.unfoldUntil": {
		label: "요약 펼치기 목표",
		description:
			"요약이 최소 이 줄 수만큼 보일 때까지 생략 가능한 구간을 BFS로 펼쳐요. 0이면 최외곽 생략만 유지해요.",
	},
	"read.summarize.unfoldLimit": {
		label: "요약 펼치기 상한",
		description:
			"BFS 펼치기 시 요약 크기의 하드 상한이에요. 어떤 펼치기로 보이는 줄 수가 이 값을 넘게 되면 그 펼치기는 건너뛰고(해당 구간은 접힌 채 유지) 나머지 구간을 계속 펼쳐요.",
	},
	"read.toolResultPreview": {
		label: "인라인 읽기 미리보기",
		description: "세션 기록에서 읽기 도구 결과를 요약 줄 대신 인라인으로 렌더링",
	},
	"lsp.enabled": { label: "LSP", description: "코드 인텔리전스(정의, 참조, 진단, 이름 변경)를 위한 lsp 도구 사용" },
	"lsp.lazy": {
		label: "LSP 지연 시작",
		description: "세션 시작 시가 아니라 처음 사용할 때(lsp 도구 또는 일치하는 파일 형식 편집) 언어 서버 시작",
	},
	"lsp.formatOnWrite": { label: "쓰기 후 포맷", description: "코드 파일을 쓴 뒤 LSP로 자동 포맷" },
	"lsp.diagnosticsOnWrite": { label: "쓰기 후 진단", description: "코드 파일을 쓴 뒤 LSP 진단 반환" },
	"lsp.diagnosticsOnEdit": { label: "편집 후 진단", description: "코드 파일을 편집한 뒤 LSP 진단 반환" },
	"lsp.diagnosticsDeduplicate": {
		label: "진단 중복 제거",
		description: "파일에서 이미 표시된 편집 후 LSP 진단은 숨기고 새로 생기거나 바뀐 것만 표시",
	},

	// ── shell ───────────────────────────────────────────────────────────────
	"bash.enabled": { label: "Bash", description: "shell 명령 실행을 위한 bash 도구 사용" },
	"bash.allowCompoundCommands": {
		label: "복합 명령 개별 승인",
		description:
			"&&로 연결된 단순 명령마다 승인 규칙을 개별 매칭해요. 매칭되지 않은 명령은 일반 Bash 승인 정책을 따라요.",
	},
	"bash.autoBackground.enabled": {
		label: "Bash 자동 백그라운드",
		description: "오래 실행되는 bash 명령을 자동으로 백그라운드로 보내고 나중에 결과 전달",
	},
	"bash.patterns": {
		label: "Bash 승인 패턴",
		description:
			"순서가 있는 bash 명령 승인 규칙이에요. 각 항목에 match와 approval 필드가 있고 '*' 와일드카드만 지원해요.",
	},
	"bashInterceptor.enabled": { label: "Bash 인터셉터", description: "전용 도구가 있는 shell 명령 차단" },
	"bash.direnv": {
		label: "direnv 자동 로드",
		description:
			"저장소의 direnv/devenv `.envrc`를 bash 세션에 자동으로 불러와 수동 `direnv exec` 없이 devenv 도구와 환경 변수를 쓸 수 있게 해요. direnv 허용 목록을 따르며, `direnv allow`되지 않은 `.envrc`는 절대 실행하지 않아요",
	},
	"bash.direnvLoadTimeoutMs": {
		label: "direnv 로드 타임아웃(ms)",
		description:
			"첫 `direnv export`의 최대 대기 시간(콜드 스타트 devenv shell은 느릴 수 있음). 시간이 초과되면 세션은 direnv 환경 없이 실행돼요",
	},
	"shellMinimizer.enabled": {
		label: "셸 출력 압축",
		description: "에이전트에 반환하기 전에 장황한 shell 출력(git, npm, cargo 등)을 압축",
	},
	"shellMinimizer.sourceOutlineLevel": {
		label: "셸 압축 소스 개요",
		description: "소스 파일을 cat/read할 때의 소스 개요 모드: default 또는 aggressive",
	},
	"eval.py": { label: "Python Eval 백엔드", description: "eval 도구가 Python 셀을 IPython 커널로 보내도록 허용" },
	"eval.js": {
		label: "JavaScript Eval 백엔드",
		description: "eval 도구가 JavaScript 셀을 프로세스 내 런타임으로 보내도록 허용",
	},
	"eval.tools.enabled": {
		label: "Eval 정의 도구",
		description: "eval 셀이 task, agent(), workpool() 서브에이전트가 호출할 수 있는 도구를 정의하도록 허용",
	},
	"eval.workpool.freshAgents": {
		label: "Workpool에 새 에이전트 사용",
		description: "workpool 항목마다 새 서브에이전트를 시작하고 worker 재사용이나 대기 항목 일괄 처리를 하지 않아요",
	},
	"python.kernelMode": {
		label: "Python 커널 모드",
		description: "eval 호출 사이에 IPython 커널을 유지하거나 매번 새로 시작",
	},
	"python.interpreter": {
		label: "Python 인터프리터",
		description: "정확한 Python 실행 파일을 가리키는 선택적 경로예요. 설정하면 Python 런타임 자동 탐지를 건너뛰어요.",
	},

	// ── tools ───────────────────────────────────────────────────────────────
	"tools.artifactSpillThreshold": {
		label: "아티팩트 분리 임계값(KB)",
		description: "이 크기를 넘는 도구 출력은 artifact로 저장하고 끝부분만 인라인으로 유지",
	},
	"tools.artifactTailBytes": {
		label: "아티팩트 끝부분 크기(KB)",
		description: "출력이 artifact로 분리될 때 인라인으로 유지할 끝부분 분량",
	},
	"tools.artifactHeadBytes": {
		label: "아티팩트 앞부분 크기(KB)",
		description:
			"출력이 artifact로 분리될 때 끝부분과 함께 인라인으로 유지할 앞부분 분량(중간 생략)이에요. 0이면 끄고 끝부분만 유지해요.",
	},
	"tools.outputMaxColumns": {
		label: "출력 열 제한",
		description:
			"스트리밍 도구 출력(bash, python, js eval)과 `read`의 줄당 바이트 제한이에요. 이 너비를 넘는 줄은 줄임표로 잘리고, 다음 줄바꿈까지 남은 바이트는 버려져요. 0이면 사용 안 함이에요.",
	},
	"tools.artifactTailLines": {
		label: "아티팩트 끝부분 줄 수",
		description: "출력이 artifact로 분리될 때 인라인으로 유지할 최대 끝부분 줄 수",
	},
	"todo.enabled": { label: "할 일", description: "할 일을 추적하는 todo 도구 사용" },
	"todo.reminders": { label: "할 일 알림", description: "에이전트가 멈추기 전에 할 일을 끝내도록 알림" },
	"todo.remindersMax": { label: "할 일 알림 상한", description: "포기하기 전 최대 할 일 알림 횟수" },
	"todo.eager": { label: "할 일 자동 생성", description: "첫 메시지 후 할 일 목록 자동 생성을 유도하는 강도" },
	"glob.enabled": { label: "Glob", description: "glob 패턴 파일 찾기를 위한 glob 도구 사용" },
	"grep.enabled": { label: "Grep", description: "정규식 내용 검색을 위한 grep 도구 사용" },
	"grep.contextBefore": { label: "Grep 앞 컨텍스트", description: "각 grep 일치 앞에 표시할 컨텍스트 줄 수" },
	"grep.contextAfter": { label: "Grep 뒤 컨텍스트", description: "각 grep 일치 뒤에 표시할 컨텍스트 줄 수" },
	"astGrep.enabled": { label: "AST Grep", description: "구조적 AST 검색을 위한 ast_grep 도구 사용" },
	"astEdit.enabled": { label: "AST 편집", description: "구조적 AST 재작성을 위한 ast_edit 도구 사용" },
	"debug.enabled": { label: "디버그", description: "DAP 기반 디버깅을 위한 debug 도구 사용" },
	"launch.enabled": {
		label: "프로세스 실행",
		description: "공유되는 장기 실행 프로젝트 프로세스를 관리하는 launch 도구 사용",
	},
	"speechgen.enabled": {
		label: "음성 생성",
		description: "온디바이스(Kokoro) 또는 xAI Grok Voice 음성 파일 합성을 위한 tts 도구 사용",
	},
	"generate_image.enabled": {
		label: "이미지 생성",
		description:
			"generate_image 도구(텍스트→이미지 및 이미지 편집)를 사용해요. tools.xdev가 켜져 있으면 xd:// 장치로 노출돼요.",
	},
	"computer.enabled": {
		label: "데스크톱 제어",
		description: "OpenAI computer use를 위한 네이티브 데스크톱 스크린샷과 입력 사용",
	},
	"computer.display": {
		label: "데스크톱 제어 디스플레이",
		description: "모든 디스플레이를 합성하거나 네이티브 디스플레이 id 하나를 선택",
	},
	"computer.maxWidth": { label: "스크린샷 최대 너비", description: "합성 스크린샷의 최대 너비(픽셀)" },
	"computer.maxHeight": { label: "스크린샷 최대 높이", description: "합성 스크린샷의 최대 높이(픽셀)" },
	"images.questionTimeoutMs": {
		label: "이미지 질문 타임아웃",
		description:
			"read 도구가 ?q=로 비전 모델에 질문할 때의 요청당 타임아웃(ms)이에요. 프로바이더가 멈추면 빠르게 실패하며, 0이면 타임아웃을 꺼요.",
	},
	"checkpoint.enabled": {
		label: "체크포인트/되감기",
		description: "컨텍스트 체크포인트 관리를 위한 checkpoint와 rewind 도구 사용",
	},

	"fetch.enabled": { label: "URL 읽기", description: "read 도구가 URL을 가져와 처리하도록 허용해요" },
	"vault.enabled": {
		label: "Obsidian 볼트",
		description:
			"Obsidian CLI로 Obsidian 볼트 내용을 읽고 쓰는 vault:// 내부 URL을 활성화해요. 비활성화하면 vault:// 해석이 거부되고 시스템 프롬프트의 vault:// 항목도 생략돼요.",
	},
	"github.enabled": {
		label: "GitHub CLI",
		description:
			"github 도구를 활성화해요(op 기반 디스패치로 저장소, issue, pull request, diff, 검색, checkout, push, Actions 감시 워크플로를 다뤄요)",
	},
	"github.cache.enabled": {
		label: "GitHub 뷰 캐시",
		description: "렌더링된 issue/PR 뷰 출력을 ~/.omp/cache/github-cache.db에 캐시해 반복 읽기 비용을 없애요",
	},
	"github.cache.softTtlSec": {
		label: "GitHub 캐시 소프트 TTL",
		description: "이 시간 안에는 캐시된 issue/PR 뷰를 그대로 반환해요(초, 기본 5분)",
	},
	"github.cache.hardTtlSec": {
		label: "GitHub 캐시 하드 TTL",
		description:
			"소프트 TTL이 지나면 캐시를 반환하고 백그라운드에서 갱신해요. 하드 TTL이 지나면 폐기해요(초, 기본 7일)",
	},
	"web_search.enabled": { label: "웹 검색", description: "실시간 웹 결과를 가져오는 web_search 도구를 활성화해요" },
	"security.enabled": {
		label: "보안",
		description: "omp 네이티브 보안 스캔의 계획·실행과 읽기 전용 security:// 리소스 네임스페이스를 활성화해요",
	},
	"ask.enabled": { label: "질문", description: "사용자에게 대화형으로 질문하는 ask 도구를 활성화해요" },
	"browser.enabled": {
		label: "브라우저",
		description: "스크립트 기반 Chromium 자동화(puppeteer)용 browser 도구를 활성화해요",
	},
	"browser.cdpUrl": {
		label: "브라우저 CDP URL",
		description:
			"새 브라우저를 띄우는 대신 기존 브라우저에 연결할 기본 HTTP CDP 검색 엔드포인트(예: http://127.0.0.1:9222). 도구 호출에 명시한 app.cdp_url 또는 app.path가 우선해요.",
	},
	"browser.headless": {
		label: "헤드리스 브라우저",
		description: "브라우저를 헤드리스 모드로 실행해요(비활성화하면 브라우저 창을 표시해요)",
	},
	"browser.cmux": {
		label: "cmux 브라우저",
		description:
			"cmux 소켓을 사용할 수 있으면 cmux WKWebView 화면으로 브라우저를 자동화해요. PI_BROWSER_CMUX=0 또는 PI_BROWSER_CMUX=1로 덮어쓸 수 있어요.",
	},
	"browser.screenshotDir": {
		label: "스크린샷 폴더",
		description:
			"스크린샷을 저장할 폴더예요. 설정하지 않으면 임시 파일에 저장해요. ~를 지원해요. 예: ~/Downloads, ~/Desktop, /sdcard/Download(Android)",
	},
	"tools.intentTracing": {
		label: "의도 추적",
		description: "에이전트가 각 도구 호출 전에 의도를 설명하도록 요구해요",
	},
	"tools.abortOnFabricatedResult": {
		label: "조작된 도구 결과 시 중단",
		description:
			"인밴드 도구 호출을 쓸 때 모델이 턴 중에 도구 결과를 지어내기 시작하면 즉시 중단해요. 비활성화하면 생성을 마치게 한 뒤 지어낸 후속 내용을 버려요.",
	},
	"tools.maxTimeout": {
		label: "도구 타임아웃 상한",
		description: "에이전트가 도구에 설정할 수 있는 최대 타임아웃(초, 0 = 무제한)",
	},
	"async.enabled": { label: "비동기 실행", description: "비동기 bash 명령과 백그라운드 실행을 활성화해요" },
	"tools.xdev": {
		label: "xd:// 도구",
		description:
			"자주 쓰지 않는(검색 가능한) 도구를 xd:// 디바이스 URL 아래에 마운트해, 매 요청마다 스키마를 보내는 대신 read/write로 구동해요. 비활성화하면 활성화된 모든 도구를 최상위에 노출해요.",
	},
	"tools.xdevDocs": {
		label: "xd:// 프롬프트 문서",
		description:
			"마운트된 디바이스 중 어떤 문서와 스키마를 시스템 프롬프트에 인라인할지 선택해요. Built-ins는 핵심 도구를 인라인하고 MCP와 확장 도구는 필요할 때만 불러와요.",
	},
	"tools.xdevInlineDevices": {
		label: "xd:// 인라인 디바이스",
		description:
			'xd:// 프롬프트 문서가 "내장만"일 때 이름이 이 glob 패턴과 일치하는 동적 디바이스(예: mcp__context_mode_*)를 인라인해요. "목록만"에서는 이 설정을 무시해요.',
	},
	"mcp.enableProjectConfig": {
		label: "MCP 프로젝트 설정",
		description: "프로젝트 루트에서 .mcp.json/mcp.json을 불러와요",
	},
	"mcp.renderMarkdownResults": {
		label: "MCP Markdown 결과",
		description: "JSON이 아닌 MCP 텍스트 결과를 트랜스크립트에서 Markdown으로 렌더링해요",
	},
	"mcp.notifications": { label: "MCP 업데이트 주입", description: "MCP 리소스 업데이트를 에이전트 세션에 주입해요" },
	"mcp.notificationDebounceMs": {
		label: "MCP 알림 디바운스",
		description: "MCP 리소스 업데이트를 세션에 주입하기 전 디바운스 시간(밀리초)",
	},
	"mcp.startupTimeoutMs": {
		label: "MCP 시작 대기 시간",
		description: "초기 MCP 도구 검색을 이 밀리초만큼 기다려요. 0이면 연결이 안정될 때까지 기다려요.",
	},
	"tasks.todoClearDelay": {
		label: "할 일 자동 삭제 지연",
		description: "완료되거나 포기한 할 일을 할 일 위젯에서 제거하기 전 지연 시간",
	},
	"dev.autoqa": {
		label: "자동 QA",
		description:
			"자동 도구 문제 보고(xd://report_issue)예요. 기본으로 켜져 있고 첫 보고 때 동의를 구해요. 거부하면 다시 명시적으로 켤 때까지 보고하지 않아요",
	},
	"dev.autoqaPush.endpoint": {
		label: "자동 QA 푸시 엔드포인트",
		description: "자동 QA JSON 보고를 받을 전체 URL(기본 https://qa.omp.sh/v1/grievances)",
	},

	// ── tasks ───────────────────────────────────────────────────────────────
	"plan.enabled": {
		label: "계획 모드",
		description: "계획 모드를 활성화해요: 실행 전에 읽기 전용으로 탐색하고 계획해요",
	},
	"plan.defaultOnStartup": { label: "계획 모드로 시작", description: "새 세션마다 자동으로 계획 모드에 들어가요" },
	"goal.enabled": { label: "목표 모드", description: "세션별 목표 모드와 숨겨진 goal 도구를 활성화해요" },
	"goal.statusInFooter": {
		label: "하단 바에 목표 상태 표시",
		description: "상태 표시줄의 목표 표시 옆에 토큰 예산을 보여줘요",
	},
	"goal.continuationModes": {
		label: "목표 이어가기 모드",
		description: "활성 목표가 턴 사이에 자동으로 이어갈 수 있는 실행 모드",
	},
	"title.refreshOnReplan": {
		label: "재계획 시 제목 갱신",
		description: "할 일 초기화로 재계획되면 생성된 세션 제목을 갱신해요. 사용자가 정한 제목은 제외해요",
	},
	"task.isolation.enabled": {
		label: "서브에이전트 격리",
		description: "체크아웃한 격리 사본에서 서브에이전트를 실행하고 완료 후 변경 사항을 통합해요",
	},
	"isolation.backend": {
		label: "격리 백엔드",
		description: "서브에이전트 격리와 워크트리 클론에 쓰는 백엔드",
	},
	"worktree.clone": {
		label: "현재 체크아웃을 워크트리로 클론",
		description:
			"새 워크트리는 현재 체크아웃을 copy-on-write로 클론해 node_modules, target 등 무시된 빌드 산출물을 함께 유지해요. 지원하지 않으면 일반 체크아웃으로 대체해요",
	},
	"worktree.cleanSource": {
		label: "/wt 생성 후 원본 체크아웃 정리",
		description:
			"/wt로 워크트리를 만들어 변경 사항을 옮긴 뒤 원본 체크아웃의 추적 중인 변경을 되돌리고 추적되지 않는 파일을 삭제해요",
	},
	"task.isolation.apply": {
		label: "격리 변경 사항 적용",
		description:
			"성공한 격리 서브에이전트의 변경 사항을 부모 체크아웃에 자동으로 적용해요. 비활성화하면 patch 또는 브랜치 산출물로 남겨요",
	},
	"task.isolation.merge": {
		label: "격리 병합 전략",
		description: "격리 서브에이전트 변경 사항을 통합하는 방식(patch 적용 또는 브랜치 병합)",
	},
	"task.isolation.commits": {
		label: "격리 커밋 스타일",
		description: "중첩 저장소 변경의 커밋 메시지 스타일(일반 또는 AI 생성)",
	},
	"worktree.base": {
		label: "워크트리 기본 폴더",
		description:
			"에이전트가 관리하는 워크트리의 기본 폴더로, 서브에이전트 격리 사본, `github` PR 체크아웃, `omp worktree` 정리가 모두 여기에 있어요. 설정하지 않으면 ~/.omp/wt를 써요. 절대 경로나 ~ 기준 경로여야 하며 상대 경로는 무시돼요. OMP_WORKTREE_DIR 환경 변수로 덮어쓸 수 있어요.",
	},
	"task.eager": { label: "서브에이전트 위임 우선", description: "일을 서브에이전트에 위임하도록 유도하는 강도" },
	"task.batch": {
		label: "일괄 서브에이전트 호출",
		description:
			"task 도구를 일괄 형태로 바꿔요: 한 번의 호출에 { context, tasks[] }를 담아 항목마다 서브에이전트 하나를 띄우며, 항목별 agent(기본은 세션 생성 정책 agent)와 항목별 격리를 지정할 수 있고, 모든 항목 앞에 붙는 공유 컨텍스트를 가져요. async.enabled=true이면 각 생성이 독립 백그라운드 에이전트로 실행되어 일반 idle/parked 수명 주기를 따르고, 아니면 호출이 병합된 결과를 기다리며 블록돼요. 비활성화하면 단일 생성 스키마로 돌아가요.",
	},
	"task.enableEffort": {
		label: "서브에이전트별 강도 지정",
		description:
			"서브에이전트 생성에 선택적 effort 파라미터를 노출해 호출자가 서브에이전트별 사고 수준을 덮어쓸 수 있게 해요",
	},
	"task.maxConcurrency": { label: "최대 동시 서브에이전트 수", description: "동시에 실행되는 서브에이전트의 최대 수" },
	"task.enableLsp": {
		label: "서브에이전트 LSP 사용",
		description:
			"task 도구가 생성한 서브에이전트가 lsp 도구를 쓰도록 허용해요. 서브에이전트 비용을 낮추려고 기본은 꺼져 있어요. LSP 기반 위임이 추가 토큰만큼 가치 있을 때 켜세요.",
	},
	"task.maxRecursionDepth": {
		label: "서브에이전트 재귀 깊이 상한",
		description: "서브에이전트가 자기 서브에이전트를 생성할 수 있는 깊이",
	},
	"task.maxRuntimeMs": {
		label: "서브에이전트 실행 시간 상한",
		description:
			'서브에이전트별 실제 경과 시간 하드 제한(밀리초)이에요. 0이면 비활성화해요. 추론 계층 감시를 벗어난 프로바이더 측 스트리밍 멈춤을 막아주며, 걸리면 "타임아웃" 사유로 서브에이전트를 정상 중단해요.',
	},
	"task.agentIdleTtlMs": {
		label: "에이전트 유휴 TTL",
		description:
			"유휴 서브에이전트를 메모리에 유지하다가 디스크로 파킹하기까지의 시간(밀리초)이에요. 파킹된 에이전트는 메시지를 받거나 재개되면 자동으로 깨어나요. 0이면 유휴 에이전트를 종료할 때까지 유지해요.",
	},
	"task.softRequestBudget": {
		label: "서브에이전트 소프트 요청 예산",
		description:
			"서브에이전트별 소프트 요청 예산(실행당 어시스턴트 요청 수)이에요. 넘으면 마무리 안내 프롬프트를 주입하고(task.softRequestBudgetNotice 참고), 예산의 1.5배에 이르면 실행을 강제로 멈추고 에이전트가 부분 결론을 제출해야 해요. 0이면 이 가드를 비활성화해요. 내장 scout/sonic 에이전트는 더 낮은 내장 상한이 있어 그보다 낮은 값만 적용돼요.",
	},
	"task.softRequestBudgetNotice": {
		label: "소프트 요청 예산 안내",
		description:
			"서브에이전트가 소프트 요청 예산을 넘으면 1.5배 강제 제출 전에 마무리하라는 안내 프롬프트를 주입해요.",
	},
	"task.maxEffort": {
		label: "생성별 강도 상한",
		description:
			"task 도구의 생성별 effort 힌트로 허용하는 최대 사고 강도예요. 낮은 값은 호출자가 서브에이전트를 이 상한 위로 올리지 못하게 해요. 기본값은 모델의 전체 범위를 유지해요.",
	},
	"task.prewalk": {
		label: "범용 서브에이전트 사전 탐색",
		description:
			"내장 범용 `task` 서브에이전트에 사전 탐색(prewalk)을 활성화해요: 해석된 모델로 시작해 계획하고 구현을 시작한 뒤, 첫 편집/쓰기 시점에 'smol' 역할로 핸드오프해요. 에이전트별 덮어쓰기(task.agentPrewalk, /agents에서 P로 전환)와 사용자 에이전트의 `prewalk` frontmatter는 이 스위치의 영향을 받지 않아요.",
	},
	"skills.enableSkillCommands": { label: "스킬 명령", description: "스킬을 /skill:name 명령으로 등록해요" },
	"commands.enableClaudeUser": { label: "Claude 사용자 명령", description: "~/.claude/commands/에서 명령을 불러와요" },
	"commands.enableClaudeProject": {
		label: "Claude 프로젝트 명령",
		description: ".claude/commands/에서 명령을 불러와요",
	},
	"commands.enableOpencodeUser": {
		label: "OpenCode 사용자 명령",
		description: "~/.config/opencode/commands/에서 명령을 불러와요",
	},
	"commands.enableOpencodeProject": {
		label: "OpenCode 프로젝트 명령",
		description: ".opencode/commands/에서 명령을 불러와요",
	},

	// ── providers ───────────────────────────────────────────────────────────
	"providers.maxInFlightRequests": {
		label: "최대 동시 요청 수",
		description:
			'프로바이더 id별(예: "openai" 또는 "anthropic") 최대 동시 LLM 요청 수로, 이 설정 루트를 쓰는 로컬 omp 프로세스끼리 공유해요. 목록에 없는 프로바이더는 제한하지 않아요.',
	},
	"secrets.enabled": {
		label: "시크릿 숨기기",
		description: "AI 프로바이더에 보내기 전에 설정된 시크릿을 난독화하고 자격 증명 형태의 토큰을 가려요",
	},
	"providers.ollama-cloud.maxConcurrency": {
		label: "Ollama Cloud 최대 동시 실행",
		description:
			"프로세스별 Ollama Cloud 서브에이전트 동시 실행 상한이에요. 0이면 이 프로바이더 전용 제한을 비활성화해요",
	},
	"providers.antigravityEndpoint": {
		label: "Antigravity 엔드포인트 모드",
		description: "google-antigravity 프로바이더의 엔드포인트 라우팅 전략(chat, search, image, discovery)",
	},
	"providers.fireworksTier": { label: "Fireworks 등급", description: "기본 서비스 경로(service_tier 없음)" },
	"live.voice": { label: "실시간 음성 목소리", description: "Codex 기반 실시간 음성 세션에서 쓸 목소리" },
	"tts.localVoice": {
		label: "로컬 TTS 목소리",
		description: "로컬 TTS 백엔드가 쓰는 Kokoro 목소리(미국/영국식, 여성/남성)",
	},
	"speech.enabled": { label: "음성 읽기", description: "어시스턴트 출력이 스트리밍되는 대로 스피커로 읽어줘요" },
	"speech.mode": {
		label: "음성 읽기 모드",
		description: "읽을 내용: all = 어시스턴트 메시지 + 사고, assistant = 메시지만, yield = 턴 종료 시 최종 메시지만",
	},
	"speech.enhanced": {
		label: "향상된 음성 재작성",
		description:
			"합성 전에 tiny/smol 모델로 어시스턴트 출력을 자연스러운 구어체로 바꿔요(코드를 설명하고 링크와 markdown을 제거). 실패하면 기계적 정리로 대체해요",
	},
	"speech.voice": { label: "음성 읽기 목소리", description: "어시스턴트 출력을 읽을 때 쓸 Kokoro 목소리" },
	"providers.tinyModelDevice": {
		label: "Tiny 모델 디바이스",
		description:
			"로컬 tiny 모델(제목 + 메모리)의 ONNX 실행 프로바이더예요. 기본은 CPU 추론만 해요. PI_TINY_DEVICE 환경 변수로 덮어쓸 수 있어요.",
	},
	"providers.tinyModelDtype": {
		label: "Tiny 모델 정밀도",
		description:
			"로컬 tiny 모델의 ONNX 양자화/정밀도예요. 기본은 각 모델의 dtype(q4)을 써요. 낮은 정밀도는 더 빠르고 높은 정밀도는 더 정확해요. PI_TINY_DTYPE 환경 변수로 덮어쓸 수 있어요.",
	},
	"providers.kimiApiFormat": {
		label: "Kimi API 형식",
		description: "Kimi Code 프로바이더의 API 형식(auto는 실시간 모델 메타데이터를 따라요)",
	},
	"providers.openaiWebsockets": {
		label: "OpenAI WebSockets",
		description: "OpenAI Codex 모델의 websocket 정책(auto는 모델 기본값, on은 강제 사용, off는 비활성화)",
	},
	"providers.streamFirstEventTimeoutSeconds": {
		label: "스트림 첫 이벤트 타임아웃",
		description: "모델 스트림의 첫 이벤트를 기다리는 초. -1은 프로바이더/환경 변수 기본값, 0은 감시를 비활성화해요",
	},
	"providers.streamIdleTimeoutSeconds": {
		label: "스트림 유휴 타임아웃",
		description:
			"모델 스트림이 이벤트 사이에 조용히 있어도 되는 초. -1은 프로바이더/환경 변수 기본값, 0은 감시를 비활성화해요",
	},
	"providers.openrouterVariant": {
		label: "OpenRouter 라우팅",
		description: "OpenRouter 모델 ID에 붙일 기본 라우팅 변형 접미사(선택자에 변형이 지정되면 무시돼요)",
	},
	"providers.fetch": { label: "가져오기 프로바이더", description: "fetch/read URL 도구의 리더 백엔드 우선순위" },
	"codexResets.autoRedeem": {
		label: "Codex 저장된 리셋 자동 사용",
		description:
			"저장된 Codex 사용량 리셋을 자동으로 써요: 턴이 막히고 대신할 다른 계정이 없을 때 5시간 또는 주간 한도 소진으로 잠긴 계정을 복구하고, 곧 만료될 크레딧을 살려요. unset은 처음 쓰기 전에 묻고, yes는 묻지 않고 쓰며, no는 두 검사를 모두 꺼요.",
	},
	"codexResets.minBlockedMinutes": {
		label: "Codex 자동 사용 최소 잠금 시간",
		description:
			"자연 해제(소진된 5시간/주간 한도 중 가장 늦은 리셋)까지 최소 이 분 수가 남았을 때만 자동 사용해요(짧은 대기를 피하려고 귀한 크레딧을 쓰지 않도록). 크게(예: 360) 설정하면 5시간 한도만의 잠금은 무시해요.",
	},
	"codexResets.keepCredits": {
		label: "Codex 자동 사용 보유량",
		description:
			"저장된 리셋이 이 수보다 적으면 자동으로 쓰지 않아요(0 = 마지막 크레딧까지 자동 사용). 곧 만료될 크레딧은 예외예요. 남겨둔 크레딧이 만료되면 아무것도 남지 않으니까요.",
	},
	"codexResets.salvageHorizonHours": {
		label: "Codex 리셋 살리기 기간",
		description:
			"저장된 Codex 리셋이 이 시간 안에 만료되고, 채팅 한도(5시간 또는 주간) 중 하나에 복구 가능한 실사용량이 있으면 자동으로 써요(0이면 만료 살리기를 비활성화해요).",
	},
	"provider.appendOnlyContext": {
		label: "추가 전용 컨텍스트",
		description:
			"시스템 프롬프트와 도구 스펙을 캐시하고 메시지 로그를 추가 전용으로 유지해 프로바이더 프리픽스 캐시(DeepSeek, Xiaomi/SGLang, Anthropic) 적중률을 최대화해요. Auto는 프리픽스 캐시를 지원하는 것으로 알려진 프로바이더에서 활성화해요.",
	},
	"exa.enabled": { label: "Exa", description: "모든 Exa 검색 도구의 전체 스위치" },
	"exa.searchDelayMs": {
		label: "Exa 검색 지연",
		description: "Exa 웹 검색 요청 사이의 최소 지연(밀리초). 0이면 제한을 비활성화해요",
	},
	"searxng.endpoint": {
		label: "SearXNG 엔드포인트",
		description: "웹 검색에 쓸 자체 호스팅 SearXNG 인스턴스 기본 URL",
	},

	// ── advanced（ui 메타데이터 없음, Advanced 탭으로 분류）─────────────────────────
	// 일반
	setupVersion: {
		label: "설정 마법사 버전",
		description: "마지막으로 실행한 설정 마법사 버전을 기록해 버전별로 새 안내 단계만 보여줘요",
	},
	"auth.broker.url": {
		label: "인증 브로커 URL",
		description:
			"자격 증명을 중계하는 원격 `omp auth-broker serve` 호스트 주소예요. 보통 OMP_AUTH_BROKER_URL 환경 변수로 설정해요",
	},
	"auth.broker.token": {
		label: "인증 브로커 토큰",
		description: "인증 브로커에 접근하는 토큰이에요. 보통 OMP_AUTH_BROKER_TOKEN 환경 변수로 설정해요",
	},
	shellPath: { label: "셸 경로", description: "자동 감지 결과를 덮어쓰는 사용자 지정 shell 실행 파일 경로" },
	extensions: { label: "확장 경로", description: "시작 시 추가로 불러올 확장 경로 목록" },
	enabledModels: {
		label: "모델 허용 목록",
		description:
			"사용 가능한 모델을 제한하는 선택자 패턴 목록이에요. 비어 있으면 제한하지 않아요(경로 범위별 설정 지원)",
	},
	enabledProviders: {
		label: "활성화된 기능 프로바이더",
		description: "추가로 활성화할 기능 검색 프로바이더 id 목록(경로 범위별 설정 지원)",
	},
	disabledProviders: {
		label: "비활성화된 프로바이더",
		description: "비활성화할 프로바이더 id 목록으로, 기능 검색 소스와 모델 선택기의 프로바이더에 공통으로 적용돼요",
	},
	disabledExtensions: { label: "비활성화된 확장", description: "id로 비활성화한 확장 목록(확장 패널에서 관리)" },
	modelRoles: { label: "모델 역할 할당", description: "역할(default, smol, slow, advisor 등)과 모델 선택자의 매핑" },
	modelTags: { label: "모델 태그", description: "사용자 지정 모델 태그의 이름, 색상, 표시 여부 설정" },
	modelProviderOrder: { label: "프로바이더 순서", description: "모델 선택기에 표시되는 프로바이더 순서" },
	cycleOrder: { label: "빠른 전환 순환", description: "모델 빠른 전환 순환의 역할 순서(기본 smol → default → slow)" },
	// 상태 표시줄과 인라인 이미지
	"statusLine.leftSegments": {
		label: "상태 표시줄 왼쪽 세그먼트",
		description: "상태 표시줄 왼쪽에 순서대로 표시할 세그먼트 id 목록",
	},
	"statusLine.rightSegments": {
		label: "상태 표시줄 오른쪽 세그먼트",
		description: "상태 표시줄 오른쪽에 순서대로 표시할 세그먼트 id 목록",
	},
	"statusLine.segmentOptions": {
		label: "상태 표시줄 세그먼트 옵션",
		description: "세그먼트 id별 렌더링 옵션 덮어쓰기(키는 세그먼트 id)",
	},
	"tui.maxInlineImageColumns": {
		label: "인라인 이미지 너비 상한",
		description:
			"인라인 이미지의 최대 너비(터미널 열 수, 기본 100)예요. 0이면 제한하지 않아요(터미널 너비로만 제한).",
	},
	"tui.maxInlineImageRows": {
		label: "인라인 이미지 높이 상한",
		description:
			"인라인 이미지의 최대 높이(터미널 행 수, 기본 20)예요. 0이면 뷰포트 기반 제한(터미널 높이의 60%)만 써요.",
	},
	"tui.maxInlineImages": {
		label: "인라인 이미지 개수 상한",
		description:
			"실시간 터미널 그래픽으로 유지할 인라인 이미지 최대 개수(기본 8)예요. 넘으면 오래된 이미지는 전체 다시 그리기로 텍스트 자리 표시자로 바뀌어요. 0이면 모든 이미지를 유지해요(무제한).",
	},
	// 재시도
	"retry.enabled": { label: "재시도 활성화", description: "API 요청 실패 시 자동 재시도의 전체 스위치" },
	"retry.baseDelayMs": {
		label: "재시도 기본 지연",
		description: "재시도 사이 지수 백오프의 기본 대기 시간(밀리초, 기본 500)",
	},
	// 음성
	"stt.language": { label: "음성 인식 언어", description: "음성-텍스트 변환의 인식 언어 코드(기본 en)" },
	// 압축
	"compaction.reserveTokens": {
		label: "압축 예약 토큰",
		description:
			"압축 후 모델 응답용으로 남겨둘 토큰 수예요. 설정하지 않으면 명시적 선택이 없는 것으로 보고, 작은 창 복구 시 비율 기반 예약을 쓸 수 있어요.",
	},
	"compaction.keepRecentTokens": {
		label: "압축 시 최근 토큰 유지",
		description: "압축 시 그대로 유지할 최근 메시지 토큰 수(기본 20000)",
	},
	"compaction.autoContinue": {
		label: "압축 후 자동 계속",
		description: "자동 압축이 끝나면 현재 턴을 자동으로 이어가요",
	},
	"compaction.remoteEndpoint": {
		label: "원격 압축 엔드포인트",
		description: "원격 압축 서비스의 엔드포인트 URL이에요. 설정하지 않으면 기본 엔드포인트를 써요",
	},
	"compaction.v2RetainedMessageBudget": {
		label: "원격 압축 V2 유지 예산",
		description: "원격 압축 V2에서 그대로 유지할 메시지 토큰 예산(기본 64000)",
	},
	"branchSummary.reserveTokens": {
		label: "브랜치 요약 예약 토큰",
		description: "브랜치 요약 생성용으로 남겨둘 컨텍스트 토큰 수(기본 16384)",
	},
	// 로컬 메모리 파이프라인
	"memories.enabled": {
		label: "로컬 메모리(레거시 스위치)",
		description:
			"레거시 로컬 메모리 스위치로, 하위 호환 마이그레이션용으로만 남아 있어요. 대신 memory.backend를 쓰세요",
	},
	"memories.maxRolloutsPerStartup": {
		label: "시작당 추출 상한",
		description: "한 번 시작할 때 실행할 최대 메모리 추출(rollout) 배치 수(기본 64)",
	},
	"memories.maxRolloutAgeDays": {
		label: "추출 세션 최대 기간",
		description: "메모리 추출에 포함할 세션의 최대 나이(일, 기본 30)",
	},
	"memories.minRolloutIdleHours": {
		label: "추출 세션 유휴 시간",
		description: "세션이 최소 이 시간 동안 유휴 상태여야 메모리 추출에 포함돼요(기본 12)",
	},
	"memories.threadScanLimit": {
		label: "스레드 스캔 상한",
		description: "시작 시 메모리 추출 후보로 스캔할 세션 스레드 수 상한(기본 300)",
	},
	"memories.maxRawMemoriesForGlobal": {
		label: "전역 통합 원시 메모리 상한",
		description: "전역 통합을 시작하기 전 허용하는 원시 메모리 개수 상한(기본 200)",
	},
	"memories.stage1Concurrency": {
		label: "1단계 동시 실행 수",
		description: "1단계(스레드별 추출)의 동시 실행 수(기본 8)",
	},
	"memories.stage1LeaseSeconds": {
		label: "1단계 임대 시간",
		description: "1단계 추출 실행의 임대 시간(초, 기본 120)",
	},
	"memories.stage1RetryDelaySeconds": {
		label: "1단계 재시도 지연",
		description: "1단계 실패 실행의 재시도 지연(초, 기본 120)",
	},
	"memories.phase2LeaseSeconds": {
		label: "2단계 임대 시간",
		description: "2단계(전역 통합) 실행의 임대 시간(초, 기본 180)",
	},
	"memories.phase2RetryDelaySeconds": {
		label: "2단계 재시도 지연",
		description: "2단계 실패 후 재시도 지연(초, 기본 180)",
	},
	"memories.phase2HeartbeatSeconds": {
		label: "2단계 하트비트 간격",
		description: "2단계 실행 중 하트비트 간격(초, 기본 30)",
	},
	"memories.rolloutPayloadPercent": {
		label: "추출 페이로드 컨텍스트 비율",
		description: "추출 배치 하나의 입력이 모델 컨텍스트 창에서 차지할 수 있는 비율(기본 0.7)",
	},
	"memories.phase1InputTokenLimit": {
		label: "1단계 입력 토큰 상한",
		description: "1단계 스레드별 입력 토큰 상한(기본 4000)",
	},
	"memories.fallbackTokenLimit": {
		label: "대체 토큰 상한",
		description: "모델 컨텍스트 창을 알 수 없을 때 쓰는 대체 토큰 상한(기본 16000)",
	},
	"memories.summaryInjectionTokenLimit": {
		label: "메모리 요약 주입 상한",
		description: "세션에 주입할 메모리 요약 토큰 상한(기본 5000)",
	},
	"autolearn.minToolCalls": {
		label: "자동 학습 최소 도구 호출 수",
		description: "세션의 도구 호출이 이 수에 이르러야 자동 학습 정리가 실행돼요(기본 5)",
	},
	// Mnemopi
	"mnemopi.retainEveryNTurns": {
		label: "Mnemopi 보존 간격",
		description: "몇 턴마다 트랜스크립트를 보존할지(기본 4)",
	},
	"mnemopi.recallLimit": {
		label: "Mnemopi 회상 개수 상한",
		description: "회상할 때마다 반환할 메모리 개수 상한(기본 8)",
	},
	"mnemopi.recallContextTurns": {
		label: "Mnemopi 회상 컨텍스트 턴 수",
		description: "회상 쿼리를 만들 때 포함할 최근 턴 수(기본 3)",
	},
	"mnemopi.recallMaxQueryChars": {
		label: "Mnemopi 회상 쿼리 길이 상한",
		description: "회상 쿼리의 최대 문자 수(기본 4000)",
	},
	"mnemopi.injectionTokenLimit": {
		label: "Mnemopi 주입 토큰 상한",
		description: "프롬프트에 주입할 회상 메모리 토큰 상한(기본 5000)",
	},
	"mnemopi.debug": { label: "Mnemopi 디버그 로그", description: "Mnemopi 메모리 백엔드의 디버그 로그를 출력해요" },
	// Hindsight
	"hindsight.bankIdPrefix": {
		label: "Hindsight 메모리 뱅크 ID 접두사",
		description: "자동 생성되는 메모리 뱅크 ID에 이 접두사를 붙여요",
	},
	"hindsight.bankMission": {
		label: "Hindsight 성찰 미션",
		description: "메모리 뱅크를 만들 때 기록할 성찰 미션(reflect mission)으로, 뱅크의 성찰 방향을 이끌어요",
	},
	"hindsight.retainMission": {
		label: "Hindsight 보존 미션",
		description:
			"메모리 뱅크를 만들 때 기록할 보존 미션(retain mission)으로, 트랜스크립트에서 어떤 메모리를 추출할지 이끌어요",
	},
	"hindsight.retainEveryNTurns": {
		label: "Hindsight 보존 간격",
		description: "몇 턴마다 트랜스크립트를 보존할지(기본 3)",
	},
	"hindsight.retainOverlapTurns": {
		label: "Hindsight 보존 겹침 턴 수",
		description: "경계에서 컨텍스트를 잃지 않도록 인접 보존 블록 사이에 겹치는 턴 수(기본 2)",
	},
	"hindsight.retainContext": {
		label: "Hindsight 보존 컨텍스트 태그",
		description: "보존 문서에 붙는 컨텍스트 태그(기본 omp)",
	},
	"hindsight.recallBudget": { label: "Hindsight 회상 예산", description: "회상 깊이 단계: low, mid, high(기본 mid)" },
	"hindsight.recallMaxTokens": {
		label: "Hindsight 회상 토큰 상한",
		description: "주입할 회상 메모리의 최대 토큰 수(기본 1024)",
	},
	"hindsight.recallContextTurns": {
		label: "Hindsight 회상 컨텍스트 턴 수",
		description: "회상 쿼리를 만들 때 포함할 최근 턴 수(기본 1)",
	},
	"hindsight.recallMaxQueryChars": {
		label: "Hindsight 회상 쿼리 길이 상한",
		description: "회상 쿼리의 최대 문자 수(기본 800)",
	},
	"hindsight.recallTypes": {
		label: "Hindsight 회상 유형",
		description: "회상에 참여할 메모리 유형(기본 world와 experience)",
	},
	"hindsight.debug": {
		label: "Hindsight 디버그 로그",
		description: "Hindsight 메모리 백엔드의 디버그 로그를 출력해요",
	},
	"hindsight.requestTimeoutMs": {
		label: "Hindsight 요청 타임아웃",
		description: "Hindsight 일반 요청 타임아웃(밀리초, 기본 30000)",
	},
	"hindsight.reflectTimeoutMs": {
		label: "Hindsight 성찰 타임아웃",
		description: "Hindsight 성찰 요청 타임아웃(밀리초, 기본 120000)",
	},
	"hindsight.recallTimeoutMs": {
		label: "Hindsight 회상 타임아웃",
		description: "Hindsight 회상 요청 타임아웃(밀리초, 기본 30000)",
	},
	"hindsight.retainTimeoutMs": {
		label: "Hindsight 보존 타임아웃",
		description: "Hindsight 보존 요청 타임아웃(밀리초, 기본 60000)",
	},
	"hindsight.mentalModelMaxRenderChars": {
		label: "Hindsight 멘탈 모델 렌더링 상한",
		description: "멘탈 모델을 지시문에 렌더링할 때의 최대 문자 수(기본 16000)",
	},
	// Shell과 도구
	"bashInterceptor.patterns": {
		label: "Bash 가로채기 규칙",
		description: "순서가 있는 bash 가로채기 규칙: 정규식 패턴이 일치하면 해당 전용 도구를 쓰도록 안내해요",
	},
	"shellMinimizer.settingsPath": {
		label: "셸 압축 설정 파일",
		description: "압축기 필드 기본값을 덮어쓰는 선택적 TOML 설정 파일 경로(~ 지원)",
	},
	"shellMinimizer.only": {
		label: "셸 압축 허용 목록",
		description: "이 프로그램 이름(예: git)에만 출력 압축을 적용해요. 비어 있으면 모든 내장 필터를 써요",
	},
	"shellMinimizer.except": { label: "셸 압축 제외 목록", description: "출력 압축을 하지 않을 프로그램 이름" },
	"shellMinimizer.maxCaptureBytes": {
		label: "셸 압축 캡처 상한",
		description: "명령마다 캡처할 최대 바이트 수로, 넘으면 압축하지 않은 원본 출력으로 대체해요(기본 4 MiB)",
	},
	"shellMinimizer.legacyFilters": {
		label: "셸 레거시 필터",
		description:
			"grep/find/pytest의 레거시 필터 동작으로 되돌려요. 설정하지 않으면 OMP_MINIMIZER_LEGACY_FILTERS 환경 변수가 결정해요",
	},
	"async.maxJobs": {
		label: "백그라운드 실행 수 상한",
		description: "동시에 실행되는 백그라운드 실행 최대 수(기본 100)",
	},
	"bash.autoBackground.thresholdMs": {
		label: "자동 백그라운드 임계값",
		description: "bash 명령이 이 밀리초를 넘겨 실행되면 자동으로 백그라운드로 전환해요(기본 60000)",
	},
	"eval.autoBackground.enabled": {
		label: "Eval 자동 백그라운드",
		description: "오래 실행되는 eval 셀을 자동으로 백그라운드로 보내고 완료되면 결과를 전달해요.",
	},
	"eval.autoBackground.thresholdMs": {
		label: "Eval 자동 백그라운드 임계값",
		description: "eval 셀이 이 밀리초를 넘겨 실행되면 자동으로 백그라운드로 전환해요(기본 60000).",
	},
	"eval.autoProvision": {
		label: "Eval 환경 자동 준비",
		description: "처음 설치할 때 관리형 JavaScript eval 패키지 환경을 자동으로 만들어요.",
	},
	// 작업
	"task.disabledAgents": {
		label: "비활성화된 서브에이전트",
		description: "task 도구에서 더 이상 제공하지 않을 비활성화된 서브에이전트 이름 목록(/agents 패널에서 관리)",
	},
	"task.agentModelOverrides": {
		label: "서브에이전트별 모델 덮어쓰기",
		description:
			"서브에이전트 이름과 모델 선택자의 매핑으로 각 에이전트의 기본 모델을 덮어써요(/agents 패널에서 관리)",
	},
	"task.agentPrewalk": {
		label: "서브에이전트별 사전 탐색 덮어쓰기",
		description: "서브에이전트 이름과 prewalk 켜짐 상태의 매핑(/agents 패널에서 P로 전환)",
	},
	// 스킬
	"skills.enabled": { label: "스킬 활성화", description: "스킬 검색과 로딩의 전체 스위치" },
	"skills.enableCodexUser": { label: "Codex 사용자 스킬", description: "~/.codex/skills에서 스킬을 불러와요" },
	"skills.enableClaudeUser": { label: "Claude 사용자 스킬", description: "~/.claude/skills에서 스킬을 불러와요" },
	"skills.enableClaudeProject": { label: "Claude 프로젝트 스킬", description: ".claude/skills에서 스킬을 불러와요" },
	"skills.enablePiUser": { label: "Pi 사용자 스킬", description: "~/.omp/agent/skills에서 스킬을 불러와요" },
	"skills.enablePiProject": { label: "Pi 프로젝트 스킬", description: ".omp/skills에서 스킬을 불러와요" },
	"skills.enableAgentsUser": {
		label: "Agents 사용자 스킬",
		description: "~/.agent/skills와 ~/.agents/skills에서 스킬을 불러와요",
	},
	"skills.enableAgentsProject": {
		label: "Agents 프로젝트 스킬",
		description: ".agent/skills와 .agents/skills에서 스킬을 불러와요",
	},
	"skills.customDirectories": {
		label: "사용자 지정 스킬 폴더",
		description: "스킬을 추가로 스캔할 사용자 지정 폴더 목록이에요",
	},
	"skills.ignoredSkills": { label: "무시할 스킬", description: "이름 glob 패턴으로 무시할 스킬 목록" },
	"skills.includeSkills": {
		label: "포함할 스킬만",
		description: "비어 있지 않으면 이름이 이 glob 패턴과 일치하는 스킬만 불러와요",
	},
	"skills.registryUrl": {
		label: "스킬 레지스트리",
		description: "`omp skill`이 스킬 설치, 검색, 게시에 쓰는 Skillshare 레지스트리예요(https://host[:port]).",
	},
	// SearXNG
	"searxng.token": { label: "SearXNG 액세스 토큰", description: "SearXNG 인스턴스의 액세스 토큰(토큰 인증)" },
	"searxng.basicUsername": {
		label: "SearXNG Basic 사용자 이름",
		description: "SearXNG 인스턴스 HTTP Basic 인증 사용자 이름",
	},
	"searxng.basicPassword": {
		label: "SearXNG Basic 비밀번호",
		description: "SearXNG 인스턴스 HTTP Basic 인증 비밀번호",
	},
	"searxng.categories": {
		label: "SearXNG 카테고리",
		description: "검색을 제한할 카테고리(쉼표 구분, 예: general,news)",
	},
	"searxng.engines": { label: "SearXNG 엔진", description: "사용할 검색 엔진 제한(쉼표 구분)" },
	"searxng.language": { label: "SearXNG 언어", description: "검색 결과 선호 언어 코드" },
	// 커밋
	"commit.mapReduceEnabled": {
		label: "커밋 분석 Map-Reduce",
		description: "큰 diff의 커밋 메시지 생성을 파일별 병렬 분석 후 취합하는 map-reduce 흐름으로 바꿔요",
	},
	"commit.changelogMaxDiffChars": {
		label: "변경 로그 Diff 문자 상한",
		description: "변경 로그 생성 시 모델에 제공할 diff 최대 문자 수(기본 120000)",
	},
	// 개발자
	"dev.autoqaPush.token": { label: "자동 QA 푸시 토큰", description: "자동 QA 보고를 푸시할 때 쓰는 인증 토큰" },
	"dev.autoqaConsent": {
		label: "자동 QA 동의 상태",
		description:
			"자동 도구 문제 보고 공유 동의 여부: unset = 첫 보고 때 물어봐요, granted = 기록하고 (푸시가 설정되면) 전송해요, denied = 조용히 무시해요",
	},
	// 저장소 GC
	"gc.blobs": { label: "GC Blob 정리", description: "`omp gc` 실행 시 더 이상 참조되지 않는 세션 blob을 정리해요" },
	"gc.archive": {
		label: "GC 오래된 세션 보관",
		description: "`omp gc` 실행 시 오랫동안 활동이 없는 세션을 보관함으로 옮겨요",
	},
	"gc.wal": { label: "GC WAL 처리", description: "`omp gc` 실행 시 세션 저장소의 선행 기록 로그(WAL)를 처리해요" },
	"gc.coldArchiveAfterDays": {
		label: "콜드 보관 일수",
		description: "이 일수를 넘겨 활동이 없는 세션만 보관해요(기본 30)",
	},
	"gc.retainNewestGlobal": {
		label: "전역 최신 세션 유지 수",
		description: "오래되어도 항상 유지할 최신 비활성 세션 수(전역, 기본 20)",
	},
	"gc.retainNewestPerCwd": {
		label: "폴더별 최신 세션 유지 수",
		description: "작업 폴더마다 오래되어도 항상 유지할 최신 비활성 세션 수예요(기본 10)",
	},
	"gc.compress": {
		label: "GC 오래된 세션 압축",
		description: "`omp gc` 실행 시 오래된 세션 파일을 파일 시스템의 투명 압축(APFS, NTFS)으로 다시 써요",
	},
	"gc.compressAfterDays": {
		label: "압축 대기 일수",
		description: "이 일수를 넘겨 활동이 없는 세션 파일만 압축해요(기본 7)",
	},
	// 사고 예산
	"thinkingBudgets.minimal": {
		label: "사고 예산(minimal)",
		description: "minimal 사고 수준의 사고 토큰 예산(기본 1024)",
	},
	"thinkingBudgets.low": { label: "사고 예산(low)", description: "low 사고 수준의 사고 토큰 예산(기본 2048)" },
	"thinkingBudgets.medium": {
		label: "사고 예산(medium)",
		description: "medium 사고 수준의 사고 토큰 예산(기본 8192)",
	},
	"thinkingBudgets.high": { label: "사고 예산(high)", description: "high 사고 수준의 사고 토큰 예산(기본 16384)" },
	"thinkingBudgets.xhigh": {
		label: "사고 예산(xhigh)",
		description: "xhigh 사고 수준의 사고 토큰 예산(기본 32768)",
	},
	"thinkingBudgets.max": { label: "사고 예산(max)", description: "max 사고 수준의 사고 토큰 예산(기본 32768)" },
	"display.hideToolActivity": {
		label: "도구 활동 숨기기",
		description: "트랜스크립트에서 모델이 시작한 도구 호출과 결과를 숨겨요",
	},
	externalThinking: {
		label: "외부 사고",
		description: "비공개 think 도구를 쓰고 사고 과정을 GPT Responses 모델에 맡겨요",
	},
	"lsp.shared": {
		label: "공유 언어 서버",
		description:
			"데몬 프록시를 통해 같은 프로젝트의 omp 인스턴스가 언어 서버를 공유해요. 사용할 수 없으면 개별 서버로 대체해요",
	},
	"browser.relay": {
		label: "브라우저 릴레이",
		description:
			"omp 브라우저 릴레이로 내 Chrome 탭을 제어해요. 확장은 한 번만 설치하면 되고(`omp browser-relay install`), 브라우저 도구가 필요할 때 릴레이 서버를 자동으로 시작해요. 브라우저 CDP URL보다 우선하며 PI_BROWSER_RELAY=0 또는 PI_BROWSER_RELAY=1로 덮어쓸 수 있어요.",
	},
	"browser.relayUrl": {
		label: "브라우저 릴레이 URL",
		description: "omp 브라우저 릴레이 엔드포인트(기본 http://127.0.0.1:9224)",
	},
	"providers.webSearchTimeoutSeconds": {
		label: "웹 검색 타임아웃",
		description:
			"프로바이더별 검색 전송 하드 타임아웃이에요. 시간이 지나면 web_search가 다음 대체 항목을 시도해요. 단위는 초(최대 300)",
	},
	"providers.openaiLiveSteering": {
		label: "OpenAI 실시간 추가 지시",
		description:
			"GPT-6 응답이 스트리밍되는 동안 입력한 메시지를 다음 도구 경계까지 기다리지 않고 Codex WebSocket으로 해당 응답에 바로 전달해요.",
	},
	"providers.muse-code.storeResponses": {
		label: "Muse Code 응답 저장",
		description:
			"Muse Code 결과를 Meta 서버에 저장해 연결이 끊긴 턴을 다시 실행하지 않고 복구해요. 저장된 실행은 프롬프트와 출력이 Meta 쪽에 남아요.",
	},
	"providers.cacheWarming": {
		label: "캐시 워밍",
		description: "프롬프트 캐시 항목이 만료되기 직전에 출력 예산 1토큰으로 마지막 요청을 다시 보내요.",
	},
	"searxng.safesearch": { label: "SearXNG 세이프서치" },
	// ── omp 18.2.x 업스트림 신규 설정 ─────────────────────────────────────────────
	"advisor.maxNotesPerUpdate": {
		label: "어드바이저 업데이트당 최대 노트 수",
		description: "Advisor가 한 번 업데이트할 때 쓸 수 있는 노트 상한이에요. 낮을수록 엄격하고 도배를 막아요.",
	},
	"advisor.reviewMode": {
		label: "어드바이저 검토 모드",
		description:
			"WATCHDOG.yml 명단이 없을 때의 기본 어드바이저 주기예요. turn은 모든 주 턴을 검토하고, agent-end는 최종 yield만 검토해요.",
	},
	"advisor.reviewInterval": {
		label: "어드바이저 검토 간격",
		description:
			"WATCHDOG.yml 명단이 없을 때의 기본 어드바이저 주기로, 대상 주 업데이트 N번마다 검토해요. 1 = 매 업데이트. 건너뛴 업데이트는 다음 예정 검토에 함께 보내요.",
	},
	"advisor.evictStaleResults": {
		label: "어드바이저 오래된 결과 제거",
		description: "각 검토 전에 이전 검토의 read/grep/glob 출력을 짧은 자리 표시자로 바꿔요. 최신 검토는 유지해요.",
	},
	"browser.freezeOnTurnEnd": {
		label: "턴 종료 시 브라우저 탭 고정",
		description: "턴이 끝나면 omp가 관리하는 브라우저 탭을 멈춰 백그라운드 탭이 계속 활동하지 않게 해요.",
	},
	"browser.idleCloseSec": {
		label: "브라우저 유휴 종료 타임아웃",
		description: "omp가 띄운 브라우저를 유휴 상태로 얼마나 지나면 닫을지(초)예요. 0이면 닫지 않아요.",
	},
	"browser.tern": {
		label: "Tern 브라우저",
		description:
			"Tern 창 안에서는 헤드리스 Chromium 대신 omp 창 위에 PIP(네이티브 웹 뷰)로 브라우저 탭을 열어요. 띄울 Tern 창이 없으면 Chromium으로 대체해요. 명시적 앱 옵션, 릴레이, Browser CDP URL이 우선하며, headed:false 또는 app.tern:false로 개별 열기를 제외할 수 있어요. PI_BROWSER_TERN=0 또는 PI_BROWSER_TERN=1로 재정의해요.",
	},
	"collab.autoStart": {
		label: "협업 자동 시작",
		description:
			"off는 /collab 실행 시에만 공유해요. view는 자동으로 호스팅하고 레지스트리가 읽기 전용 링크를 배포해요.",
	},
	"compaction.experimentalContextManagement": {
		label: "노트 기반 컨텍스트 창(실험적)",
		description: "실험적 압축 전략으로, 노트로 컨텍스트 창을 지탱해요. 압축과 회상 동작이 달라질 수 있어요.",
	},
	"composer.recallClearedDrafts": {
		label: "지운 초안 불러오기",
		description: "입력창을 지운 뒤에도 기록에서 그 초안을 다시 불러올 수 있어요.",
	},
	"composer.shape": {
		label: "입력창 형태",
		description: "입력 편집기와 상태 줄의 시각적 레이아웃이에요.",
	},
	"composer.tokenRate": {
		label: "생성 속도 표시",
		description: "입력창에 부드럽게 보정한 초당 토큰 생성 속도를 표시하고 턴 사이에도 계속 보여줘요.",
	},
	"display.pinnedAgents": {
		label: "고정 에이전트 목록",
		description: "off는 고정 이동 목록을 숨겨요. collapsed는 몇 줄만 접어서 보여주고 펼치기를 제공해요.",
	},
	"display.showTurnTime": {
		label: "턴 소요 시간 표시",
		description: "어시스턴트 메시지의 사용량 줄에 프롬프트부터 출력까지 걸린 총 시간(도구 호출 포함)을 표시해요.",
	},
	"display.subagentLivePreview": {
		label: "서브에이전트 실시간 미리보기",
		description: "고정된 각 서브에이전트 행 아래에 현재(또는 가장 최근) 도구 호출을 표시해요.",
	},
	"find.enabled": {
		label: "Find(시맨틱 검색)",
		description:
			"시맨틱 프로젝트 검색 도구를 활성화해 에이전트가 자연어로 동작과 심볼을 찾게 해요. 동작 관련 검색은 grep/glob보다 우선해요.",
	},
	"loop.conditionTimeoutMs": {
		label: "루프 조건 타임아웃(밀리초)",
		description: "loop 조건 평가 타임아웃이에요. 0이면 시간 제한이 없어요.",
	},
	"plan.autosave": {
		label: "계획 자동 저장",
		description: "계획 모드가 끝나면 승인된 계획을 디스크에 자동으로 저장해요.",
	},
	"plan.autosaveDir": {
		label: "자동 저장 폴더",
		description: "계획을 자동 저장할 폴더예요. 비워 두면 기본 위치를 써요.",
	},
	"spelling.autocomplete": {
		label: "단어 자동 완성(macOS)",
		description: "macOS 사전 완성을 인라인 힌트로 보여주고 Tab으로 수락해요.",
	},
	"spelling.autocorrect": {
		label: "자동 수정(macOS)",
		description: "완성된 단어에 확실한 macOS 맞춤법 수정을 적용해요.",
	},
	"spelling.typoDetection": {
		label: "오타 감지(macOS)",
		description: "현재 macOS 사전으로 프롬프트의 오타를 표시해요.",
	},
	"statusLine.contextLine": {
		label: "컨텍스트 반응 선",
		description:
			"좌우 세그먼트 사이 구분선이 컨텍스트 사용량을 반영하는 방식이에요(box 입력창 전용). off는 강조색 실선이고, percentage는 사용한 부분만 강조색으로 칠하고 나머지는 흐리게 표시해요.",
	},
	"stream.redactPatterns": {
		label: "추가 가림 패턴",
		description: "라이브 화면 데이터를 내보내기 전에 추가로 일치시킬 가림 패턴이에요.",
	},
	"stream.serverUrl": {
		label: "라이브 서버",
		description: "omp stream이 쓰는 라이브 서버 주소예요.",
	},
	"task.agentServiceTierOverrides": {
		label: "서브에이전트 서비스 등급 덮어쓰기",
		description: "에이전트별로 서비스 등급을 덮어쓰는 키-값 매핑이에요.",
	},
	"task.speculativeLaunch": {
		label: "서브에이전트 선제 실행",
		description:
			"전체 task 호출을 기다리지 않고 tasks[] 항목 스트리밍이 끝나는 즉시 각 배치 서브에이전트를 시작해요. 완료된 호출이 검증에 실패하거나 차단되거나 인수가 바뀌면 시작된 에이전트를 중단해요. task 승인이 자동 허용이어야 하고 확장 도구 수명 주기 핸들러가 없어야 해요.",
	},
	"task.completionProbe": {
		label: "서브에이전트 완료도 확인",
		description:
			"/btw 같은 캐시된 사이드 요청으로 실행 중인 서브에이전트에게 진행률을 추정하게 해요. 2, 5, 10, 30분 뒤에 묻고 이후 매시간 물어요. 추정치는 wait와 task 화면의 서브에이전트 옆에 표시돼요. 대화형 세션의 메인 에이전트가 만든 서브에이전트에만 묻고, print, RPC, ACP, SDK 실행에서는 묻지 않아요.",
	},
	"tools.speculativeExecution.enabled": {
		label: "실험적 추측 실행",
		description: "지연을 줄이기 위해 일반 디스패치 전에 검증된 로컬 읽기 호출을 먼저 실행하도록 허용해요.",
	},
	"tools.speculativeExecution.maxInFlight": {
		label: "추측 실행 동시 실행 수",
		description: "일반 디스패치 전에 병렬로 실행할 수 있는 검증된 로컬 읽기 호출 상한이에요.",
	},
	"tools.artifactMaxBytes": {
		label: "아티팩트 파일 상한(MB)",
		description:
			"스트리밍 도구 출력(bash, python, js eval)을 저장하는 아티팩트 파일의 최대 크기예요. 초과하면 앞부분(최대 3 MB)과 가장 최근 나머지를 남기고 그 사이에 잘림 안내를 넣어요. 0 = 무제한.",
	},
	"tui.mouse": {
		label: "마우스 클릭 포커스",
		description: "마우스 클릭으로 터미널 창에 포커스할 수 있게 해요.",
	},
	"tui.resizeScrollback": {
		label: "스크롤백 재배치",
		description:
			"터미널 크기가 안정된 뒤 스크롤백의 트랜스크립트 줄을 갱신하는 방식이에요. append는 기존 기록 아래에 새 너비로 다시 출력하고, rebuild는 스크롤백을 지운 뒤 현재 너비의 트랜스크립트를 다시 출력해요.",
	},
	"tui.titleSpinner": {
		label: "터미널 제목 스피너",
		description: "터미널 제목에 표시할 작업 중 스피너의 글리프 세트예요.",
	},
	"tui.vimMode": {
		label: "Vim 편집 모드",
		description: "입력창에서 Vim 키 바인딩 편집을 활성화해요.",
	},
	"tui.vimModeDisplay": {
		label: "Vim 모드 표시",
		description: "현재 Vim 모드(예: NORMAL / INSERT)를 표시해요.",
	},
	"input.bareExitOnEmptySession": {
		label: "빈 세션에서 접두사 없이 종료",
		description: "첫 메시지 전에 정확히 `exit`, `quit`, `q`(대소문자 무관)만 입력하면 모델에 묻지 않고 종료해요.",
	},
	"input.bareSlashCommands": {
		label: "접두사 없는 슬래시 명령",
		description:
			"앞의 `/` 없이 명령 이름만 정확히 입력하면(예: `model`, `compact`) 해당 슬래시 명령을 실행해요. 세션에 메시지가 있으면 Enter를 두 번 눌러 확인해요.",
	},
	expandThinkingBlocks: {
		label: "사고 블록 펼치기",
		description: "턴이 끝나도 완료된 사고 블록을 접지 않고 펼친 상태로 유지해요.",
	},
	"claudeResets.autoRedeem": {
		label: "Claude 리셋 자동 사용",
		description:
			"사용 가능한 Claude Cedar 또는 Juniper 리셋을 자동으로 사용해요. Cedar는 적용 대상 한도에만 쓰고, Juniper는 단독 5시간 차단만 복구할 수 있어요. unset은 첫 사용 전에 묻고, yes는 묻지 않고 사용하며, no는 차단 복구와 만료 구제를 꺼요.",
	},
	"claudeResets.minBlockedMinutes": {
		label: "Claude 자동 사용 최소 차단 시간",
		description:
			"자연 해제 시점(소진된 적용 대상 창 중 가장 늦은 리셋)이 최소 이만큼의 분 이상 남았을 때만 자동 사용해요. 5시간 전용 리셋은 주간 또는 모델별 차단에는 절대 쓰지 않아요.",
	},
	"claudeResets.keepCredits": {
		label: "Claude 자동 사용 예비분",
		description:
			"Claude 리셋을 최소 이 개수만큼 남겨 둬요(0이면 마지막 사용 가능한 리셋도 자동으로 써요). 예비분은 만료 구제에도 적용돼요.",
	},
	"claudeResets.salvageHorizonHours": {
		label: "Claude 리셋 구제 기간",
		description:
			"만료까지 이 시간(시간 단위) 이내인 서버 선택 Cedar 리셋을, 적용 대상 창에 복구할 만한 사용량이 있고 조기 사용이 허용되거나 적용 대상 창이 소진된 경우에만 사용해요(0이면 구제 안 함).",
	},
	"telemetry.otlpExportEnabled": {
		label: "OTLP 텔레메트리 내보내기",
		description: "omp가 OTEL_* 엔드포인트로 트레이스, 로그, 메트릭을 내보내도록 허용해요. 다음 실행부터 적용돼요.",
	},
	"ratchet.enabled": {
		label: "Ratchet",
		description: "ratchet eval/hillclimb 프렐류드를 활성화해요. /ratchet으로 현재 세션에서 켤 수 있어요.",
	},
	"archive.enabled": {
		label: "아카이브",
		description: "읽기 전용 archive eval 프렐류드(프롬프트 기록, 최근 프로젝트, 이전 세션과 요약)를 활성화해요.",
	},
	"ida.enabled": {
		label: "IDA Pro",
		description:
			"`read`로 읽은 실행 파일을 IDA Pro(idalib)에서 열고 `ida` 도구를 활성화해요. IDA 설치가 없으면 동작하지 않아요.",
	},
	"ida.python": {
		label: "IDA Python",
		description: "ida_domain과 idapro를 import할 수 있는 Python 인터프리터예요. 비우면 자동 감지해요.",
	},
	"ida.installDir": {
		label: "IDA 설치 폴더",
		description:
			"libidalib가 있는 폴더로, IDADIR로 내보내요. 비우면 자동 감지해요($IDADIR, ida-config.json, 표준 설치 경로).",
	},
	"ida.maxOpen": {
		label: "IDA 최대 열린 데이터베이스",
		description:
			"프로젝트당 동시에 열 수 있는 IDA 데이터베이스(omp ps의 omp.ida.* 데몬) 수예요. 더 열면 가장 오래 사용하지 않은 유휴 데이터베이스를 저장하고 닫아요.",
	},
	"ida.idleCloseSec": {
		label: "IDA 유휴 닫기 시간",
		description:
			"이 초 수보다 오래 유휴 상태인 IDA 데이터베이스를 저장하고 닫아요(0 = 닫지 않음). 다시 열면 exec 네임스페이스가 초기화돼요.",
	},
	"tui.renderSvg": {
		label: "SVG 그림 렌더링",
		description:
			"에이전트가 다이어그램과 차트를 SVG로 그리게 하고, 그래픽을 표시하는 터미널에서는 이미지로 바로 보여줘요",
	},
	"tui.autoGraph": {
		label: "표 자동 차트",
		description: "에이전트 답변의 숫자 표 아래에 테마 색으로 차트를 그려요. 그래픽을 표시하는 터미널에서 동작해요",
	},
	"title.icons": {
		label: "제목 아이콘",
		description: "생성된 세션 제목이 터미널 제목에 짧은 코드와 함께 표시할 아이콘이에요",
	},
	"title.generator": {
		label: "제목 생성 방식",
		description: "제목 없는 세션에 사용자의 메시지를 바탕으로 이름을 붙이는 방식이에요",
	},
};
