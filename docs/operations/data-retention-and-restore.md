# 데이터 보유·탈퇴·D1 복구 절차

> **현행 법령·제공자 공개자료 대조 운영 초안 v1.2 · 미시행.** 일반 API와 위치 공유는 현재 닫혀 있다. 사용자가 MVP에서 학교 승인·위임 및 위치사업 분류 검토를 보류했다. 삭제·철회 외부 대조부, Cloudflare 권한 접근대장, 복구 훈련이 없고 D1 백업의 사용자별 파기 여부도 미확정이다. 이 문서만으로 위치정보법·개인정보 보호법상 파기 요건을 충족했다고 보지 않는다.

- 결정 기준일: 2026-10-29
- 예정 운영주체(사용자 지정): 가천대학교 / 운영팀 고범규, 김동규, 남성수, 주정원, 최익준. 학교 공식 승인·위임 및 개인별 시스템 권한은 MVP에서 보류됐으며 실제 권한은 확인되지 않음
- 서비스 문의·권리 요청: `jwjoo0512@gmail.com`
- 가천대학교 글로벌캠퍼스 주소/대표전화: (13120) 경기도 성남시 수정구 성남대로 1342 / 031-750-5114
- 가천대학교 공식 개인정보보호팀 연락처: 031-750-5060 / `privacy@gachon.ac.kr` (본 서비스 담당 지정은 미확인)
- 현재 대상 DB: `campus-ride-staging` (`production` backend)
- 현재 확인된 복구 창: Workers Free D1 Time Travel 최대 7일
- 운영 대상 DB: production D1은 아직 생성하지 않음

## 1. 보유기간과 정리 주기

| 정보 | 온라인 보유기간 |
| --- | --- |
| 최신 위치 | 서버 수신 후 60초 동안만 반환. 관계 종료·동의 철회·탈퇴 시 삭제. 만료 행은 5분 Cron으로 정리 |
| 위치 수집·이용·제공사실 확인자료 | 위치정보법 적용 시 자동 기록 후 원칙적으로 최소 6개월 보관. 관련 동의 철회 시 철회 범위 자료를 지체 없이 파기 |
| 위치 API 접근기록 | 좌표 없이 최대 1년. 로그에 위치 소유자가 연결되며, 해당 소유자의 동의 철회/탈퇴 시 그 사람 위치에 연결된 로그를 즉시 삭제. 다른 사람 위치 조회 기록은 보안 목적으로 1년 보관 |
| 철회된 동의 | 철회 후 1년 |
| 종료된 운행·요청 | 종료 후 180일. 연결된 신고가 남아 있으면 신고 종결 후 1년까지 보관 |
| 신고 | 미종결 상태 동안, 종결 후 1년 |
| 일반 감사기록 | 1년. 현재 제한·신고·차단·운영 설정을 설명하는 최신 참조 이벤트는 그 상태가 끝나거나 교체될 때까지 유지 |
| 탈퇴 계정 식별표식 | 탈퇴 이벤트 후 최소 1년. 신고·운행·요청·기록 연결이 남아 있으면 연결 자료가 정리될 때까지 유지한 뒤 삭제 |
| D1 Time Travel | 온라인 보유기간과 별개. 현재 무료 플랜 최대 7일 동안 삭제 이전 상태가 복원될 수 있음 |

Cloudflare D1 Time Travel 복구는 데이터베이스 전체를 과거 시점으로 덮어씁니다. 탈퇴·동의 철회 후 행이 삭제되어도 복구 창에서는 예전 값이 되살아날 수 있습니다. 만료 위치는 API가 먼저 차단하며 실제 D1 행은 Cron에서 지워집니다. Cron은 5분마다 실행되고 각 정리 단계는 제한된 행 수로 처리됩니다. 실패/적체가 있으면 물리 파기가 늦어질 수 있으므로 `scheduled_cleanup` 실패/지연 로그를 확인합니다.

위치정보법 적용 시 법 제24조는 동의 철회 범위의 개인위치정보와 수집·이용·제공사실 확인자료를 지체 없이 파기하도록 합니다. 개인정보 보호법 제21조는 파기 후 복구·재생 방지를 요구합니다. D1 외부 대조부를 복구 후 재적용하는 절차는 백업 사본 자체를 지우지 않으므로 단독으로 파기 요건을 충족한다고 보지 않습니다. 위치자료 백업이 있는 동안 이 기준을 만족할 처리방식이 확정되지 않으면 위치 기능과 일반 API를 계속 닫습니다.

## 2. 탈퇴 처리

1. 이용자는 최근 5분 안에 인증된 세션과 CSRF 검증을 거쳐 설정 화면에서 탈퇴를 요청합니다.
2. 서버는 `USER_DELETED` 감사 이벤트를 생성합니다. D1 trigger가 직접 계정 식별값을 대체하고, 프로필·차량 정보와 학생 확인 자료를 초기화/삭제하며 세션, 멱등 기록, 최신 위치, 차단 관계와 본인 위치 제공·통지 확인자료를 제거하고 남은 동의를 철회합니다. 본인 위치 소유자에 연결된 접근기록도 제거합니다. 진행 중 요청·운행은 종료합니다.
3. 이용자 화면에서는 즉시 로그아웃합니다. 이력이 연결된 신고/운행/동의, 그리고 다른 이용자의 위치를 조회한 보안기록은 위 기간 동안 남을 수 있습니다. 탈퇴는 즉시 모든 이력을 익명화하거나 모든 백업 사본을 수정하지 않습니다.
4. 운영자가 지정한 암호화 외부 보관소에 최소한의 탈퇴 기록(내부 user UUID, `USER_DELETED` 시각, D1 밖에 저장된 복구 식별키)을 기록합니다. 이메일, `sub`, 닉네임, 좌표, OAuth 자료는 외부 보관소에 복사하지 않습니다.
5. 보관소의 계정 UUID 기록은 8일 후 파기합니다. 단, 7일 복구 창 안에서 DB를 복원해 삭제를 재적용한 경우에는 재적용 시각부터 다시 8일 보관합니다.

**현재 4번은 자동화되어 있지 않습니다.** 일반 API를 열기 전 운영 보관소와 삭제 이벤트 등록 책임자·정기 대조 방법을 실제로 만들어야 합니다. 사용자의 계정 UUID를 삭제 시점에 외부에 보존하는 경로가 없으면 복구 후 삭제를 보장할 수 없습니다. 이 조건이 준비될 때까지 서비스 개방을 차단합니다.

위치 동의 철회도 같은 외부 보관소에 user UUID, 위치 동의 종류, 철회 시각만 기록해 복구 후 다시 철회해야 합니다. 온라인 D1은 본인 최신 좌표, 본인 위치 제공·통지 확인자료, 본인 위치 소유자 접근기록과 알림 presence를 즉시 지웁니다. 외부 기록은 8일 후 삭제합니다. 추가 식별정보나 좌표는 남기지 않습니다.

## 3. 복구 전 확인

복구는 데이터가 손상되었거나 잘못 변경된 사건에서만 수행합니다. 다음 순서를 지킵니다.

1. 장애 담당자는 외부 유입을 차단하고 `SCHOOL_CONFIG_READY=false`, `STAGING_AUTH_TEST_ONLY=true`를 유지합니다. 일반 API·계정 생성이 503 차단인지 확인합니다. production DB는 아직 없습니다.
2. 암호화 외부 보관소에서 복구 창(최근 7일) 안의 탈퇴·위치 동의 철회 기록을 확보합니다. 보관소가 없거나 기간 중 일부가 누락됐으면 복구를 진행하지 않습니다.
3. `npx wrangler d1 time-travel info campus-ride-staging --env staging`으로 현재 bookmark와 복구 후보 시각을 조회합니다. 현재 bookmark와 후보를 사고 기록에 남깁니다. 복원 전에 장애 데이터가 들어오기 전의 가장 최근 정상 bookmark를 선택합니다.
4. 후보 bookmark가 탈퇴·철회 이벤트보다 앞선 시점이면 외부 보관소에 있는 모든 이후 이벤트를 재적용할 수 있는지 대조합니다. 삭제 이벤트가 복구 시점에 이미 반영되어 있으면 중복 재적용하지 않습니다. 하나라도 대조할 수 없으면 복구를 중단하고 개인 정보가 재노출되지 않는 대안을 마련합니다.
5. 복원은 전체 D1을 덮어쓰므로 담당자와 승인자가 bookmark, 대상 DB, 되돌리기 bookmark를 교차 확인합니다. 실행할 때 다음 명령은 staging에 실제 원격 변경을 합니다.

```sh
npx wrangler d1 time-travel restore campus-ride-staging --env staging --bookmark='<선택한 bookmark>'
```

Cloudflare가 반환한 `previous_bookmark`를 별도 보안 사고 기록에 보관합니다. 공식 문서는 복원이 파괴적이며 DB의 모든 데이터를 덮어쓴다고 설명합니다. 복구는 이전 bookmark를 사용해 되돌릴 수 있지만, 되돌리기 전에도 사용자 영향과 삭제 기록을 다시 대조해야 합니다.

## 4. 복구 후 삭제·철회 재적용

1. 최신 migration을 적용합니다. 복구 bookmark가 현재 schema보다 오래됐을 수 있습니다.

```sh
npx wrangler d1 migrations apply campus-ride-staging --remote --env staging
```

2. 외부 보관소의 각 user UUID에 대해, 복원된 사용자 행이 `ACTIVE`일 때만 아래 형식의 `USER_DELETED` 이벤트를 한 번 생성합니다. `<event UUID>`와 `<command UUID>`는 서로 다른 새 UUID여야 합니다. 직접 `users.account_status`나 이메일을 SQL로 수정하지 않습니다. 이벤트 trigger가 연결 데이터 정리를 수행합니다.

```sql
INSERT INTO audit_events
  (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
SELECT '<event UUID>',id,'USER_DELETED','user',id,'<command UUID>','{}',<탈퇴시각_ms>
FROM users
WHERE id='<user UUID>' AND account_status='ACTIVE';
```

3. 복구 bookmark 이후의 위치 동의 철회를 다시 적용합니다. 실제 보관소 기록에 기재된 동의 종류와 시각만 사용합니다.

```sql
UPDATE consents SET revoked_at=<철회시각_ms>
WHERE user_id='<user UUID>' AND kind='<LOCATION_COLLECTION 또는 LOCATION_SHARING>' AND revoked_at IS NULL;
DELETE FROM latest_locations WHERE user_id='<user UUID>';
DELETE FROM location_notice_presence WHERE user_id='<user UUID>';
DELETE FROM location_disclosure_records WHERE owner_user_id='<user UUID>';
DELETE FROM location_access_records WHERE location_owner_user_id='<user UUID>';
```

4. 복구 시점과 무관하게 기존 세션/OAuth 상태와 모든 최신 좌표·알림 presence를 지웁니다. 전체 이용자 로그아웃과 위치 재동의 후 재시작을 요구합니다.

```sql
DELETE FROM sessions;
DELETE FROM oauth_states;
DELETE FROM latest_locations;
DELETE FROM location_notice_presence;
```

5. 감사 로그와 D1 행을 확인합니다. 탈퇴 계정은 `DELETED`이며 `deleted:<UUID>`와 `deleted+<UUID>@example.invalid`가 되어야 합니다. 해당 사용자의 active session, 최신 좌표, 본인 위치 제공 확인자료/owner 접근기록, active lock, 차단 관계가 없어야 합니다. 철회된 위치 동의는 `revoked_at`이 있고 최신 좌표와 해당 사용자의 위치 확인자료가 없어야 합니다. 계정·이메일·UUID·좌표를 일반 로그, CI 출력이나 티켓에 붙이지 않습니다.
6. migrations, 잔여 오류/정리 적체, login/API 차단, 위치 endpoint 거부를 확인합니다. 두 명이 검증 기록을 남기기 전에는 일반 API를 열지 않습니다. OAuth auth-only 테스트는 사용자·세션을 생성하지 않는지 재확인합니다.

## 5. 접근권한 변경 기록

Cloudflare Worker/D1 접근은 실제 업무에 필요한 사람에게 개별 계정으로 최소 권한을 부여해야 하며 공용 계정은 사용하지 않습니다. 사용자 지정 운영팀은 고범규·김동규·남성수·주정원·최익준입니다. MVP에서는 공식 위임·개별 역할·권한 부여를 보류하라는 결정이 있어 현재 누구에게도 이 문서만으로 접근권한을 부여하지 않습니다. 권한을 실제 부여·변경·말소할 때 운영자 계정 식별자, 대상 자원/역할, 변경 구분, 시각, 승인 근거와 검토자를 외부 대장에 기록해야 하며 위치정보 보호조치 기준이 적용되는 경우 법정 보관기간을 따릅니다.

이 대장은 아직 구축/점검되지 않았습니다. Cloudflare 콘솔의 감사 기록을 법정 보관기간만큼 보관한다고 가정하지 않습니다. 별도 권한 결정·위치정보관리책임자·정기 대조가 없고 위치 공유의 즉시 통지 및 동의도 검증되지 않아 원격 위치 API는 활성화하지 않습니다.

## 근거와 한계

[Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)은 Free 플랜 복구 창 7일, Paid 30일이며 production backend에서 사용합니다. [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/) 문서상 jurisdiction 선택지는 EU·FedRAMP·미국뿐이며 DB 생성 시 지정하고 기존 DB에는 나중에 추가할 수 없습니다. APAC location hint는 정확한 국가를 보장하지 않습니다. 기존 staging D1은 직전 기록상 APAC이고 이번 읽기 전용 재조회는 Cloudflare API 인증 오류로 실패했습니다. 따라서 국내 전용 저장을 설정하거나 확인하지 못했으며 기존 설정을 바꾸지 않았습니다. 복구는 DB 전체를 덮어쓰는 작업입니다. 현재 장기 별도 백업/R2 export는 없고 7일 복구 범위를 넘어선 복구를 보장하지 않습니다.

[개인정보 보호법 제21조](https://law.go.kr/LSW/lsLinkCommonInfo.do?lsJoLnkSeq=1029334977) · [위치정보법 제24조](https://law.go.kr/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1029559327) · [위치정보 보호조치 기준](https://www.law.go.kr/admRulLsInfoP.do?admRulSeq=2100000279386)

위치정보법이 적용되는 경우 동의 철회 후 관련 개인위치정보와 수집·이용·제공 확인자료의 파기 의무가 있습니다. D1 Time Travel의 과거 사본을 사용자별로 즉시 삭제할 수 있는지 확인되지 않았으므로, 외부 대조부 복구 절차만으로 이 요건을 충족한다고 단정하지 않습니다. 사업자 분류와 백업 처리 법률 검토가 끝날 때까지 위치 API는 개방하지 않습니다.
