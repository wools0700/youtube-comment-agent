# 유튜브 댓글 대시보드

로컬 PC에서 실행하는 React·Express 대시보드입니다. 영상 선택 → AI 댓글 초안 검토 → 전용 Chrome 프로필로 댓글 게시 순서로 사용합니다. 웹 서버에 배포하는 프로그램이 아니며, 댓글 게시 시 **실제 YouTube 댓글이 등록됩니다**.

## 제작 의도

영상 검색부터 실제 댓글 확인까지 한 화면에서 이어지는 작업 도구를 만들었습니다. 처음 사용하는 사람도 **영상 선택 → 초안 검토 → 댓글 작성**의 세 단계만 따라가면 되도록 구성했습니다. 영상 목록과 링크 입력을 함께 제공해 검색 결과에 없는 영상도 다룰 수 있습니다.

댓글이 영상마다 같아 보이지 않도록 AI가 영상 내용과 관련 댓글을 참고해 연애 고민, 시청자 관점, 구체적인 근거를 함께 제시합니다. 초안은 40~120자로 제한하고 표현과 길이를 달리하되, 확인하지 않은 이용 후기는 만들지 않습니다. AI가 장면을 잘못 해석하거나 어색하게 쓸 수 있으므로 게시 전 사용자가 근거와 문장을 직접 확인·수정하고 확정하게 했습니다.

게시 단계에서는 로그인된 전용 Chrome 프로필을 열어 한 글자씩 입력하고 실제 댓글 표시까지 확인합니다. 영상당 한 계정의 댓글 하나, 하루 최대 10개를 코드에서 제한하며, 사용 계정과 성공·실패를 기록해 중복 게시를 막습니다. 여러 계정 자동배정과 조회수 변화 기반 급상승 표시를 넣어 반복 운영도 고려했습니다. 로컬 실행 방식은 Chrome 프로필과 로그인 상태를 사용자의 PC에 두기 위한 선택입니다.

## 다른 Windows PC에서 처음 실행하기

### 0. 준비물

- **Windows PC와 Google Chrome**: 댓글 게시와 계정 연동은 설치된 Chrome을 사용합니다. 현재 계정 연동 코드가 Windows의 `chrome.exe` 경로를 찾으므로 macOS·Linux 실행은 지원하지 않습니다.
- **Node.js**: 22.12 이상 또는 20.19 이상의 20.x 버전. 설치 시 npm이 함께 제공됩니다. [Node.js 다운로드](https://nodejs.org/en/download/)
- **Google Chrome**: [Chrome 다운로드](https://www.google.com/chrome/). YouTube에서 댓글을 쓸 Google 계정도 필요합니다.
- **인터넷 연결과 본인의 API 키 2개**: 공개 영상 검색용 YouTube Data API 키, 영상 분석·초안 작성용 Gemini API 키.
- Git으로 내려받을 경우 Git. Git이 없다면 GitHub 저장소에서 **Code → Download ZIP**을 선택해 압축을 풀어도 됩니다.

Python, SQL, 전역 Vite 설치, 기존 PC의 개발 도구 설정은 필요하지 않습니다. 아래 명령은 **PowerShell**에서 프로젝트 폴더를 기준으로 실행합니다.

### 1. 소스 받기

저장소 주소의 `OWNER/REPO`를 실제 공개 저장소 주소로 바꿉니다.

```powershell
git clone https://github.com/OWNER/REPO.git
cd REPO
```

ZIP으로 받았다면 압축을 푼 폴더를 PowerShell에서 열면 됩니다. 폴더 안에 `package.json`, `package-lock.json`, `client`, `server`가 보여야 합니다.

### 2. 의존성 설치

```powershell
node --version
npm --version
npm ci
```

`npm ci`가 저장소의 잠금 파일에 맞춰 클라이언트·서버 패키지를 설치합니다. `node_modules`를 다른 PC에서 복사할 필요는 없습니다. Node 버전이 맞지 않는다는 오류가 나면 위 준비물의 Node 버전으로 설치한 뒤 **새 PowerShell 창**에서 다시 실행합니다.

### 3. API 키 만들기

**YouTube 키**

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만들거나 선택합니다.
2. **API 및 서비스 → 라이브러리**에서 **YouTube Data API v3**를 찾아 사용 설정합니다.
3. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키**에서 키를 만듭니다.
4. 키의 **API 제한**에서 YouTube Data API v3만 허용합니다. 이 프로젝트는 공개 영상 정보를 API 키로 읽고, 댓글 게시는 아래의 로그인된 Chrome 창에서 처리합니다. [YouTube API 시작 안내](https://developers.google.com/youtube/v3/getting-started)

**Gemini 키**

1. [Google AI Studio](https://aistudio.google.com/)에 로그인합니다.
2. **Dashboard → API Keys**에서 프로젝트와 키를 확인하거나 새 키를 만듭니다.
3. 해당 프로젝트에서 이 앱의 Gemini 모델을 사용할 수 있는지와 현재 사용량·요금제를 확인합니다. 무료 한도와 모델 접근 권한은 프로젝트 상태에 따라 다릅니다. [Gemini API 키 안내](https://ai.google.dev/gemini-api/docs/api-key)

두 키는 서로 다른 용도입니다. YouTube 키를 `GEMINI_API_KEY`에 넣거나 그 반대로 넣으면 동작하지 않습니다.

### 4. 로컬 `.env` 입력

```powershell
Copy-Item .env.example .env
notepad .env
```

열린 파일에 **자신의 키만** 입력하고 저장합니다. 아래 값은 형식 예시이며 실제 키가 아닙니다.

```dotenv
PORT=3001
YOUTUBE_API_KEY=여기에_YouTube_API_키
GEMINI_API_KEY=여기에_Gemini_API_키
```

`PORT=3001`은 그대로 두세요. 프런트엔드의 개발 서버가 `/api` 요청을 이 포트로 전달합니다. `.env`는 Git에서 제외되므로 새 PC마다 직접 만들어야 합니다. 키를 README, 코드, GitHub 이슈나 화면 캡처에 넣지 마세요.

### 5. 대시보드 실행

```powershell
npm run dev
```

이 명령은 React 화면과 로컬 API 서버를 함께 시작합니다. PowerShell에 표시된 Vite 주소를 Chrome에서 엽니다. 기본 주소는 `http://localhost:5173`이고, 그 포트가 사용 중이면 Vite가 다른 포트를 표시할 수 있습니다. API 서버는 `http://127.0.0.1:3001`에서 실행됩니다. 사용 중에는 PowerShell 창을 열어 두고, 종료할 때 `Ctrl+C`를 누릅니다.

### 6. 댓글용 Chrome 프로필 로그인

처음 실행해 로그인 확인된 계정이 없으면 영상 선택과 댓글 작성 영역은 잠겨 있습니다. 상단의 **계정 등록하기**에서 아래 절차를 마치면 사용할 수 있습니다. 목록에 기본 프로필 이름이 보여도 YouTube 로그인 확인 전에는 계정으로 세지 않습니다.

1. 대시보드 상단의 **계정 등록하기**를 클릭합니다.
2. 기본으로 보이는 **유튜브1**에서 **Google 계정 연동**을 누릅니다. 새 프로필을 만들고 싶다면 이름을 입력한 뒤 **추가하고 연동**을 누릅니다.
3. 열린 **전용 Chrome 창**에서 YouTube에 사용할 Google 계정으로 로그인합니다.
4. 그 Chrome 창을 **완전히 닫고** 대시보드의 **상태 확인**을 누릅니다. **YouTube 로그인 확인**이 표시되면 준비됐습니다.

평소 사용하던 Chrome 기본 프로필의 로그인 상태는 전용 프로필에 자동으로 복사되지 않습니다. `data/chrome-*` 로그인 폴더도 Git에 포함되지 않으므로 **다른 PC에서는 다시 로그인**해야 합니다. 과제의 필수 기능은 프로필 1개로 확인할 수 있습니다.

프로필 이름 옆 삭제 아이콘은 이 앱의 해당 프로필과 이 PC의 전용 Chrome 로그인 데이터를 지웁니다. Google 계정 자체와 기존 댓글 게시 기록은 삭제하지 않습니다. 전용 Chrome 창이나 댓글 작업이 열려 있으면 삭제할 수 없습니다.

**계정 변경**은 확인 후 해당 전용 Chrome 프로필의 기존 로그인 데이터를 지우고 새 창을 엽니다. 새 Google 계정으로 로그인하고 창을 완전히 닫은 뒤 **상태 확인**을 누르세요. Google 계정 자체와 댓글 게시 기록은 유지됩니다.

### 7. 기능 사용

1. **영상 선택**에서 **영상 불러오기**를 누르고 목록에서 고릅니다. 또는 **링크로 선택** 탭에서 공개 YouTube 영상 주소를 입력합니다.
   목록을 불러온 뒤 서버가 켜져 있는 동안 후보 영상의 조회수를 약 30분마다 다시 확인합니다. 조회수 1,000~5,000회인 영상은 1시간 전 기록이 쌓이기 전까지 **급상승 측정 중**으로 표시하며, 시간당 150회 이상 증가하면 **최근 1시간 급상승** 라벨과 함께 추천순 앞쪽에 표시합니다. 이 재측정은 새 영상 검색을 반복하지 않습니다.
2. **AI 초안 작성**을 누릅니다. 팝업에서 영상 속 고민·근거·댓글을 검토하고 확인 표시 후 **확정**합니다. 다른 문장이 필요하면 **다른 표현으로 다시 생성**을 사용합니다.
   초안은 짧은 글과 긴 글을 섞어 작성하며 게시 조건은 공백·이모지 포함 40~120자입니다. 쉼표·마침표를 제거하고 120자를 넘으면 자동으로 줄입니다. Gemini 영상 분석 중 `INTERNAL` 오류가 나면 다른 영상 처리 방식으로 한 번 재시도합니다. 이때 같은 영상에 대한 API 처리량이 두 번 사용될 수 있으며, 외부 서비스 오류가 계속되면 화면에 원인을 표시합니다.
3. 3단계의 **자동배정**을 누르면 로그인 확인된 전용 프로필 중 지난 게시 성공 계정의 다음 프로필을 현재 영상에 배정합니다. 계정이 하나면 그 계정만 사용합니다. 자동배정만으로 댓글이 게시되지는 않습니다.
4. **댓글 작성**을 누릅니다. 자동배정했다면 해당 프로필이 바로 열리고, 배정하지 않았다면 열린 Chrome 창에서 프로필을 고릅니다. 앱이 한 글자씩 입력하고 게시 결과를 확인합니다. 이 단계는 실제 댓글을 게시합니다.

영상당 댓글 1개, 하루 확인된 댓글 최대 10개로 제한합니다. 상태와 오류는 대시보드 하단에 표시됩니다.

## 스타일만 수정할 때

Node 설치와 `npm ci`까지 한 다음 `npm run dev -w client`로 화면만 열 수 있습니다. 이 경우 API 서버가 없으므로 영상 불러오기·AI 분석·게시 기능은 동작하지 않습니다. 전체 화면과 실제 데이터를 확인하려면 `.env`를 설정하고 `npm run dev`를 사용하세요. 화면 스타일은 `client/src/App.css`, 색상 변수는 `client/src/index.css`에 있습니다.

## 실행 문제 확인

| 증상 | 확인할 것 |
| --- | --- |
| `node` 또는 `npm` 명령을 찾지 못함 | Node.js를 설치하고 새 PowerShell 창을 엽니다. |
| `npm ci`가 버전 오류로 중단됨 | Node 버전이 위 준비물의 범위인지 확인합니다. |
| 화면은 열리지만 영상 목록이 안 뜸 | API 서버가 함께 실행 중인지, `.env`의 `YOUTUBE_API_KEY`와 YouTube Data API v3 사용 설정·할당량을 확인합니다. |
| AI 초안 작성 실패 | `GEMINI_API_KEY`, 프로젝트의 모델 접근 권한·사용량, 영상 공개 여부를 확인합니다. 하단 오류 메시지를 먼저 읽습니다. |
| Chrome을 찾지 못함 | Windows에 Google Chrome을 설치합니다. |
| 로그인 상태 확인 실패 | 전용 Chrome 창을 완전히 닫은 뒤 다시 누릅니다. 다른 PC라면 해당 PC에서 다시 로그인합니다. |
| `3001` 포트 사용 중 | 그 포트를 사용 중인 다른 프로세스를 종료합니다. `.env`의 PORT만 바꾸면 프런트엔드 프록시와 맞지 않습니다. |

## Git에 포함되는 것

`package-lock.json`, 키 이름만 적힌 `.env.example`, 소스 코드와 이 README는 저장소에 포함합니다. `.gitignore`는 실제 키가 들어 있는 `.env`, 인증서·자격 증명 파일, `data/`의 Chrome 로그인 상태·댓글 기록·AI 초안 캐시, 로그, 화면 캡처, `node_modules/`, 빌드 결과물을 제외합니다. 따라서 저장소를 받은 PC에서는 각자의 API 키를 넣고 YouTube에 다시 로그인해야 합니다. 코드를 확인하려면 `npm run build`를 실행할 수 있습니다.

공개 전에 PowerShell에서 `git status --short`로 업로드할 파일을 확인하세요. `git check-ignore .env data/history.jsonl node_modules client/dist server/dist`를 실행하면 위 경로가 제외되는지도 확인할 수 있습니다. `.gitignore`는 **이미 추적 중인 파일을 자동으로 제거하지 않으므로**, `git ls-files`에도 비밀 파일이 없는지 확인하세요. 실제 API 키나 Google 로그인 자료를 README, 이슈, 화면 캡처, 커밋 메시지에 넣지 마세요.

## 처음 GitHub에 공개할 때 (게시자용)

1. [GitHub에서 새 저장소](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)를 `youtube-comment-agent` 같은 이름으로 **Public**으로 만듭니다. 이 프로젝트에는 README와 `.gitignore`가 이미 있으므로 GitHub의 새 저장소 생성 화면에서 README·`.gitignore`·라이선스 자동 추가를 선택하지 않습니다.
2. 이 프로젝트는 이미 `main` 브랜치와 로컬 커밋이 있습니다. 프로젝트 폴더에서 아래 명령을 실행합니다. `OWNER/REPO`를 방금 만든 저장소 주소로 바꿉니다.

```powershell
cd C:\marketing-agent
git status --short
git check-ignore .env data/history.jsonl node_modules client/dist server/dist
git remote add origin https://github.com/OWNER/REPO.git
git remote -v
git push -u origin main
```

`git remote -v`에 새 저장소 주소가 맞게 나오면 업로드합니다. 인증 창이 뜨면 본인 GitHub 계정으로 로그인합니다. 공개된 저장소에서 README와 소스가 보이는지 확인하고, 비밀 파일이나 `data/`가 보이지 않는지 다시 확인하세요. 이후 코드를 수정했다면 `git add .`, `git commit -m "Describe change"`, `git push` 순서로 올립니다. [기존 코드를 GitHub에 올리는 공식 안내](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)
