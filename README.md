# OK Plan Tools

OfficeKeeper 기획 도구 모음입니다. **Netlify 정적 사이트 + 서버리스 함수**로 호스팅하며, 상태는 사용자 브라우저(localStorage)에 저장합니다(서버 DB 없음).

현재 도구:

- **Figma Comment Tracker** (`/figma-comment-tracker/`) — Figma 댓글을 가져와 검토 상태(미확인/확인됨), 책갈피, 답글 없음·Figma 미해결 현황을 추적하고 위치 미리보기·답글·XLSX 추출을 제공.

## 구조

```
public/
  index.html                       # 도구 허브 랜딩
  figma-comment-tracker/index.html # 앱 (데이터는 localStorage)
netlify/functions/
  fct-me.js     # 토큰 검증 프록시
  fct-fetch.js  # 댓글 + 파일메타(+필요시 트리) 프록시
  fct-image.js  # 영역 이미지 렌더 프록시
  fct-reply.js  # 답글 작성 프록시
netlify.toml    # publish=public, functions=netlify/functions
```

함수는 **상태가 없는 Figma 프록시**입니다(브라우저가 CORS로 Figma를 직접 못 부르므로). 토큰은 요청마다 전달만 하고 서버에 저장하지 않습니다.

## 로컬 개발

```bash
npx netlify dev
```

→ 정적 사이트와 함수가 함께 로컬에서 동작합니다. `http://localhost:8888/figma-comment-tracker/` 접속.

> Node.js 18+ 필요. (전역 `fetch` 사용, 별도 의존성 없음)

## 배포 (Netlify)

1. 이 repo를 GitHub에 push
2. Netlify → Add new site → Import from Git → repo 선택 (`netlify.toml`이 설정 자동 인식)
3. 사이트 이름을 `okplan-tools`로 변경 → `https://okplan-tools.netlify.app/figma-comment-tracker/`

## 사용자 Figma 토큰 (각 브라우저 1회)

⚙ 설정에서 Personal Access Token(`figd_...`) 입력. 발급: Figma 프로필 → Settings → Security → Personal access tokens.

- **File comments** (필수, 답글 작성 시 쓰기 권한)
- **File content: Read-only** (노드 이름 + 위치 미리보기 이미지)

토큰·검토상태·이력·파일목록은 **해당 브라우저 localStorage**에만 저장됩니다(사용자/브라우저별).

## 알아둘 제약

- Figma API로 댓글의 resolved 상태를 변경할 수 없어(읽기 전용), 검토 상태는 이 도구가 별도로 관리합니다.
- Figma 해결/재오픈 과거 이력은 API로 제공되지 않아, 새로고침 간 비교(diff)로 감지합니다.
- 큰 파일은 함수 타임아웃을 피하려고 구조(노드맵)를 `lastModified` 기준 localStorage에 캐시해 첫 1회만 트리를 가져옵니다.
- 위치 미리보기 이미지는 Figma rate limit 때문에 펼칠 때 한 건씩 지연 로딩합니다.
