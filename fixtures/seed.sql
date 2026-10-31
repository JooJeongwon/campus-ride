-- 로컬 합성 데이터 전용. 세 승차 지점 좌표는 사용자가 제공한 Plus Code 셀의 중심이며 현장 안전/운영 승인을 뜻하지 않는다. 가상 지점 좌표는 placeholder다.
INSERT OR IGNORE INTO departments (id,school_id,code,name,aliases_json) VALUES ('10000000-0000-4000-8000-000000000001','synthetic-school','CS','가상 컴퓨터학과','["cs","computing"]'),('10000000-0000-4000-8000-000000000002','synthetic-school','DESIGN','가상 디자인학과','["design"]');
INSERT OR IGNORE INTO users (id,google_sub,school_id,campus_id,email,nickname,department_id,department_status,department_source,parser_version,gender,affiliation_status,verified_until,created_at,updated_at) VALUES ('20000000-0000-4000-8000-000000000001','synthetic-driver','synthetic-school','synthetic-campus','student-001-cs@students.example.invalid','가상 운전자','10000000-0000-4000-8000-000000000001','VERIFIED','DIRECTORY','synthetic-v1','WOMAN','VERIFIED',(unixepoch()+86400)*1000,unixepoch()*1000,unixepoch()*1000),('20000000-0000-4000-8000-000000000002','synthetic-rider','synthetic-school','synthetic-campus','student-002-cs@students.example.invalid','가상 탑승자','10000000-0000-4000-8000-000000000001','VERIFIED','DIRECTORY','synthetic-v1','WOMAN','VERIFIED',(unixepoch()+86400)*1000,unixepoch()*1000,unixepoch()*1000),('20000000-0000-4000-8000-000000000003','synthetic-pending','synthetic-school','synthetic-campus','student-003-design@students.example.invalid','가상 확인 대기','10000000-0000-4000-8000-000000000002','UNVERIFIED','EMAIL_LOCAL_PART','synthetic-v1','UNDISCLOSED','PENDING',NULL,unixepoch()*1000,unixepoch()*1000);
-- 로컬 E2E가 반복 실행되어도 두 합성 학생과 운전자 차량의 자격이 만료되지 않도록 갱신한다.
UPDATE users SET affiliation_status='VERIFIED',verified_until=(unixepoch()+86400)*1000
WHERE id IN ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002');
INSERT OR IGNORE INTO users (id,google_sub,school_id,campus_id,email,nickname,gender,affiliation_status,created_at,updated_at,role) VALUES ('20000000-0000-4000-8000-000000000004','synthetic-admin','synthetic-school','synthetic-campus','admin@example.invalid','가상 운영자','UNDISCLOSED','PENDING',unixepoch()*1000,unixepoch()*1000,'ADMIN');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000004','STOP_CREATED','stop','30000000-0000-4000-8000-000000000001','{"name":"가상 교문","kind":"GATE","lat":0,"lng":0,"active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM stops WHERE id='30000000-0000-4000-8000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000001');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000004','STOP_CREATED','stop','30000000-0000-4000-8000-000000000002','{"name":"가상 캠퍼스","kind":"DESTINATION","lat":0.001,"lng":0.001,"active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM stops WHERE id='30000000-0000-4000-8000-000000000002')
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000002');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004','STOP_CREATED','stop','30000000-0000-4000-8000-000000000003','{"name":"AI공학관","kind":"GATE","lat":0,"lng":0,"active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM stops WHERE id='30000000-0000-4000-8000-000000000003')
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000004');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000004','STOP_CREATED','stop','30000000-0000-4000-8000-000000000004','{"name":"중앙도서관","kind":"GATE","lat":0,"lng":0,"active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM stops WHERE id='30000000-0000-4000-8000-000000000004')
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000005');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000004','STOP_CREATED','stop','30000000-0000-4000-8000-000000000005','{"name":"반도체대학","kind":"GATE","lat":0,"lng":0,"active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM stops WHERE id='30000000-0000-4000-8000-000000000005')
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000006');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000004','STOP_UPDATED','stop','30000000-0000-4000-8000-000000000003','{"name":"AI공학관","kind":"GATE","lat":37.4554875,"lng":127.134546875,"active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000020');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000021','20000000-0000-4000-8000-000000000004','STOP_UPDATED','stop','30000000-0000-4000-8000-000000000004','{"name":"중앙도서관","kind":"GATE","lat":37.4525125,"lng":127.132390625,"active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000021');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000022','20000000-0000-4000-8000-000000000004','STOP_UPDATED','stop','30000000-0000-4000-8000-000000000005','{"name":"반도체대학","kind":"GATE","lat":37.4514375,"lng":127.127421875,"active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000022');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000004','ROUTE_CREATED','route','40000000-0000-4000-8000-000000000001','{"originStopId":"30000000-0000-4000-8000-000000000001","destinationStopId":"30000000-0000-4000-8000-000000000002","active":false}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM routes WHERE id='40000000-0000-4000-8000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000003');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000004','ROUTE_CREATED','route','40000000-0000-4000-8000-000000000002','{"originStopId":"30000000-0000-4000-8000-000000000003","destinationStopId":"30000000-0000-4000-8000-000000000002","active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM routes WHERE id='40000000-0000-4000-8000-000000000002')
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000007');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000004','ROUTE_CREATED','route','40000000-0000-4000-8000-000000000003','{"originStopId":"30000000-0000-4000-8000-000000000004","destinationStopId":"30000000-0000-4000-8000-000000000002","active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM routes WHERE id='40000000-0000-4000-8000-000000000003')
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000008');
INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
SELECT '60000000-0000-4000-8000-000000000009','20000000-0000-4000-8000-000000000004','ROUTE_CREATED','route','40000000-0000-4000-8000-000000000004','{"originStopId":"30000000-0000-4000-8000-000000000005","destinationStopId":"30000000-0000-4000-8000-000000000002","active":true}',unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM routes WHERE id='40000000-0000-4000-8000-000000000004')
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='60000000-0000-4000-8000-000000000009');
INSERT OR IGNORE INTO driver_profiles (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at) VALUES ('20000000-0000-4000-8000-000000000001','가상 차량','초록','SYNTHETIC-ONLY',2,'VERIFIED',(unixepoch()+86400)*1000,unixepoch()*1000);
UPDATE driver_profiles SET verification_status='VERIFIED',verified_until=(unixepoch()+86400)*1000,checked_at=unixepoch()*1000
WHERE user_id='20000000-0000-4000-8000-000000000001';
INSERT INTO trips (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,department_id_snapshot,department_verified_snapshot,prefer_same_department,created_at)
SELECT '50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',(unixepoch()+600)*1000,(unixepoch()+1500)*1000,2,'WOMAN','ANY','10000000-0000-4000-8000-000000000001',1,1,unixepoch()*1000
WHERE NOT EXISTS (SELECT 1 FROM trips WHERE id='50000000-0000-4000-8000-000000000001');
