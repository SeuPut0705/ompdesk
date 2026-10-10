# Changelog

## [0.19.0] - 2026-10-10

- **omp 18.8.7 이상이 필요해요**: OMPdesk가 직접 흉내 내던 기능을 omp 자체 구현으로 바꾸면서 최소 버전을 올렸어요. 그보다 낮으면 `omp update` 후 앱을 다시 켜 주세요.
- **오른쪽 사이드 패널을 Claude 앱처럼 정리**: "사이드 패널" 제목 줄과 탭 두 줄 대신 보기 전환 메뉴와 동작 버튼이 있는 헤더 한 줄이에요.
  - 변경 사항: 파일마다 아이콘·상태·`+n −n` 줄 수가 보여요. diff는 줄바꿈된 깔끔한 화면에 이전/다음 파일 이동이 있고, 패널을 넓히면 목록과 diff가 나란히 보여요.
  - 파일·로그·대기열·트리·백그라운드 화면도 같은 모양으로 맞췄어요.
- **설정 재구성**: 13개 섹션을 11개(일반, 화면 및 입력, 단축키, 모델과 계정, 에이전트 동작, 도구와 확장, 권한 및 보안, 프로젝트 및 실행, 기기 및 연결, 업데이트 및 정보, 기타 설정)로 다시 묶었어요.
  - 같은 설정이 여러 곳에서 따로 편집되던 문제를 없애고, 설정마다 편집하는 곳을 한 곳으로 정했어요. 검색하면 바로 그곳으로 가요.
  - 이 기기 설정과 호스트 설정을 구분해서 보여 줘요.
  - 프로바이더 한도 추가 메뉴가 열리자마자 닫히던 문제를 고쳤어요.
- **omp와 같은 동작으로 통일**: OMPdesk가 따로 만들어 쓰던 부분을 omp의 실제 구현을 그대로 쓰도록 바꿨어요.
  - 세션 목록의 상태 표시가 정확해졌어요. 오류·중단된 응답이나 응답 없는 도구 호출을 더 이상 "완료"로 보이지 않아요.
  - 대화 기록, 세션 트리, 분기, 세션 삭제, worktree 위치, PR 체크아웃, 세션 이동 경로, 프로바이더 목록, models.yml 검사, 계정 매칭, 초기화권 판정, 로그아웃, 스킬·플러그인·에이전트·MCP 목록, 읽기 묶음, 토큰 속도도 omp 구현을 따라요.
  - 입력 기록을 터미널 omp와 함께 써요. 원격 탭은 호스트의 기록을 써요.
  - 초기화권은 omp가 허용하면 한도에 닿기 전에도 쓸 수 있어요.
  - `/명령:인자` 형식과 대소문자를 omp와 같게 처리해요.

## [0.18.2] - 2026-10-10

- **macOS 업데이트 후 권한 요청이 다시 뜨지 않아요**: 지금까지는 빌드마다 서명이 달라서 macOS가 업데이트된 OMPdesk를 다른 앱으로 보고, 폴더 접근·로컬 네트워크 같은 권한을 업데이트할 때마다 다시 물었어요. 이제 모든 릴리스를 OMPdesk 전용 인증서 하나로 서명해서 한 번 허용한 권한이 다음 업데이트에도 그대로 유지돼요. 이 버전으로 처음 업데이트할 때만 마지막으로 한 번 더 물어봐요.

## [0.18.1] - 2026-10-10

- **릴리스 파일을 정확히 두 개로**: v0.17.x에서 넘어오기 위한 예전 업데이트 파일(`latest*.yml`, zip, 버전이 붙은 설치 파일)을 더 이상 올리지 않아요. 릴리스에는 `ompdesk-mac-arm64.dmg`와 `ompdesk-windows-setup.exe`만 있어요.
- **worktree를 안전하게 정리**: 세션을 닫거나 앱을 끌 때 omp가 제때 종료되지 않으면, 아직 쓰고 있을 수 있는 worktree를 지우지 않고 남긴 뒤 알려 줘요.

## [0.18.0] - 2026-10-10

- **새 π 로고**: 앱 아이콘, 메뉴바 아이콘, 앱 안 로고, 워드마크를 omp와 같은 π 모양으로 바꿨어요. 왼쪽 다리 끝의 보라색 발이 OMPdesk 표시예요.
- **릴리스 파일이 Mac·Windows 두 개로**: GitHub 릴리스에는 `ompdesk-mac-arm64.dmg`와 `ompdesk-windows-setup.exe`만 올라가요(이번 한 번은 이전 버전이 업데이트할 수 있도록 예전 업데이트 파일도 함께 올라가요). 앱 업데이트는 릴리스 노트에 숨겨 둔 정보로 파일을 확인하고, macOS는 DMG를 받아 확인한 뒤 교체해요. 포터블 exe는 더 이상 만들지 않아요.
- **README 개편**: 맨 위에 macOS·Windows 다운로드 버튼을 넣고, 지금 기능에 맞게 전부 다시 썼어요.
- **계정 초기화권**: 설정의 계정 목록과 사용량 화면에 계정별 초기화권 개수와 만료일이 보이고, "초기화권 사용"으로 확인한 뒤 한 장을 쓸 수 있어요. 지금 쓸 수 없으면 이유와 함께 버튼이 꺼져 있어요. 원격 탭에서는 그 기기의 계정에 적용돼요.
- **omp 18.8.x 최신 기능 지원** (최신 omp에서만 보이고, 18.8.0에서는 아무것도 바뀌지 않아요):
  - 새 세션마다 worktree 자동 생성·정리(`worktree.onStart`/`onExit`): 터미널 omp와 같은 규칙으로 동작하고, 수정 중이거나 푸시하지 않은 작업은 묻지 않고 지우지 않아요.
  - 모델별 압축 시점: 모델 및 프로바이더에 편집기가 생기고, 모델 선택과 모델 역할에 "압축 시점"이 보여요.
  - 서브에이전트 계정 제한: 에이전트별로 쓸 수 있는 계정을 체크로 고르고, 계정마다 식별 키를 복사할 수 있어요.
- **SVG·Mermaid 미리보기**: 답변의 SVG 코드 블록과 .svg 파일 작성은 그림으로(스크립트·외부 참조는 제거), .mmd/.mermaid 파일 작성과 파일 패널은 다이어그램으로 보여요. 코드 보기로 바꿀 수 있어요.
- **대기열 조작**: 대기 중인 메시지를 하나씩 빼거나 "지금 보내기"로 바로 끼워 넣을 수 있고, 중단하면 대기 중이던 메시지가 입력창으로 돌아와요(터미널 omp의 Esc와 같아요).
- **분할 미리보기**: 세션을 끌어 화면을 나눌 때, 라벨 상자 대신 새 창이 들어갈 자리가 반투명하게 미리 보이고 커서 옆에 세션 이름이 따라와요.
- **입력창 개선**: 포커스 때 보라색 테두리 대신 차분한 그림자, 원형 보내기·중단 버튼, 항상 보이는 첨부 삭제 버튼, 이미지를 끌어 놓을 때 반투명 안내가 생겼어요.
- 테스트로 띄운 앱이 로그인 키체인을 쓰지 않아요(배포용 러너에서 멈추던 문제).

## [0.17.4] - 2026-10-09

- **macOS 배포 작업을 개발 Mac에서 실행**: 앱 동작은 바뀌지 않아요. 배포할 때 macOS 패키징과 점검을 GitHub의 macOS 서버(분당 요금이 가장 비싼) 대신 개발 Mac에서 돌려서, 배포 한 번의 GitHub Actions 비용이 절반 아래로 줄어요. 개발 Mac이 꺼져 있을 때는 GitHub의 macOS 서버로 배포할 수 있어요. 워크플로가 쓰는 외부 액션은 모두 특정 커밋으로 고정했어요.

## [0.17.3] - 2026-10-09

- **배포 비용 추가 절감**: 앱 동작은 바뀌지 않아요. 배포 한 번에 쓰는 GitHub Actions 시간을 약 3분의 1로 줄였어요. 운영체제마다 작업을 하나로 합쳐 설치·빌드를 한 번만 하고, 운영체제와 무관한 검사는 가장 싼 Linux에서 돌려요. macOS에서는 빠른 핵심 점검과 실제 omp 연동 점검만 하고, 전체 화면 테스트는 배포 전에 개발 Mac에서 돌려요. 일반 push 검사는 Linux 한 곳에서만 돌고, 문서만 바뀐 push는 검사하지 않아요.

## [0.17.2] - 2026-10-09

- **채팅의 마지막 세션을 지우면 "제목 없음"이 계속 생기던 문제를 고쳤어요**: omp가 첫 메시지 전에 새 세션 파일을 만드는데, 사이드바가 이것을 저장된 대화로 보고 "제목 없음"으로 보여 줬어요. 그걸 지우면 또 새 세션이 생겨 끝없이 반복됐어요. 이제 메시지가 없는 세션은 열려 있으면 "새 세션"으로(삭제 버튼 없음) 보이고, 열려 있지 않으면 목록에 나오지 않아요. 원격 기기 목록도 같아요.

## [0.17.1] - 2026-10-09

- **배포 파이프라인 비용 절감**: 앱 동작은 바뀌지 않아요. 일반 push·PR 검사는 Linux와 Windows에서 돌고, macOS 검사는 배포할 때만 돌아요. 배포 커밋은 배포 워크플로에서 한 번만 검사하고, 빌드 패키지 임시 보관은 1일(시험 배포는 7일)로 줄였어요. 받는 파일은 GitHub Release에 그대로 남아요.

## [0.17.0] - 2026-10-09

- **채팅에서도 모든 도구 사용**: 채팅 세션도 에이전트 세션처럼 omp의 모든 도구(파일 읽기·수정, 명령 실행, 웹 검색, 서브에이전트 등)를 써요. 프로젝트 폴더만 정해지지 않은 상태라서, OMPdesk 기본 작업 폴더에서 실행돼요. 입력창의 모드(계획 등)와 승인 방식, 할 일 카드, 사이드 패널의 모든 탭, 모든 명령도 채팅에서 똑같이 쓸 수 있어요. 채팅은 계속 사이드바의 채팅 목록에 따로 보여요.
- 새 채팅이 그때 보고 있던 프로젝트 폴더에서 열리던 문제를 고쳤어요. 이제 항상 기본 작업 폴더에서 열려요.

## [0.16.1] - 2026-10-09

- **AUTO 추론이 모델의 최대 단계까지**: OMPdesk에서 여는 세션은 AUTO가 고를 수 있는 추론 강도의 상한을 omp 기본(xhigh)에서 모델이 지원하는 최대(max)까지 넓혔어요. 설정에서 직접 상한을 정했다면 그 값을 따르고, 터미널의 omp는 그대로예요.
- **어드바이저도 AUTO 추론**: 어드바이저 모델을 고르면 메인 에이전트가 턴마다 고른 추론 강도를 따라가도록 저장해요. 예전에는 omp 기본 동작대로 항상 '보통'으로 돌았어요.
- **모델 구성 도우미가 직접 만든 역할을 덮지 않아요**: 자동 구성은 omp의 기본 역할(기본·빠른·생각·계획·어드바이저 등)만 제안하고, 직접 만든 역할(예: 서브에이전트용 역할)은 그대로 둬요.

## [0.16.0] - 2026-10-09

- **모델 구성 도우미**: 설정 › 모델 및 프로바이더의 "자동으로 구성"에서 연결된 계정의 모델 중 여러 개를 고르면, 고른 조사 모델이 최신 벤치마크를 웹에서 찾아보고 역할별(기본·빠른·생각·계획·어드바이저 등) 배치와 어드바이저 켜기 여부를 이유·출처와 함께 제안해요. 표에서 고친 뒤 "적용"을 눌러야 바뀌고, 바뀐 역할만 저장해요. 조사는 그 모델의 사용량과 웹 검색을 써요(웹 검색·읽기만 허용, 파일 수정 없음). 마지막 제안은 기기별로 남아서 다시 열면 바로 볼 수 있어요. 원격 탭에서는 그 기기에서 조사하고 적용해요.
- **어드바이저 설정이 한 화면에서**: 설정 › 기능 › 어드바이저 행에서 켜면 바로 아래에서 어드바이저 모델을 고를 수 있고, 모델이 없어 실행되지 않으면 그 자리에서 알려 줘요. `/advisor on`에서 모델이 없다는 알림에도 "자동으로 구성" 버튼이 붙어요.
- **추론 강도 기본값 AUTO**: 직접 정하지 않았다면 OMPdesk에서 여는 세션은 omp의 AUTO 추론(작업 난이도에 맞춰 강도 자동 조절)으로 시작해요. 설정 파일은 바꾸지 않아서 터미널의 omp는 그대로이고, 설정에서 직접 고른 값이 있으면 그 값을 따라요.

## [0.15.0] - 2026-10-09

- **오피스 문서 미리보기**: 사이드 패널 파일 탭에서 Word(.docx), Excel(.xlsx), PowerPoint(.pptx)를 열 수 있어요.
  - Word: 패널 폭에 맞춰 읽기 좋게 보여 주고, "페이지 레이아웃"으로 바꾸면 실제 페이지 모양과 확대·축소를 써요. 문서 안의 외부 링크·이미지는 불러오지 않아요.
  - Excel: 시트 탭으로 시트를 바꿔 보고, 숫자·날짜·퍼센트 형식대로 보여 줘요(최대 1000행·50열).
  - PowerPoint: 슬라이드마다 제목·본문·이미지와 발표자 노트를 카드로 보여 주는 간단 미리보기예요(레이아웃은 그대로 재현하지 않아요).
  - 예전 형식(.doc·.xls·.ppt)은 아직 "기본 앱으로 열기"만 돼요.
- **업데이트 확인이 제자리에서**: 앱 메뉴의 "업데이트 확인…"을 누르면 설정으로 넘어가지 않고, 사이드바 아래 카드에 "업데이트 확인 중…" → "최신 버전이에요"(몇 초 뒤 사라짐) 또는 받는 진행률·"재시작해서 업데이트"·실패(다시 확인)가 바로 나와요. GitHub 접근이 없을 때만 업데이트 설정으로 가는 버튼이 나와요.
- **설정 › 모델 및 프로바이더 개편**: 연결된 프로바이더만 한 줄씩 보이고, 눌러서 펼치면 계정별 남은 한도가 막대로 보여요. 연결 안 된 프로바이더는 "프로바이더 추가" 아래로 접었고, models.yml 엔드포인트는 따로 섹션이 생겼어요. 모델 비교는 기본으로 접혀 있고, 불러오기 실패는 큰 경고 상자 대신 한 줄 안내와 다시 시도로 바뀌었어요.
- **계정 순환 방식 2가지**: 모델 및 프로바이더에서 고를 수 있어요.
  - 한도 순환(기본): 남은 한도가 많은 계정을 먼저 쓰고, 초기화가 가까운 계정부터 소진해요.
  - 균등 순환: 새 세션마다 계정을 번갈아 써서 사용량을 고르게 나눠요. 한도에 닿은 계정은 건너뛰고, 한 세션 안에서는 계정을 바꾸지 않아요.
  - 원격 탭에서는 그 기기의 설정을 바꿔요.

## [0.14.0] - 2026-10-08

- **사이드 패널 파일 뷰어**: 파일 탭에서 여는 파일을 종류에 맞게 보여 줘요.
  - 코드: 문법 강조, 줄 번호, 줄 바꿈 전환. 큰 파일은 "더 불러오기"로 2MB까지 읽어요.
  - 마크다운·HTML: 렌더링/원문 전환. HTML은 스크립트가 막힌 샌드박스에서 보여 줘요.
  - PDF: 페이지를 바로 보여 주고 확대·축소할 수 있어요.
  - 이미지: 크기 표시와 확대 보기. 오디오·비디오는 바로 재생돼요.
  - CSV·TSV는 표로, JSON·JSONL은 보기 좋게 정리해서, Jupyter 노트북은 셀과 출력까지 보여 줘요.
  - 그 밖의 바이너리 파일은 16진수 미리보기와 "기본 앱으로 열기"를 보여 줘요. Office 문서(docx·xlsx·pptx)도 아직 여기에 해당해요.
  - 파일 트리에 종류별 아이콘이 붙고, 미리보기 위의 넓히기 버튼으로 패널을 크게 볼 수 있어요. 원격 탭에서는 그 기기의 파일을 보여 줘요.
- **채팅 이미지 확대가 채팅 영역 안에서 열려요**: 이미지를 누르면 창 전체가 아니라 그 채팅 영역만 덮어서, 사이드바와 사이드 패널이 그대로 보여요.
- **사이드바 상태가 실시간으로 바뀌어요**: 보고 있지 않은 세션의 "승인 필요"(플랜 승인 요청)와 서브에이전트 수가 그 세션을 눌러야만 갱신되던 문제를 고쳤어요.

## [0.13.0] - 2026-10-08

- **원격 탭에서는 그 기기의 설정**: 원격 기기에서 돌아가는 탭을 보고 있을 때 설정을 열면, 맨 위에 "Host B의 설정이에요" 안내와 함께 그 기기의 설정이 나와요. 제공자·계정, 모델과 models.yml 사용자 제공자, 권한, 기능, 확장, 플러그인, 프로젝트 폴더, SSH 호스트, omp 버전·업데이트, 사용량, 통계, 벤치마크가 모두 그 기기 기준이에요. 모양·단축키·언어·앱 업데이트·원격 기기처럼 이 기기에 속한 설정은 메뉴에 모니터 아이콘으로 표시돼요. 그 기기가 꺼져 있으면 예전 값 대신 "오프라인" 안내가 나와요. 로컬 탭으로 돌아가면 이 기기 설정이 다시 보여요.
- **원격 기기에 로그인**: 원격 탭에서도 Claude 등에 로그인할 수 있어요. 브라우저는 이 기기에서 열리고, 로그인이 끝난 뒤 주소창의 주소(`http://localhost…?code=…`)를 붙여 넣으면 그 기기에 로그인돼요. 화면에 안내가 나와요.
- 원격 탭에서 로그인·bash·플랜 승인·PR 체크아웃처럼 오래 걸리는 명령이 거부되던 문제를 고쳤어요.
- 브라우저 로그인 중에 로그인 버튼이 "키 페이지 열기"로 잘못 바뀌던 문제를 고쳤어요.

## [0.12.0] - 2026-10-08

- **남은 팝업도 카드로**: 짧은 입력, 긴 글 편집, 링크 열기, 플랜 승인 창도 이제 화면을 가리는 팝업이 아니라 입력창 위 카드로 나와요. 플랜은 카드 안에서 스크롤해서 읽고, 실행·압축 후 실행·현재 맥락 유지·저장·수정 요청·닫기를 숫자 키로 고를 수 있어요. 긴 글은 ⌘↵로 보내고 ↵는 줄바꿈이에요. 승인 버튼에 처음부터 초점이 가지 않아요.
- **대화 언어 직접 선택**: 설정 › 일반 › 대화 언어에서 자동(기기 언어), 한국어·영어·일본어·중국어(간체/번체)·스페인어·프랑스어·독일어·포르투갈어·베트남어, 또는 "지정 안 함"을 고를 수 있어요. 바꾸면 열려 있는 세션의 다음 답변부터 바로 적용돼요.
- **원격 사용 중 잠자기 방지**: 다른 기기가 이 컴퓨터를 쓰는 동안(연결돼 있거나 작업이 돌고 있는 동안) 잠자기를 막아요. 설정 › 원격 기기에서 끌 수 있고, 지금 누가 쓰고 있는지도 보여요. 사용이 끝나면 1분 뒤 풀려요.
- **업데이트 화면이 더 빨리 떠요**: 앱 업데이트 결과가 omp 업데이트 확인(느린 네트워크에서 최대 1분)을 기다리지 않고 바로 나와요.

## [0.11.0] - 2026-10-08

- **원격 기기**: 다른 컴퓨터에서 작업을 돌릴 수 있어요. 양쪽에 OMPdesk를 설치하고, 작업할 컴퓨터에서 설정 › 원격 기기의 "다른 기기에서 이 컴퓨터 사용 허용"을 켜면 연결 코드(`XXXX-XXXX`, 10분 유효)가 나와요. 이 컴퓨터에서 "기기 연결"을 누르면 같은 네트워크의 기기가 자동으로 보이고(Tailscale 등은 주소를 직접 입력), 코드를 넣으면 연결돼요. 사이드바에 그 기기의 프로젝트와 세션이 따로 보이고, 거기서 연 세션은 그 컴퓨터의 omp·파일·git·로그인으로 돌아가요. 탭에는 기기 이름이 표시되고, 연결이 끊기면 "다시 연결 중"을 보여 준 뒤 돌아오면 이어서 써요(그쪽 세션은 10분 동안 유지). 연결은 기기별 키로 암호화·인증되고, 연결한 기기는 언제든 해제할 수 있어요.
- **계정 여러 개와 자동 순환**: 설정 › 제공자에서 Claude·ChatGPT 계정을 여러 개 추가할 수 있어요. 계정마다 남은 한도(5시간·주간), 지금 쓰는 계정, "HH:MM까지 제한" 상태가 보이고, omp가 남은 한도에 맞춰 계정을 번갈아 써요. 계정을 하나씩 뺄 수 있고, 사용량 화면도 계정별로 나뉘어요.
- **대화 기본 언어 자동 설정**: 기기 언어를 읽어서 에이전트가 기본으로 그 언어로 답해요. 다른 언어로 말을 걸면 그 언어로 답하고, 코드·커밋 메시지는 프로젝트 언어를 따라요. 영어 기기에서는 아무것도 바뀌지 않아요.
- **"모델 응답을 기다리는 중… N초" 경고 줄 제거**: 오래 기다려도 경고 문구와 버튼 없이 작은 스피너만 보여요.

## [0.10.0] - 2026-10-08

- **질문이 한 번에 하나씩**: 에이전트가 여러 질문을 하면, 모든 질문을 한 화면에 늘어놓고 스크롤하던 방식 대신 Claude 앱처럼 한 질문씩 보여 줘요. 위에 단계 표시(답한 질문은 ✓, 눌러서 다시 가기)와 "2/3" 같은 진행이 나오고, 하나를 고르면 바로 다음 질문으로 넘어가요. 마지막 질문에서 "제출"을 누르면 모든 답이 함께 가요. 여러 개 고르는 질문은 고른 뒤 "다음"을 눌러요.
- **숫자 키로 바로 고르기**: 선택지마다 번호가 붙어 있고, 1~9 키로 바로 고를 수 있어요. ↑/↓로 이동, Esc는 취소예요. 직접 입력은 그대로 있고, 메모는 "메모 추가"를 눌렀을 때만 나와요.
- **확인·선택·도구 승인도 같은 카드로**: 화면을 가리던 팝업 대신, 입력창 바로 위에 같은 모양의 카드로 나와요. 대화 내용을 보면서 답할 수 있어요. 도구 승인은 1=허용, 2=거부이고, 실수로 허용되지 않도록 처음 초점은 허용 버튼에 가지 않아요.

## [0.9.3] - 2026-10-08

- **업데이트를 건너뛰면 더 이상 받을 수 없던 문제 수정**: 받아 둔 업데이트(예: 0.9.1)를 설치하지 않은 채 다음 버전(0.9.2)을 받으려 하면, 받아 둔 업데이트를 지우는 단계에서 실패해 오류만 뜨고 어떤 업데이트도 받을 수 없었어요. 앱 묶음 안의 `app.asar` 파일 때문에 정리가 중간에 멈췄던 거예요. 이제 남은 파일을 끝까지 지우고, 혹시 하나를 못 지워도 새 업데이트 받기는 계속 진행돼요.

## [0.9.2] - 2026-10-07

- **ChatGPT 계정을 연결하는 즉시 이미지 생성 켜짐**: 0.9.1은 탭을 새로 열거나 모델 목록을 다시 불러올 때만 이미지 생성 도구를 켰어요. 이제 설정이나 `/login`으로 계정을 연결하는 순간, 열려 있는 모든 탭에서 바로 켜져요. 로그아웃하면 바로 꺼지고, 다시 시작할 필요가 없어요.

## [0.9.1] - 2026-10-07

- **연결된 계정으로 이미지 생성 자동 사용**: omp의 이미지 생성 도구는 기본으로 꺼져 있어서, ChatGPT 계정이 연결돼 있어도 "이미지 만들어 줘"라고 하면 쓸 수 없었어요. 이제 이미지를 만들 수 있는 계정(예: ChatGPT 로그인의 gpt-image-2)이 연결돼 있으면 OMPdesk가 이미지 생성 도구를 자동으로 켜요. Claude로 대화하는 중에도 이미지 생성은 그 계정으로 해요. 로그인하거나 로그아웃하면 바로 반영되고, omp 설정 파일(config.yml)은 바꾸지 않아요. 설정 › 도구에서 직접 끄면 그 선택을 따라요.

## [0.9.0] - 2026-10-07

- **대화 속 이미지 확대**: 대화 기록의 이미지(첨부 이미지, 답변 속 그림, 스크린샷, 생성 이미지, 도구 결과 이미지)를 누르면 창 크기로 크게 보여요. 한 번 더 누르면 원래 크기로 보고 스크롤할 수 있어요. Esc나 바깥을 누르면 닫혀요.
- **업데이트를 더 빨리 확인**: 새 버전 확인 주기를 4시간에서 5분으로 줄였어요.
- **사이드바 업데이트 알림을 한 줄로**: 아이콘, "0.9.0 업데이트 준비됨", 재시작 버튼, 닫기만 남긴 한 줄로 바꿨어요. 자세한 설명은 마우스를 올리면 보여요. 설치 프로그램을 받는 중이면 줄 아래에 진행 막대가 나와요.

## [0.8.1] - 2026-10-07

- **설정 검색 입력이 엉뚱한 칸으로 가던 문제 수정**: 검색 결과를 누른 직후 바로 다시 검색어를 치면, 늦게 옮겨 간 포커스 때문에 글자가 방금 연 설정 칸(시스템 프롬프트 등)에 들어갈 수 있었어요. 이제 이미 다른 곳에 입력 중이면 포커스를 옮기지 않아요.
- **계획 넘기기(prewalk) 취소 수정**: 한 번 취소하면 앱을 다시 켤 때까지 모든 세션에서 prewalk가 꺼져 있던 문제를 고쳤어요. 이제 그 세션의 대기 중인 넘기기만 취소해요.
- **남은 오류 문구도 한국어로**: 통계, 설정 저장, 외부 편집기, 모델 비교, 사용자 프로바이더, 업데이트 토큰 저장 등에서 나오던 영어 오류가 이유를 알려 주는 한국어 문장으로 나와요. 토큰 저장이나 omp 재시작 실패처럼 아무 표시 없이 지나가던 실패도 이제 알려 줘요.
- **긴 세션에서 더 가볍게**: 도구 기록이 쌓여도 도구 이벤트 하나를 처리하는 비용이 늘지 않도록 바꿨어요(5만 개 기준 약 90µs → 1µs 미만). 끝난 도구 결과를 두 벌씩 들고 있지 않아 메모리도 줄었어요.
- **다른 탭 시나리오 자동 검사 추가**: 질문 창, 계획 승인, 완료 알림, 추천 프롬프트, 서브에이전트 목록을 실제 앱으로 검사하는 테스트를 추가했어요.

## [0.8.0] - 2026-10-07

**omp 18.7 이상이 필요해요.** 18.7 미만이면 `omp update`를 실행하세요.

### 다른 탭에서 작업 중인 세션
- **질문·확인 창이 사라지지 않아요**: 화면에 없는 탭의 에이전트가 질문이나 확인을 요청하면 그 요청이 버려져서, 에이전트가 계속 "실행 중"으로 멈춰 있던 문제를 고쳤어요. 이제 그 탭으로 가면 창이 그대로 떠 있고, 사이드바에는 그 세션에 확인 필요 표시가 나와요.
- **계획 승인 카드 복구**: 계획 모드 탭이 뒤에서 계획을 끝내도, 돌아오면 승인 카드가 나타나요.
- **도구 카드가 계속 돌던 문제 수정**: 작업 중인 탭으로 돌아왔을 때, 그 사이 끝난 도구 단계가 결과 없이 회전 상태로 남던 문제를 고쳤어요.
- **"재시도 중…", "자동 정리 중…" 표시 정리**: 뒤에서 끝난 재시도·정리 표시가 돌아온 뒤에도 남아 있지 않아요.
- **작업 완료 알림**: 다른 탭의 작업이 끝나거나 실패하면 데스크톱 알림이 와요. 알림 제목에는 그 세션의 이름이 나와요.

### 사이드바·입력창
- **서브에이전트 목록은 기본으로 접혀요**: 세션 줄 오른쪽의 서브에이전트 개수 표시를 누르거나, 지금 열린 세션을 한 번 더 누르면 펼쳐지고 접혀요. →/← 키도 돼요. 펼친 목록은 왼쪽 여백을 줄이고, 세션에서 이어지는 선으로 연결돼 보여요. 경과 시간은 "10m"처럼 짧게 보여요.
- **입력창 위 서브에이전트 표시**: "서브에이전트" 글자를 빼고 아이콘과 개수만 보여요.
- **추천 프롬프트가 사라지지 않아요**: 추천을 받아 쓰다가 지우거나, 글자를 입력했다가 지우거나, 다른 세션에 갔다가 돌아와도 추천이 다시 나타나요. 메시지를 보내거나 새 작업이 시작될 때만 사라져요.

### 업데이트·안정성
- **Windows 자동 업데이트도 실행 중인 작업을 확인**: 설치 전에 종료 확인을 받고, 탭 구성을 저장한 뒤 다시 시작해요.
- **업데이트 다운로드 수정**: 다운로드 중에 업데이트 화면을 열면 두 번 동시에 받아져 파일이 깨지던 문제와, 받다가 멈추면 앱을 다시 켤 때까지 재시도하지 않던 문제를 고쳤어요.
- **워크트리 탭 닫기 수정**: 탭을 닫을 때 그 탭이 만든 워크트리만 지워요. 지금 열린 세션의 폴더를 잘못 지우는 일이 없어요.
- **omp 연결 회복**: 시작할 때 상태 확인이 한 번 실패해도 탭이 계속 "오류"로 남지 않고 다시 연결돼요. omp가 갑자기 꺼져도 앱 오류 창이 뜨지 않아요.

### 속도
- 서브에이전트를 여럿 돌릴 때와 답변이 길 때 화면이 버벅이던 문제를 줄였어요. 앱이 omp와 주고받는 데이터와 화면을 다시 그리는 횟수를 크게 줄였어요.
- 세션 목록은 변경 한 번에 한 번만 다시 불러와요. 변경 사항 패널과 제목 표시줄도 필요할 때만 계산해요.
- 예전에 중단된 도구 호출 때문에 실행 시간이 몇 시간씩으로 보이던 문제를 고쳤어요.

### 문구
- 오류 알림과 화면 안 오류가 영어 원문 대신 한국어 설명으로 나와요. 원문은 아래에 작게 보여요. "세션이 실행 중이에요"처럼 이유가 분명한 오류는 그 이유를 바로 알려 줘요.
- 외부 편집기 안내, bash 출력 잘림 안내, 입력 대기 알림을 한국어로 보여 줘요. 날짜와 숫자는 앱 언어 형식으로 나와요.
- 남아 있던 중국어 문구와 쓰이지 않는 번역 135개를 정리했어요.

## [0.7.0] - 2026-10-07

- **중국어 UI 제거**: 화면 언어는 English와 한국어 두 가지만 남았어요. 언어 버튼은 두 언어 사이를 오가고, 중국어로 설정해 두었다면 시스템 언어(한국어 또는 English)로 바뀌어요. 모델이 쓴 중국어 글자는 그대로 잘 보여요.
- **다른 탭에서 작업 중인 세션의 회전 표시 복구**: 선택하지 않은 세션이 작업 중일 때 사이드바의 회전 애니메이션이 사라지고, 눌러야 다시 나오던 문제를 고쳤어요. 그 세션 아래 서브에이전트 줄도 함께 보여요.
- **"모델 응답을 기다리는 중…" 오표시 수정**: 다른 탭에서 작업 중인 세션으로 돌아왔을 때, 모델이 이미 답변이나 긴 도구 호출(큰 파일 작성 등)을 쓰고 있는데도 "아직 응답이 없어요. 네트워크 문제일 가능성이 높아요" 경고가 몇 분씩 떠 있던 문제를 고쳤어요. 이제 진행 중인 답변을 바로 이어서 보여 줘요.

## [0.6.0] - 2026-10-07

- **앱 이름 표기를 OMPdesk로**: 메뉴 막대, 앱 메뉴, 창 제목, 사이드바, 트레이, 설치된 앱 이름(OMPdesk.app)과 안내 문구가 모두 OMPdesk로 바뀌어요. 설정·로그인 정보·업데이트는 그대로 이어져요.
- **앱 메뉴에 "업데이트 확인…"**: macOS 앱 메뉴(Windows는 도움말 메뉴)에서 바로 업데이트를 확인할 수 있어요. 누르면 설정 › 업데이트가 열리고 확인을 시작해요. 앱 메뉴의 영어 항목(정보, 서비스, 가리기, 종료 등)도 한국어·중국어로 나와요.
- **서브에이전트가 세션 바로 아래에**: 사이드바의 "서브에이전트" 묶음 대신, 실행 중인 서브에이전트가 그 세션 아래 줄로 바로 붙어요. 누르면 그 서브에이전트의 실시간 기록이 열려요. 끝난 서브에이전트는 목록에서 바로 사라져요.
- **입력창 위 서브에이전트 표시를 작게**: 넓은 배너 대신 할 일 카드 옆에 "서브에이전트 N" 작은 칩만 보여요. 마우스를 올리면 실행·완료·실패 개수가 나오고, 누르면 사이드바의 목록으로 이동해요.
- **작업 중에도 세션 제목 변경**: 실행 중인 세션도 사이드바(버튼, 메뉴, F2)와 제목 표시줄에서 이름을 바꿀 수 있고 바로 반영돼요. 삭제는 여전히 작업이 끝난 뒤에만 돼요.
- **IRC 알림 제거**: 서브에이전트끼리 주고받는 IRC 메시지가 화면 아래에 잠깐 떴다 사라지던 알림을 없앴어요.

## [0.5.2] - 2026-10-07

- **세션을 눌러도 순서가 바뀌지 않아요**: 사이드바에서 세션을 열 때마다 그 세션과 프로젝트가 맨 위로 올라가던 문제를 고쳤어요. 이제 세션 순서는 실제로 대화가 오간 시각을 따르고, 여는 것만으로는 자리가 바뀌지 않아요(고정과 드래그한 프로젝트 순서는 그대로예요).
- **채팅 왼쪽 턴 표시 수정**: 맨 아래 최신 내용을 보고 있을 때 왼쪽 `-` 턴 표시에서 현재 위치가 중간 턴에 머물던 문제를 고쳤어요. 맨 아래에 있으면 마지막 턴이 현재 턴으로 표시돼요.
- **설정 번역 보강**: 최신 omp에 새로 생긴 설정(SVG 그림 렌더링, 표 자동 차트, 제목 아이콘, 제목 생성 방식)과 섹션 제목, 선택지 설명 140여 개가 영어로 나오던 것을 한국어·중국어로 옮겼어요.

## [0.5.1] - 2026-10-07

- **사이드바에서 프로젝트를 지울 수 없던 문제 수정**: 프로젝트 메뉴(⋯ 또는 우클릭)의 "삭제"가 세션 파일만 지우고, 그 프로젝트에 열려 있던 탭 때문에 프로젝트가 목록에 그대로 남던 문제를 고쳤어요. 이제 삭제하면 그 프로젝트의 열린 탭도 닫히고 프로젝트가 목록에서 사라져요. 열린 탭이 그 프로젝트뿐이면 다른 프로젝트(없으면 채팅)에서 새 탭이 먼저 열려요. 아직 저장된 세션 없이 탭만 열린 프로젝트도 삭제할 수 있어요.

## [0.5.0] - 2026-10-07

- **사이드바 "코드 | 채팅"**: "업무" 칸이 "채팅"으로 바뀌었어요. 코드에는 프로젝트별 세션만, 채팅에는 도구 없는 채팅과 프로젝트 폴더 없이 시작한 세션이 한 목록으로 모여요. 채팅 칸의 버튼은 "새 채팅"이에요.
- **프로젝트 순서를 드래그로 바꾸기**: 코드 칸의 프로젝트를 끌어서 원하는 위치로 옮길 수 있고, 순서는 저장돼요. 새로 연 프로젝트는 맨 위에 나타나요. 키보드로는 프로젝트 메뉴의 "위로 이동/아래로 이동"을 쓰면 돼요.
- **프로젝트에 + 버튼**: 프로젝트 이름 옆의 세션 개수 대신 + 버튼이 항상 보여서, 누르면 그 프로젝트에서 바로 새 세션이 열려요.

## [0.4.2] - 2026-10-07

- **업데이트 화면에서 키체인 암호 창이 뜨던 문제 수정**: 설정 › 업데이트를 열 때마다 "ompdesk Safe Storage" 키체인 암호를 묻고, 응답할 때까지 버전 확인이 멈춰 있던 문제를 고쳤어요. 이제 GitHub 토큰을 직접 붙여 넣어 저장한 경우에만 키체인을 사용해요(gh 로그인이나 GH_TOKEN을 쓰면 묻지 않아요).

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
