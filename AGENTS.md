# 개발 에이전트 작업 규칙

이 파일은 구현 저장소 루트에 적용되는 개발 지침이다. P1~P4 로컬 구현, P5 위치 공유·가상 위치도, P6 로컬 기능과 staging D1/Worker 배포가 있다. Staging D1 backend는 `production`이며 region은 APAC이고 16개 migration이 적용됐다. 학교·정책 설정이 미확정이라 staging API는 503으로 닫혀 있다. 실제 계정 플랜, 복구/보관·로그 보존 정책, 지도 공급자·위치 정책·모바일 실기기와 운영 설정은 남아 있다. 작업 전 Roadmap의 최신 완료 상태와 실제 코드를 함께 확인한다. 기존 지침과 사용자 지시의 적용 범위를 먼저 확인한다.

## 1. 읽는 순서와 작업 원칙

1. [Project.md](Project.md): 목표·기능·기본값·미확정 사항.
2. [Architecture.md](Architecture.md): 데이터·권한·매칭·상태·API 계약.
3. [Roadmap.md](Roadmap.md): 의존성에 따라 아직 완료되지 않은 가장 앞 단계를 선택.
4. 변경할 코드와 관련 테스트·설정 파일을 읽고 작은 단위로 구현.

사용자 지시를 우선한다. 문서가 충돌하면 제품 동작은 Project, 기술 계약은 Architecture를 기준으로 원인을 확인하고 관련 문서를 함께 고친다. 확인되지 않은 학교 규칙·비밀값·배포 ID를 만들어 넣지 않는다. 필수 설정이 없어도 가상 데이터·로컬 구현은 계속하며 실제 계정·학생의 접근만 열지 않는다.

완료되지 않은 기능을 UI 목업이나 성공 응답만으로 완료 처리하지 않는다. 화면→Worker→D1→권한 검증까지 작동하는 흐름을 기준으로 작업한다.

## 2. 기술 기준

- TypeScript strict, React + Vite, Hono 기반 Worker API, Zod 입력 검증을 기본으로 한다.
- 배포는 Cloudflare Workers Static Assets와 API Worker, DB는 Cloudflare D1이다.
- 하나의 저장소·하나의 배포 Worker로 시작한다. 브라우저는 `/api/v1/*`를 같은 origin으로 호출한다.
- DB 변경은 `migrations/*.sql`로만 관리한다. SQLite/D1 호환 SQL과 바인딩된 prepared statement를 사용한다.
- Google 로그인은 OIDC Authorization Code 흐름을 검증된 라이브러리로 구현한다. 필요한 경우 PKCE 지원과 검증을 공급자 문서로 확인한다. JWT 서명·OAuth·암호화 알고리즘을 직접 구현하지 않는다.
- Worker 런타임의 Web Crypto·fetch 호환성을 확인한다. 임의로 Node.js 전용 서버 의존성을 추가하지 않는다.
- 의존성 버전·Wrangler·지도 SDK를 선정할 때 공식 문서를 확인하고 lockfile로 고정한다. 문서의 추천 라이브러리는 실제 설치된 버전이 아니다.
- KV, Durable Objects, Queues, R2, Supabase, Firebase, 별도 상시 서버는 MVP 필수 구성으로 추가하지 않는다. 필요해지면 이유·비용·대안을 Architecture에 제안한다.

## 3. 구현 금지 사항

- 이메일 문자열 끝부분 검사만으로 학교 계정·학생임을 인정하지 않는다.
- Google 표시 이름이나 메일 local-part의 학과 문자열을 신뢰 가능한 학적 원장으로 취급하지 않는다.
- 성별·학과·운영자 여부·요청자 ID를 클라이언트 입력만으로 신뢰하지 않는다.
- 성별 조건을 몰래 완화하거나 미공개 성별을 추정하지 않는다.
- GPS 좌표로 실제 탑승을 자동 확정하거나 정밀 위치를 전체 사용자에게 공개하지 않는다.
- 브라우저의 백그라운드 추적·항상 정확한 위치를 보장하지 않는다.
- Worker 전역 변수·메모리·타이머를 전역 잠금, 상태 저장, 영속 작업 큐로 사용하지 않는다.
- 좌석 조회 후 별개 쿼리로 무조건 수락하는 코드를 만들지 않는다.
- `db.batch()` 안의 UPDATE가 0건이어도 실패한다고 가정하지 않는다. 조건 실패를 DB 예외나 명시적인 검증으로 처리한다.
- D1에서 임의의 `BEGIN`/`COMMIT`과 여러 `await` 사이의 대화형 트랜잭션이 된다고 가정하지 않는다.
- 운영 비밀키·학교 이메일 원문·좌표·OAuth 코드/토큰·탑승 코드를 로그나 Git에 남기지 않는다.
- 테스트 통과를 위해 자격·권한·성별·좌석 검증을 우회하지 않는다.

## 4. 인증과 권한

서버에서 Google ID 토큰의 서명·발급자·대상·만료·nonce와 `email_verified`, 허용된 `hd` 및 정확한 학교 이메일 도메인을 확인한다. `sub`를 외부 계정의 고유키로 사용한다. OAuth state는 요청 브라우저와 연결하고 한 번만 사용한다.

세션은 충분히 무작위인 opaque 토큰으로 발급한다. D1에는 토큰 해시만 저장하고 운영 쿠키에는 `HttpOnly; Secure; SameSite=Lax; Path=/`를 지정한다. `__Host-` 접두사는 HTTPS 환경에서만 사용하고 localhost 개발 예외를 운영에 가져오지 않는다. JWT/localStorage 기반 로그인 상태로 임의 전환하지 않는다.

상태 변경 API는 정확한 Origin 검증과 CSRF 토큰을 사용한다. OAuth callback은 별도의 state 검증으로 처리한다. 모든 요청에서 계정 정지·학생 자격 만료·동의 상태를 확인한다. 리소스 소유권은 매번 DB 관계로 검증하고 URL의 ID를 아는 것만으로 권한을 부여하지 않는다.

개발 인증 대역은 로컬에만 허용한다. 운영 환경에서 켜질 수 없는 코드 경로·설정 검사·배포 검증을 갖춘다. staging에서 실제 Google 로그인을 시험하고, 임의 사용자를 만드는 HTTP API를 공개하지 않는다.

## 5. 데이터와 매칭 불변식

반드시 DB 제약·조건부 갱신·트랜잭션으로 지켜야 한다.

1. 한 사용자는 활성 운전자 잠금 또는 활성 탑승 요청 잠금 하나만 보유한다.
2. 하나의 운행에서 `ACCEPTED`+`BOARDED` 수는 탑승 가능 좌석 수를 넘지 않는다.
3. `REQUESTED`는 좌석을 차지하지 않는다. 수락이 좌석 확보 시점이다.
4. 수락 시 필수 조건과 전체 동승자 간 성별 조건을 최신 상태에서 재검증한다.
5. 취소·거절·만료·완료·중단은 관련 잠금과 위치 접근 권한을 일관되게 해제한다.
6. 만료 시각은 서버 시간으로 비교한다. 정리 Cron이 지연되어도 만료된 요청을 수락하지 못한다.
7. 운행/요청 상태 전이는 Architecture의 표를 따른다. 서버에 없는 전이를 UI에서 만들지 않는다.
8. 활동 중 성별·학과는 바꿀 수 없다. 요청·운행의 매칭 조건 스냅샷을 사용한다.
9. 사용자의 차단은 양방향 매칭 제외로 적용하고 현재 진행 중 관계도 정해진 취소/중단 정책에 따라 처리한다.
10. 최신 위치의 행이 남아 있어도 권한·동의·상태·TTL을 통과하지 못하면 반환하지 않는다.

매칭 로직은 `matching/eligibility.ts`, `matching/rank.ts` 같은 순수 함수로 분리한다. DB 쿼리가 구현하는 최종 수락 조건과 함수의 조건이 어긋나지 않도록 계약 테스트를 둔다. 클라이언트 정렬만으로 같은 학과 우선을 구현하지 않는다.

## 6. API·오류·동시성

- `/api/v1` 버전과 Architecture의 요청/응답 계약을 따른다.
- 입력의 길이·범위·열거값을 검증한다. 대량 입력·무제한 조회·무제한 위치 업로드를 허용하지 않는다.
- 운행 생성·탑승 요청·수락/취소/출발/완료는 `Idempotency-Key`를 받는다.
- 키는 `(user_id, operation, key)` 범위에서 유일하고 본문 해시를 연결한다. 다른 본문으로 재사용하면 409다.
- 응답 캐시 재전송 전에 현재 권한을 확인한다. 좌표·차량 정보·탑승 코드 등 제한 정보는 멱등 응답에 저장하지 않는다.
- 조건부 UPDATE 0건과 DB 제약 오류를 구분해 409 등 일관된 도메인 오류로 변환한다. 내부 SQL은 응답에 넣지 않는다.
- 위치·세션·프로필 응답은 `Cache-Control: no-store`로 보낸다. 공유 CDN 캐시나 Service Worker에 저장하지 않는다.
- 파일럿부터 계정별 요청·위치 업로드 한도를 서버에서 강제한다. 구체적인 초기값과 실패 동작은 Architecture를 따른다.

## 7. 권장 디렉터리

```text
/
  Project.md
  AGENTS.md
  Architecture.md
  Roadmap.md
  src/
    web/                 # 화면, GPS, 지도 어댑터, API 클라이언트
    worker/
      index.ts           # fetch / scheduled 진입점
      routes/            # auth, me, trips, requests, locations, moderation
      services/          # 수락·취소·학생 확인 등 유스케이스
      repositories/      # D1 SQL과 DTO 변환
      matching/          # 자격·성별 조건·학과 정렬
      auth/              # OIDC, 세션, CSRF, 권한
      jobs/              # 만료·현재 위치·보관 정리
    shared/              # DTO, Zod, 열거값. 서버 비밀값 없음
  migrations/
  tests/                 # unit / integration / e2e
  scripts/               # 가상 seed, 설정 검증, 운영 절차 보조
  wrangler.jsonc
  package.json
  package-lock.json
  .dev.vars.example
```

## 8. 개발 명령 계약

다음 npm scripts는 구현 저장소에서 사용한다. `deploy:staging`은 확인된 staging D1과 학교 준비/개발 로그인 차단 설정으로 배포한다. `deploy:production`은 출시 조건 충족 전까지 실패 종료한다. 실행 절차는 Architecture §14를 따른다.

| 명령 | 의미 |
| --- | --- |
| `npm ci` | lockfile 기준 설치 |
| `npm run dev` | 프런트 + 로컬 Worker/D1 개발 |
| `npm run db:migrate:local` | 로컬 D1에 migration 적용 |
| `npm run db:migrate:staging` | staging D1에 migration 적용. 합성 seed는 실행하지 않음 |
| `npm run db:seed:local` | 합성 학교·사용자·운행 생성 |
| `npm run db:reset:local` | 개발 서버 중지 후 로컬 D1만 삭제·migration·seed 재적용 |
| `npm run lint` | 정적 검사 |
| `npm run typecheck` | 웹·Worker·공유 타입 검사 |
| `npm run test:unit` | 매칭·파싱·상태·권한 단위 테스트 |
| `npm run test:integration` | 실제 Workers 테스트 런타임 + 로컬 D1 |
| `npm run test:e2e` | Playwright 사용자 흐름 |
| `npm run build` | 프런트·Worker 빌드 |
| `npm run deploy:staging` | staging DB/설정 검증 후 배포 |
| `npm run deploy:production` | 출시 조건 충족 및 배포 권한이 있을 때 실행 |

## 9. 검증 기준

데이터·권한·매칭·상태 변경에는 관련 단위/통합 테스트를 추가한다. 단순 문구·스타일 수정에는 구현을 복제하는 테스트를 만들지 않는다. 필요한 검증이 끝나면 근거 없이 반복하지 않는다.

핵심 회귀 항목은 Project의 AC-01~AC-11과 Roadmap의 단계별 완료 기준이다. 특히 다음은 필수다.

- 마지막 좌석 경쟁, 같은 사용자 동시 요청, 수락과 취소/차단의 경쟁, 실패 시 전체 롤백.
- 멱등키 재시도·본문 충돌·처리 직후 연결 끊김.
- 실제 D1 런타임에서 trigger·부분 unique index·batch 롤백 동작 검증. 일반 SQLite 테스트만으로 대체하지 않음.
- OAuth 위조·nonce 재사용·비학교 조직·교직원/만료 학생·정지 계정.
- 위치 권한 거절·오차·만료·취소 후 조회·다른 승객 좌표 접근 차단.
- Android Chrome·iOS Safari 실기기의 권한, 화면 전환, 잠금, 통신 복구.

## 10. 보안·운영·보고

Google client secret, Cloudflare 배포 토큰, CSRF/탑승 코드/선택적 rate-limit HMAC 키는 Wrangler Secrets나 CI 비밀 저장소에 둔다. 세션 토큰은 별도 서명 없이 무작위 opaque 값으로 발급하고 해시만 저장한다. 공개 가능한 client ID·지도 브라우저 키는 역할을 구분하되 도메인 제한을 설정한다. `.dev.vars`와 실제 운영 데이터는 커밋하지 않는다.

구조 변경 시 migration·API 계약·아키텍처·관련 테스트를 함께 수정한다. 운영 DB에는 먼저 staging에서 검증한 migration만 적용한다. 파괴적 변경은 백업·복구·사용자 영향 검토를 갖추고 실행 권한을 확인한다. 작은 구현 결정마다 불필요하게 승인을 요청하지 않는다.

완료 보고에는 변경 동작, 검증 명령과 결과, 남은 설정/제약, 수정한 문서를 짧게 적는다. 실행하지 못한 검증은 사유를 적고 통과했다고 쓰지 않는다. Roadmap 체크박스는 해당 완료 기준을 실제로 만족했을 때만 바꾼다.
