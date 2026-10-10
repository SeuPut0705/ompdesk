<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="resources/brand/wordmark-dark.svg">
  <img src="resources/brand/wordmark-light.svg" alt="OMPdesk" height="64">
</picture>

**설치된 omp로 대화하고, 코드를 고치고, 여러 작업을 관리하는 데스크톱 앱이에요.**

<a href="https://github.com/SeuPut0705/ompdesk/releases/latest/download/ompdesk-mac-arm64.dmg"><img src="resources/brand/download-macos.svg" alt="macOS (Apple Silicon) 다운로드" width="280" height="64"></a>
<a href="https://github.com/SeuPut0705/ompdesk/releases/latest/download/ompdesk-windows-setup.exe"><img src="resources/brand/download-windows.svg" alt="Windows 다운로드" width="280" height="64"></a>

<sub>비공개 저장소예요. 초대를 수락하고, 접근 권한이 있는 GitHub 계정으로 로그인해야 다운로드할 수 있어요.</sub>

<br><br>

<img src="https://img.shields.io/badge/omp-18.8.7%2B-5B5BD6?style=flat-square" alt="omp 18.8.7 이상">
<img src="https://img.shields.io/badge/UI-한국어%20%C2%B7%20English-5B5BD6?style=flat-square" alt="한국어 · English UI">
<img src="https://img.shields.io/badge/license-MIT-5B5BD6?style=flat-square" alt="MIT 라이선스">

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/main-dark.png">
  <img src="docs/screenshots/main.png" alt="OMPdesk 대화와 작업 화면 — 라이트 테마" width="100%">
</picture>

<sub>스크린샷은 테스트용 omp와 예제 파일로 촬영했어요. 실제 계정·작업 데이터가 아니에요.</sub>

## OMPdesk는 무엇인가요

[stock omp](https://github.com/can1357/oh-my-pi)를 위한 **비공식 데스크톱 앱**이에요. 컴퓨터에 설치된 omp를 실행하고, RPC와 GUI 확장으로 화면을 연결해요. omp를 앱에 포함하거나 수정·포크하지 않아요.

에이전트 업데이트는 `omp update`, OMPdesk 업데이트는 앱 안에서 따로 받아요. 터미널 omp의 설정·로그인·세션 기록도 함께 사용해요.

읽기 도구의 묶음 표시와 선택자 해석은 설치된 omp의 규칙을 사용해요. 실행 중 토큰 속도도 omp의 실시간 측정값을 표시하며, 문자 수를 토큰 수로 추정하지 않아요. 실행 합계에는 프로바이더가 보고한 출력 토큰만 포함돼요.

스킬·플러그인·에이전트·MCP 목록과 활성화 상태도 설치된 omp의 검색·설정 규칙을 사용해요. 에이전트 파일을 읽거나 저장할 때는 omp의 파서로 검사하고, 편집 시 기존 YAML 주석과 사용자 정의 키는 유지해요. 프로젝트 설정이 스킬을 비활성화하면 전역 설정에서 켜도 프로젝트 설정이 우선해요.

## 필요한 것

- **macOS Apple Silicon**(M1 이상) 또는 **Windows 10/11 x64** 컴퓨터가 필요해요.
- **omp 18.8.7 이상**이 필요해요. omp 설치에는 [Bun](https://bun.sh)이 필요해요.
- 사용할 모델의 프로바이더 로그인 또는 API 키가 필요해요.
- Git 작업에는 Git, GitHub PR 기능에는 [GitHub CLI](https://cli.github.com)(`gh`) 로그인이 필요해요.
- 앱 다운로드·업데이트에는 이 저장소에 접근할 수 있는 GitHub 계정이 필요해요.

## 3단계로 시작하기

### 1. omp 설치하기

이미 설치했다면 `omp --version`으로 버전을 확인하세요.

```bash
bun install -g @oh-my-pi/pi-coding-agent
omp --version
```

18.8.7 미만이면 `omp update`를 실행한 뒤 앱을 다시 켜세요.

### 2. OMPdesk 설치하기

맨 위의 다운로드 버튼을 누르세요. 파일을 못 받으면 GitHub 로그인과 저장소 초대 수락 여부를 확인하세요. [Releases 페이지](https://github.com/SeuPut0705/ompdesk/releases)에서도 받을 수 있어요.

| 운영체제 | 설치 방법 |
|---|---|
| macOS | DMG를 열고 **OMPdesk**를 **응용 프로그램** 폴더로 옮겨 실행하세요. DMG 안에서 계속 실행하지 마세요. |
| Windows | `ompdesk-windows-setup.exe`를 실행하고 설치 안내를 따라가세요. |

첫 실행의 보안 경고는 아래 [문제 해결](#문제-해결)을 참고하세요.

### 3. 모델 연결하고 작업 시작하기

첫 실행 안내를 따라 **설정 › 모델과 계정 › 계정**에서 계정을 연결하거나 API 키를 넣으세요. 터미널 omp에서 이미 로그인했다면 그 계정을 사용할 수 있어요. 프로젝트 폴더를 열고 입력창에 작업을 적어 보내세요.

모델 배치가 고민되면 같은 설정 화면의 **자동으로 구성**을 사용하세요. 제안을 검토하고 **적용**을 눌러야 설정이 바뀌어요.

설정은 **일반 · 화면 및 입력 · 단축키 · 모델과 계정 · 에이전트 동작 · 도구와 확장 · 권한 및 보안 · 프로젝트 및 실행 · 기기 및 연결 · 업데이트 및 정보 · 기타 설정**으로 나뉘어요. 항목마다 편집 위치가 하나이며, 검색은 그 위치로 이동해요. **이 기기**와 **선택한 호스트** 표시는 저장 대상 컴퓨터를 구분해요. 메모리와 압축은 에이전트 동작에서, 실행 프로필은 프로젝트 및 실행에서, 새 omp 버전의 미분류 설정은 기타 설정에서 찾을 수 있어요.

설정의 저장 대상은 섹션 제목 아래 한 번 표시하며, 기기와 호스트 설정이 섞인 섹션만 그룹별로 구분해요. 그룹은 한 단계의 제목과 같은 오른쪽 끝에 정렬된 제어로 표시해요.

## 기능 둘러보기

### 대화와 작업 흐름

- **도구를 쓰는 대화**: 에이전트와 채팅 모두 omp 도구로 파일을 읽고 고치고 명령을 실행해요. 채팅은 프로젝트 대신 앱의 기본 작업 폴더에서 시작해요.
- **단계별 질문**: 질문을 하나씩 답하고 마지막에 함께 제출해요. 답한 단계로 돌아가 수정하거나 숫자 키로 선택할 수 있어요.
- **입력창 위 카드**: 질문, 확인, 도구 승인, 계획 승인이 대화를 가리지 않는 카드로 나와요.
- **대기열 제어**: 작업 중 보낸 메시지를 삭제하거나 지금 전달/다음 턴 전달로 바꿔요. 중지하면 남은 메시지는 초안으로 돌아와요.
- **AUTO 추론**: 직접 지정한 값이 없다면 작업 난이도에 맞춰 추론 강도를 정해요. 모델이 지원하는 최대 단계까지 사용할 수 있고, 사용자 설정이 우선해요.

### 계정과 모델

- **여러 계정**: 프로바이더별 계정과 남은 한도를 확인하고 계정을 추가·제거해요.
- **한도/균등 순환**: 남은 한도를 기준으로 고르거나, 새 세션마다 계정을 고르게 배분해요.
- **모델 구성 도우미**: 선택한 모델로 웹 자료를 조사해 역할별 모델 배치와 어드바이저 사용을 제안해요. 이유·출처를 보고 수정한 뒤 적용해요. 조사에는 모델 사용량이 들어요.
- **사용자 지정 프로바이더**: 설치된 omp에서 프로토콜·인증·탐색·추론 옵션을 가져오고, `models.yml` 저장 전에 stock `ModelsConfigSchema`로 검증·정규화해요. YAML 주석은 유지하며, stock 프로바이더 목록을 확인할 수 없으면 추가·삭제를 거절해요.
- **초기화권(리셋 패스)**: 지원 계정의 남은 초기화권과 만료 정보를 보고, stock omp가 수동 사용을 허용하면 확인 후 초기화를 요청해요. Codex는 한도 소진 전에도 요청할 수 있으며 실제 적용 가능 여부는 제공자가 판단해요. 모든 프로바이더나 계정에서 제공되는 기능은 아니에요.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/models-dark.png">
  <img src="docs/screenshots/models.png" alt="모델 및 프로바이더 설정의 계정·순환 방식" width="100%">
</picture>

### 파일과 병렬 작업

- **파일 뷰어**: 코드, Markdown·HTML, PDF, 이미지·미디어, CSV·JSON, Jupyter 노트북을 사이드 패널에서 열어요.
- **Office 미리보기**: `.docx`, `.xlsx`, `.pptx`를 읽어요. PowerPoint는 내용·이미지·노트 중심의 간단 미리보기이고, 예전 `.doc`·`.xls`·`.ppt` 형식은 기본 앱으로 열어요.
- **독립된 탭과 분할 화면**: 여러 세션을 열고 나란히 비교해요. Git 워크트리 탭은 stock omp의 `worktree.base` / `OMP_WORKTREE_DIR` 설정을 따르는 별도 작업 폴더에서 실행해요. 삭제는 현재 워크트리 루트 안에 Git이 등록한 연결 워크트리만 허용하고 브랜치는 남겨 둬요.
- **변경 사항과 PR**: 파일 diff를 검토하고 GitHub PR을 조회·생성·체크아웃해요. PR 체크아웃은 stock omp가 실행하며 `pr_push`에 필요한 브랜치 메타데이터도 기록해요.
- **집중된 사이드 패널**: 제목 메뉴에서 변경 사항·파일·로그·대기열·트리·백그라운드를 전환해요. 변경 사항은 파일별 추가·삭제 줄 수를 표시하고, 패널을 넓히면 파일 목록과 diff를 나란히 보여줘요.
- **세션 기록과 분기**: stock omp의 전체 기록을 표시하므로 압축 전 대화도 볼 수 있어요. 트리에서 분기를 바꾸거나 특정 지점까지 새 세션으로 복사해요. 복사는 첨부 아티팩트·레이블·제목을 함께 보존하며 현재 세션은 바꾸지 않아요.
- **원격 기기**: 연결한 컴퓨터의 omp·파일·Git·계정으로 작업해요. 원격 탭의 모델·프로바이더 설정도 그 컴퓨터 기준이에요.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/files-dark.png">
  <img src="docs/screenshots/files.png" alt="사이드 패널의 Office 문서 미리보기" width="100%">
</picture>

## 업데이트하기

### OMPdesk 업데이트

앱 메뉴의 **업데이트 확인…** 또는 **설정 › 업데이트 및 정보**를 사용하세요. 새 버전을 받고 앱의 설치·재시작 안내를 따라가면 돼요. macOS는 앱을 응용 프로그램처럼 쓰기 가능한 위치에 설치해 두세요.

비공개 릴리스에 접근하려면 다음 중 하나를 설정하세요.

- **GitHub CLI**: 터미널에서 `gh auth login`을 실행하세요. 앱이 그 계정의 토큰을 사용해요.
- **토큰**: [GitHub 토큰](https://github.com/settings/tokens)을 **설정 › 업데이트 및 정보 › GitHub 접근**에 저장하세요. classic 토큰은 `repo`, fine-grained 토큰은 이 저장소의 **Contents 읽기** 권한이 필요해요. 저장한 토큰은 OS의 안전한 저장 기능으로 암호화해 보관해요.
- **환경 변수**: `GH_TOKEN` 또는 `GITHUB_TOKEN`도 지원해요. 환경 변수 → `gh` 로그인 → 앱에 저장한 토큰 순으로 사용해요.

**접근 확인**으로 권한을 점검할 수 있어요. 브라우저에 로그인한 것만으로 앱 업데이트 인증이 설정되지는 않아요.

### omp 업데이트

```bash
omp update
```

앱과 별개로 설치된 에이전트를 업데이트해요. 업데이트 후 OMPdesk를 다시 켜세요.

## 원격 기기 연결하기

1. 양쪽 컴퓨터에 OMPdesk와 omp를 설치하세요. **작업을 실행할 컴퓨터**에서 **설정 › 기기 및 연결 › OMPdesk 공유 › 다른 기기에서 이 컴퓨터 사용 허용**을 켜세요.
2. 표시되는 연결 코드(`XXXX-XXXX`)를 확인하세요. 코드는 **10분 동안 유효하고 한 번만 사용**할 수 있어요.
3. **지금 사용하는 컴퓨터**에서 **설정 › 기기 및 연결 › OMPdesk 공유 › 기기 연결**을 누르세요. 같은 네트워크의 기기를 선택하거나 주소를 직접 입력하고 코드를 넣으세요. Tailscale 같은 네트워크에서는 직접 주소를 입력할 수 있어요.
4. 사이드바에서 연결한 기기의 프로젝트·세션을 열어 작업하세요. 사용하지 않을 기기는 설정에서 연결을 해제할 수 있어요.

연결은 기기별 키로 인증·암호화해요. 자동 탐색이 안 되면 호스트 주소와 네트워크·방화벽 설정을 확인하세요. 원격 기기는 작업 중 켜져 있고 서로 연결 가능한 상태여야 해요.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/remote-dark.png">
  <img src="docs/screenshots/remote.png" alt="원격 기기 설정과 일회용 연결 코드" width="100%">
</picture>

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 다운로드 링크가 404예요 | 저장소 초대를 수락하고, 접근 권한이 있는 GitHub 계정으로 로그인했는지 확인하세요. |
| macOS에서 개발자 확인 경고가 나와요 | 현재 빌드는 Apple 공증을 받지 않았어요. 출처를 확인한 뒤 Finder에서 앱을 **우클릭 → 열기**로 실행하세요. 시스템이 계속 차단하면 **시스템 설정 › 개인정보 보호 및 보안**의 실행 허용 안내를 확인하세요. |
| Windows SmartScreen이 막아요 | 출처를 확인한 뒤 **추가 정보 → 실행**을 선택하세요. 조직의 보안 정책으로 차단된다면 관리자에게 문의하세요. |
| omp를 찾을 수 없어요 | 터미널에서 `omp --version`을 확인하세요. 동작하지 않으면 위 설치 명령을 실행하세요. 별도 경로에 설치했다면 앱을 실행할 때 `OMP_GUI_OMP` 환경 변수에 실행 파일 경로를 지정할 수 있어요. |
| omp 버전이 너무 낮아요 | 최소 **18.8.7**이 필요해요. `omp update` 후 앱을 다시 켜세요. |
| 앱 업데이트에 로그인이 필요해요 | `gh auth status` 또는 설정의 **GitHub 접근 › 접근 확인**으로 확인하세요. 저장소 권한도 필요해요. |
| PR 기능이 동작하지 않아요 | Git 저장소를 열었는지, GitHub CLI가 설치됐는지, `gh auth status`가 로그인 상태인지 확인하세요. |

## 데이터와 개인정보

- 앱 설정과 omp의 설정·계정·세션 데이터는 실행하는 컴퓨터에 보관돼요. 원격 탭의 작업 데이터는 작업을 실행하는 호스트에 있어요.
- OMPdesk 자체의 별도 분석 수집 SDK는 없어요. 다만 stock omp의 **OTLP 텔레메트리 내보내기** 설정을 켜면 omp가 사용자가 지정한 `OTEL_*` 엔드포인트로 트레이스·로그·메트릭을 보낼 수 있어요.
- **완전한 오프라인 앱은 아니에요.** 모델 요청은 사용자가 연결한 프로바이더로 전송돼요. 웹 검색, 로그인, GitHub PR·업데이트, 원격 기기 연결에도 네트워크를 사용해요. 세션 공유에서 업로드를 선택하면 외부 공유 서비스로 전송돼요. 데이터 처리는 해당 서비스와 omp의 설정·정책을 확인하세요.
- 앱 업데이트용 GitHub 토큰은 사용자별로 설정해요. 앱에 배포용 토큰을 포함하지 않아요.

## 소스에서 실행하기

저장소 접근 권한, Bun, Git, omp 18.8.7 이상이 필요해요.

```bash
git clone https://github.com/SeuPut0705/ompdesk.git
cd ompdesk
bun install
bun run dev
```

개발·검사·패키징 규칙은 [AGENTS.md](AGENTS.md), 변경 내역은 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

## 라이선스와 크레딧

[MIT 라이선스](LICENSE)로 배포해요. [nornzach/oh-my-pi-gui](https://github.com/nornzach/oh-my-pi-gui)(MIT)에서 출발했고, [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)의 stock omp 위에서 동작해요. OMPdesk는 omp의 공식 앱이 아니에요.
