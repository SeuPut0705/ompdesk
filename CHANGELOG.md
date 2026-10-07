# Changelog

## [0.4.1] - 2026-10-07

- **작업 중 채팅 아래에 빈 공간이 생기던 문제 수정**: 긴 작업이 이어지면 실행 중인 작업 요약 아래로 내용 없는 빈 공간이 점점 커지고 "최신으로 이동"이 뜨던 문제를 고쳤어요. 작업 미리보기 창 안의 화면 낭독용 숨은 글자(수정한 줄 수 등)가 창 밖으로 새어 나와 채팅 높이를 늘리고 있었어요.

## [0.4.0] - 2026-10-07

- **서브에이전트를 사이드바에서**: 서브에이전트를 쓰는 세션 아래에 서브에이전트 목록이 붙어요. 실행 중이면 도는 아이콘과 경과 시간, 끝나면 체크, 실패하면 빨간 표시가 보이고, 서브에이전트가 띄운 서브에이전트는 한 단계 더 들여써져요. 누르면 그 서브에이전트가 하는 일을 실시간 기록으로 볼 수 있고, 우클릭으로 중지할 수 있어요. 실행 중일 땐 자동으로 펼쳐지고, 끝난 게 많으면 "완료 N"으로 접혀요.
- **입력창 위 서브에이전트 표시 축소**: 한 줄 요약(실행 중·완료 개수와 최근 작업)만 남기고, 실행 중인 게 없으면 사라져요. 누르면 사이드바의 해당 목록으로 이동해요.
- **할 일 카드가 사라지지 않던 문제 수정**: 모든 할 일이 끝나면 그 턴이 끝날 때 카드가 사라지고, 새로 열린 할 일이 생기면 다시 나타나요. 세션을 바꾸거나 다시 열어도 끝난 목록이 되살아나지 않아요.
- **같은 프로젝트가 사이드바에 두 번 나오던 문제 수정**: 같은 폴더를 다른 경로 표기(심볼릭 링크 등)로 열면 프로젝트 그룹이 둘로 갈라지던 문제를 고쳤어요.
- **입력창 주변 다듬기**: 대기 중인 메시지 목록이 입력창과 한 덩어리로 붙고, 실행 설정·모드·컨텍스트 팝오버와 모델 선택 창의 정리와 한국어 줄바꿈을 손봤어요. 팝오버가 내용이 늘어나도 창 밖으로 넘치지 않아요.
- **채팅 화면 다듬기**: 토큰 표시를 "약 8 토큰 · 4.7/초", "8.5k 토큰 · 평균 63/초"처럼 읽기 쉽게 바꿨어요. 작업 미리보기 창은 위에서부터 채워지고, 명령 실행 결과는 하나의 터미널 블록으로 보여요. 대화 사이 간격과 새 세션 시작 화면도 정리했어요.
- **설정·에이전트·통계 정리**: 설정 › 일반에서 "자동 압축"이 엉뚱한 제목 아래 있던 걸 "긴 세션"으로 옮기고, 해당 항목이 없는 빈 섹션은 숨겨요. 서브에이전트가 없을 땐 "모든 에이전트 일시정지" 버튼을 숨겨요. 통계 서버를 쓸 수 없을 때 영어 오류 대신 차분한 안내와 다시 시도 버튼을 보여 줘요. ⌘K 팔레트는 검색어와 맞는 부분을 강조해요.
- **오류 표시 정리**: 영어 원문 오류가 그대로 뜨던 곳을 한국어 제목으로 바꾸고, 원문은 작은 글씨로만 남겼어요. 업데이트 실패 안내는 빨간 줄 대신 차분한 알림으로 바뀌었어요. 사이드 패널 탭과 세션 우클릭 메뉴도 묶음별로 정리했어요.
- **응답 중 위로 스크롤하면 맨 아래로 끌려가던 문제 수정**: 응답이 흘러나오는 동안 지난 내용을 보려고 위로 올리면 한 번 맨 아래로 튕겨 내려가던 문제를 고쳤어요. 대화 탐색 막대로 이동한 직후 스크롤해도 다시 끌려가지 않아요.

## [0.3.0] - 2026-10-07

- **Claude·Codex 방식 업데이트**: 새 버전을 찾으면 백그라운드에서 받아 검증해 두고, 준비되면 사이드바 아래쪽에 작은 업데이트 카드가 떠요. "재시작해서 업데이트"를 누르면 몇 초 만에 새 버전으로 다시 열리고, 그냥 앱을 꺼도 다음 실행부터 새 버전이에요. 설치 파일을 열어 앱을 직접 바꿔 넣을 필요가 없어요(앱이 쓰기 가능한 위치에 있을 때. 디스크 이미지에서 바로 실행 중이면 카드에서 설치 파일을 받아 열어요). 실행 중인 작업이 있으면 재시작 전에 한 번 물어봐요. "나중에"로 그 버전 카드를 숨길 수 있고, 업데이트 실패만 위쪽 배너에 남아요.
- **작업 창 깜빡임 수정**: 여러 단계로 나뉜 작업이 진행될 때 단계마다 작업 요약과 미리보기 창이 새로 생겼다 사라지며 깜빡이던 문제를 고쳤어요. 한 턴의 작업은 끝날 때까지 하나의 요약과 하나의 미리보기 창에서 이어져요.
- 이번 업데이트는 한 번만 예전 방식(설치 파일)으로 받아야 해요. 그다음 버전부터 카드에서 재시작만 하면 돼요.

## [0.2.1] - 2026-10-07

- 실행 중인 작업 아래의 미리보기가 높이가 고정된 작은 창으로 바뀌었어요. 단계, 명령 출력, 생각 내용이 로그처럼 아래로 쌓이고 위로 스크롤해서 지난 내용을 볼 수 있어서, 내용이 바뀌어도 채팅 화면이 위아래로 흔들리지 않아요.
- 전송 버튼을 눌러 보낸 뒤에도 입력창에 포커스가 남아서, 바로 이어서 입력하거나 ⌘, 같은 단축키를 쓸 수 있어요.

## [0.2.0] - 2026-10-07

**ompdesk의 첫 공개 릴리스예요.** 설치된 omp를 그대로 쓰는 비공식 데스크톱 앱이에요(0.1.0은 출시하지 않고 건너뛰었어요).

- **이름과 데이터**: 앱 이름이 seucode에서 ompdesk로 바뀌었고, 첫 실행 때 이전 설정 폴더를 자동으로 옮겨요.
- **사이드바 중심 탐색**: 상단 탭 줄 대신 사이드바에서 세션을 열고 전환해요(⌃⇥로 순환). 코드/업무 전환 토글, 프로젝트 폴더 열기·만들기 버튼, 저절로 접히지 않는 사이드바(최소 220px).
- **채팅 화면**: 실행 중인 단계를 접힌 상태로도 보여 주고, 토큰 사용량과 속도(↓ 12.4k · 86 tok/s)를 작게 표시해요. 응답을 기다릴 땐 마지막 작업 줄의 도는 아이콘만 남겨요.
- **입력창**: 다음 프롬프트 제안을 회색 글자로 보여 주고 Tab이나 →로 받아요. 대기 중인 메시지는 입력창 위 한곳에서 편집·이동·삭제해요. 에이전트 질문은 화면을 가리지 않는 카드로 떠요.
- **할 일·서브에이전트 카드**: 접힌 채로 진행률과 현재 항목을 한 줄로 보여 줘요. 카드가 생겨도 자동 스크롤이 풀리지 않아요.
- **그 밖에**: "인사이트"를 "통계"로 바꾸고, 제목 표시줄·설정·통계·⌘K 팔레트·알림의 디자인을 다듬었어요. 모델 풀, 에이전트 편집기, 한국어 UI 등 아래의 전체 목록을 참고하세요.

Developed as seucode (formerly omp GUI) and shipped as its own project, an unofficial desktop app for omp. Derived from [nornzach/oh-my-pi-gui](https://github.com/nornzach/oh-my-pi-gui) 0.9.16 (MIT); rebuilt to run on the user's stock omp instead of a bundled fork.

### Identity

- New name and mark: the app is **ompdesk** (bundle id `com.seuput.ompdesk`, installers `ompdesk-<version>-…`, stable download names `ompdesk-mac-arm64.dmg`, `ompdesk-windows-setup.exe`, `ompdesk-windows-portable.exe`). The agent it drives is still omp. One mark, an interlaced knot (two congruent strands, you and the agent, woven into an S), renders the app icon (platinum and gold on an ink tile), the menu-bar/tray icon and the in-app logo (ink and the theme accent); 48px and smaller use a simplified, heavier knot.
- Renamed from seucode, its pre-release name, to ompdesk: app and bundle names, installers, the wordmark, the release repository (`SeuPut0705/ompdesk`) and every in-app mention. The first ompdesk launch moves a pre-release profile (`~/Library/Application Support/seucode`, `%APPDATA%\seucode`) into the new data directory, so window layout and GUI preferences carry over (skipped when `--user-data-dir` is given). On macOS a GitHub token saved in Settings › Updates has to be pasted again (its keychain key follows the app name), and model pools set in pre-release sessions are not read back.
- The app's data directory follows the new name (`~/Library/Application Support/ompdesk`, `%APPDATA%\ompdesk`), so window layout and GUI preferences from omp GUI start fresh; omp's own settings, logins and sessions in `~/.omp` are unaffected.

### Runtime

- Drives the **system-installed omp** (`omp --mode rpc-ui`); `omp update` updates the agent the GUI uses. Requires omp **18.6.0** or newer; a missing or outdated omp shows an install/update hint.
- GUI features stock omp's RPC does not cover run in the Electron main process (git/gh, files, `~/.omp` config, `omp` CLI) or through `gui-bridge`, an omp extension the GUI loads with `-e` for live-session state. No omp fork, no bundled agent binary.
- Stats run the user's omp-stats server without opening a browser and add the paginated request list the Requests page needs.
- macOS on Apple Silicon and Windows only; Intel Macs and Linux are not supported.
- Distributed privately: releases live in the private `SeuPut0705/ompdesk` repository for invited collaborators. In-app updates (Settings › Updates) authenticate as the user — `GH_TOKEN`/`GITHUB_TOKEN`, then the GitHub CLI login (`gh auth token`), then a token pasted in Settings › Updates › GitHub access (encrypted on the device with the OS keychain, with Test access and Remove) — never a bundled token. Update checks, `latest*.yml` reads and installer downloads (the macOS DMG through the authenticated GitHub API asset endpoint, still SHA-512 verified) all carry it. No token or no access shows a localized "sign in with gh or paste a token" state instead of a raw 404, and never a banner from the background check.
- Releases are built by CI: pushing a version bump to `main` with a dated changelog section runs the checks, the macOS e2e suite and the Windows smoke tests, packages macOS and Windows, and publishes the tagged release only if all of it passed.

### Added

- Korean UI: renderer, settings, menus, tray, dialogs. The language switcher cycles EN → 中文 → 한국어; with no saved choice the UI follows the OS locale.
- **Model pool** (composer mode chip › Model pool): pick several models from your connected providers, give each a role hint (fast exploration, hard reasoning, writing code, review, or your own words) and switch the pool on for the session. The main agent then splits each request into independent subtasks, runs them in parallel on the best-fitting pool models through the task tool's per-item model selector, and integrates and cross-checks the results, preferably with a different pool model. The pool is stored in the session itself, so it survives tab switches, restarts and resume; pools save as presets for reuse. A chip shows while it is on, Agents › Live labels each subagent with its pool model and role, and Insights › This session adds a usage-by-model split. Each model added to a pool gets one 16-token test request (the first-run "Test connection" bench), and a model your account can't serve (e.g. a provider 404) is flagged with the provider's error and a "Check again" button; if a pool model still fails mid-request, the main agent reassigns that subtask to another pool model and tells you which one failed. Works with stock omp: the GUI bridge appends the orchestration instruction through omp's `before_agent_start` extension hook; no agent files are written.
- **Agent editor and templates** (Agents › Definitions): create, edit, duplicate and delete omp task agents without touching files. **New agent** opens an editor with a field for every frontmatter key omp reads — name (checked against omp's reserved `main`/`sub`, the folder's existing files and first-wins precedence, with a note when the name overrides a bundled, user or plugin agent or is shadowed by a project one), description, instructions in a markdown editor, tools picked from omp's own tool list with a read-only preset, which agents it may start, an ordered model list of roles (`@slow`, with what each resolves to) and models, thinking level, prewalk, advisor, blocking, summarized reads, skills to preload and a validated JSON output schema — and saves to *All projects* (`~/.omp/agent/agents`) or *This project* (`.omp/agents`), showing the exact file path. Saving edits the file in place, keeping unknown frontmatter keys, comments and key spellings; writes are atomic, never replace another agent's file and refuse paths outside the two agent folders. Each row's menu edits, duplicates (a bundled or plugin agent becomes an overriding copy under the same name), opens the file in your editor, shows it in its folder or deletes it. **Templates** offers 12 ready specialists (frontend, backend/API, test writer, refactorer, debugger, docs writer, deep code reviewer, performance, migration/upgrade, UI/UX polish, database/SQL, DevOps/CI) with Korean, English and Chinese descriptions and recommended tools, model roles and thinking level: customize one before adding it, or add every one that isn't installed yet.
- Composer redesign: one calm field with a single toolbar at every width — a **+** menu (attach images, prompt history ⌃R, expand ⌃G), a **mode chip** (Plan · Goal · Loop · Vibe with inline config in one popover; replaces the Modes window), **Run settings** (thinking level, fast mode, tool approval and the advanced behavior toggles in one popover), the model chip showing the model's display name, a context ring with the share used, and send / stop. ⌃G now expands the composer in place over the session instead of opening a full-screen editor dialog (external-editor round-trip kept). Image files can be dropped on the composer. The field has an accessible name and new or empty sessions focus it.
- Queued messages live in one place: a tray attached to the top of the composer lists every queued steer and follow-up, with edit in place (Enter saves, Esc cancels), send a follow-up now as a steer (or hold a steer until the turn ends), remove and clear all. The transcript no longer repeats them as dashed bubbles and the dock no longer shows a separate queue chip. While a turn runs with nothing typed, Stop takes the Send button's place; a next-prompt suggestion shows a **Tab** chip; the composer's focus ring follows the text field only; toolbar labels collapse to icons at narrow widths instead of overflowing. Collapsed todo and subagent cards above the composer are one line (progress bar, count, current item) and span the composer's full width. The docked `ask` card uses real radio/checkbox semantics with arrow-key navigation, a Recommended badge and theme-aware colors.
- omp compatibility self-check: when a sidecar's `gui-bridge` connects, the GUI asks once per omp version which bridge features this omp's internals can no longer serve (plan mode, MCP, settings, …) and shows a dismissible warning naming them, with an `omp update` / report-an-issue hint. A bridge that fails to connect at all gets the same warning instead of only a log line. The affected commands fail with a coded `unsupported_omp` (or `bridge_unavailable`) error naming the feature instead of a raw TypeError, and one broken bridge module no longer takes the others down.
- Transcript redesign: the answer reads at body size, your prompt is a compact bubble whose actions appear on hover without reserving space, and finished work collapses into a plain summary ("Read 2 files · Edited 1 file · Ran 1 command · 16s"). Each step shows a human label, the file name first, and a `+N −M` diff stat for edits; thinking is one quiet row. Failed responses say what happened in your language with Try again / Change model / Open providers / Compact context; a stopped response is a neutral "Stopped" note, and slow or retrying waits offer Change model and Stop response.
- First run is an inline setup in the empty session instead of a dialog: pick a provider (search, recommended first), sign in or paste an API key right in the list (the key field is masked), or add an OpenAI/Anthropic-compatible endpoint with an inline form; then choose the default model, optionally verified with one short test request. "Set up later" leaves it for Settings › Models & providers.
- Providers & login moved to Settings › Models & providers (`/providers`, `/login`, `/logout`, `/add-provider` and the menu open it): one searchable list with connected providers first, a short recommended set, and the long tail collapsed; "Connect" is a quiet row action instead of 80 primary buttons. Custom endpoints are added and edited inline (no stacked dialogs), with human protocol names and the rarely used options under "Advanced".
- Model picker: connected providers first with their display names, each model's context window (small ones flagged), and a link to manage providers. The pick also becomes the default for new sessions, as omp's own `/model` picker does.
- Command palette (⌘K): sections follow the app's layout (Session, Agents, Insights, Models, … Settings, Help) with one icon per section, shortcuts shown for the platform, and a key hint footer. Search ranks exact, then prefix, then word-start, then substring matches, understands Korean typed mid-syllable or as initial consonants ("트리", "틀", "ㅌㄹ" all find 세션 트리), and lifts recently used commands. Enter never runs a turn-starting or destructive command (retry, resend, clear, delete, compact, quit, a slash command sent to the agent, …) off a partial match: it asks for a second Enter unless the query names the command exactly or you picked it with the arrow keys.
- One name per concept across English, Korean and Chinese (session, project, side panel, command palette, plan mode, steer, follow-up, subagent, background job, Insights, …), sentence-case labels without baked-in shortcuts, and error messages that say what to do next. Korean messages use 해요체; leftover English in Korean and Chinese is translated.
- Next-prompt suggestions from the `next-prompt` omp extension show as gray placeholder text in the empty composer; Tab takes it, typing dismisses it. Previously the widget floated as a panel over the composer and Tab did nothing (the extension listens for terminal input, which never reaches it over RPC).
- The sidebar never folds on its own: it keeps its width (minimum 220px, drag-resizable up to 420px) at every window size and only hides when you collapse it. The icon rail and the narrow-window sidebar sheet are gone; below 1000px only the side panel becomes a sheet.
- Code / Work is a segmented toggle at the top of the sidebar instead of two items at the bottom of the project menu.
- The todo and subagent cards above the composer start collapsed and show a one-line glance: todo progress (a thin bar and done/total) with the task in progress (or the next one), and subagent counts (running · done · failed) with the most recently active agent. Click the card header to expand it as before.
- A folder button next to **New session** opens the native folder picker (with its New Folder button) to open or create a project folder and start a session there.
- Waiting on the model no longer prints a "Waiting for model response… Ns · Esc to stop" line: the turn's last work row keeps its spinner (reading "Working · N steps" between steps), or a bare spinner stands where the reply will appear. Past 30s the slow/stalled hints and recovery buttons still show.

### Fixed

- New sessions could start on Apple's on-device model (8k context) even with a configured provider, and the model changed between launches: with no saved default, omp prefers a known provider's catalog default and Apple only becomes available once its discovery is cached (launch 2+). The GUI now saves the default model (from first-run setup and the model picker) and, when none is saved, starts on a connected model that can hold a coding session, never a keyless or too-small one.
- Windows: omp installed under a path with a space (e.g. `C:\Users\First Last\…\omp.cmd`) failed to launch; the shim path is now quoted for every omp spawn.
- With no provider credentials (and no on-device model), stock omp exits at startup ("No models available" on 18.6, "No default model selected" on 18.7), so the GUI crash-looped and the first-run onboarding that connects a provider never opened. The GUI now boots omp once on a model from the installed omp's own catalog so onboarding appears; it recognizes both messages and the API-key hint stock prints under them.
- Windows: new tab, chat tab, and close tab had no working shortcut (their defaults were ⌘-only). Every ⌘ shortcut now uses Ctrl on Windows (new tab Ctrl+T, chat tab Ctrl+Shift+T, close tab Ctrl+W; thinking toggle moves to Ctrl+Alt+T there), and shortcut labels show Windows key names.
- Opening a tab or switching to a session hydrated the transcript up to three times concurrently; it now loads once per tab and session.
- Opening a session with a long history re-fetched and re-projected the whole history for every transcript page.
- A packaged app ignored the project folder passed on the command line.
- A missing or too-old omp left the window at "Connecting…" with no explanation; the reason and the install/update command now show in the UI language.
- "Remove global override" in settings failed for settings without a default.
- Typed GUI commands stock omp does not advertise (`/plan`, `/loop`, `/goal`, `/vibe`, `/tan`, `/omfg`, `/pause`, `/settings`, …) were sent to the model as text, and slash completion offered a skill instead (`/plan` + Enter → `/skill:…-plan`). They are now listed in completion and run natively; completion ranks exact, then prefix, then substring matches.
- At the minimum window width with 200% zoom (400 CSS px), the session sidebar left the conversation too narrow and the composer's Send button was laid out off-screen. The sidebar now takes at most 40% of a narrow window and the composer toolbar wraps, keeping Send on its own row.
- A transcript following a streaming reply could paint newly streamed text below the fold for a frame or more on a slow renderer before scrolling to it; the follower now pins in the same frame the row is measured.
- A transcript following a run left its newest lines hidden whenever the layout around it took height — a todo or subagent card appearing or expanding above the composer, or the composer growing — until more text happened to arrive. A view that was following the tail now re-pins to the bottom after any such resize; only scrolling away yourself stops following.
- With omp 18.6.3, opening a session whose saved model is unavailable still failed after choosing a replacement model in the restore prompt: the GUI switched first and set the model afterwards, but omp now refuses that switch. The chosen model is now passed with the switch (older omp still gets it set afterwards).
- Stats could show "Stats unavailable — This operation was aborted" right after opening on a slow machine (seen on Windows): the GUI gave each stats request 5 s, no more than the stats server's own database lock wait. Requests now get 15 s.
- Windows: a setting changed in the GUI could silently snap back to its previous value right after another setting was saved: omp's save took its own just-written config.yml for an external edit and dropped the change. The GUI now checks that the change was kept and applies it once more if not.
- Startup parsed about 11 MB of JavaScript, including all of mermaid, because the bundler had placed its dynamic-import helper in the mermaid chunk. Mermaid, KaTeX (and its stylesheet), the raw-HTML markdown step, CodeMirror and the todo list's drag-and-drop now load the first time they are needed; startup loads about 3.2 MB. Content that needs one of them shows plain text (TeX source, no embedded HTML, a spinner in the editor) for the moment the chunk takes to load.

### Removed or narrowed compared to the fork-based GUI

- Live session sharing (collab host/join/leave) from the GUI. `omp` in a terminal still offers it.
- Re-answering a past `ask` from the session tree.
- Reordering queued messages within a lane. Editing a queued message or moving a steer to follow-up re-queues it at the lane's end, text only.
- Job result previews in the jobs dialog; the shake summary arrives as command output; share uploads are not trimmed before upload.
- `abort_subagent` cancels only running subagents stock omp lists for the session.
