import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { environmentSchema } from '../../src/worker/env';

const local = { APP_ENV: 'development', APP_ORIGIN: 'http://localhost:8787', SCHOOL_CONFIG_READY: 'false', ALLOW_DEV_AUTH: 'false' };

it('allows local development auth on localhost and blocks remote auth bypass', () => {
  expect(environmentSchema.safeParse(local).success).toBe(true);
  expect(environmentSchema.safeParse({ ...local, ALLOW_DEV_AUTH: 'true' }).success).toBe(true);
  for (const value of [
    { ...local, APP_ORIGIN: 'http://school.example' },
    { ...local, APP_ORIGIN: 'http://localhost:8787/path' },
    { ...local, APP_ORIGIN: 'http://name:password@localhost:8787' },
    { ...local, APP_ENV: 'staging' },
    { ...local, APP_ENV: 'production', SCHOOL_CONFIG_READY: 'true' },
    {},
  ]) expect(environmentSchema.safeParse(value).success).toBe(false);

  const remote = {
    APP_ENV: 'staging', APP_ORIGIN: 'https://ride.school.edu', SCHOOL_CONFIG_READY: 'true', ALLOW_DEV_AUTH: 'true',
    SCHOOL_ID: 'school-1', CAMPUS_ID: 'campus-1',
    ALLOWED_EMAIL_DOMAINS: 'gachon.ac.kr', ALLOWED_HOSTED_DOMAINS: 'students.school.edu',
    STUDENT_VERIFICATION_MODE: 'MANUAL_REVIEW', DEPARTMENT_SOURCE_FIELD: 'EMAIL_LOCAL_PART',
    DEPARTMENT_TEMPLATE: 'student-{id}-{department}', DEPARTMENT_PARSER_VERSION: 'school-v1',
    DEPARTMENT_ALIASES_JSON: '{"cs":"CS"}', GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'school-secret', CSRF_HMAC_KEY: 'a'.repeat(32), BOARDING_HMAC_KEY: 'b'.repeat(32),
    POLICY_TERMS_VERSION: 'terms-v1', POLICY_TERMS_URL: 'https://ride.school.edu/terms',
    POLICY_PRIVACY_VERSION: 'privacy-v1', POLICY_PRIVACY_URL: 'https://ride.school.edu/privacy',
    POLICY_LOCATION_COLLECTION_VERSION: 'location-collection-v1',
    POLICY_LOCATION_COLLECTION_URL: 'https://ride.school.edu/location-collection',
    POLICY_LOCATION_SHARING_VERSION: 'location-sharing-v1',
    POLICY_LOCATION_SHARING_URL: 'https://ride.school.edu/location-sharing',
  };
  expect(environmentSchema.safeParse(remote).success).toBe(false);
  expect(environmentSchema.safeParse({ ...remote, ALLOW_DEV_AUTH: 'false' }).success).toBe(true);
  expect(environmentSchema.safeParse({ ...remote, ALLOW_DEV_AUTH: 'false', ALLOWED_EMAIL_DOMAINS: 'students.school.edu' }).success).toBe(false);
  expect(environmentSchema.safeParse({ ...remote, ALLOW_DEV_AUTH: 'false', ALLOWED_EMAIL_DOMAINS: 'gachon.ac.kr,other.school.edu' }).success).toBe(false);
  expect(environmentSchema.safeParse({ ...remote, POLICY_LOCATION_SHARING_URL: undefined }).success).toBe(false);
});

it('requires paired HTTPS policy metadata and rejects placeholder links', () => {
  const policy = {
    ...local,
    POLICY_TERMS_VERSION: 'terms-v1',
    POLICY_TERMS_URL: 'https://policy.school.edu/terms',
    POLICY_PRIVACY_VERSION: 'privacy-v1',
    POLICY_PRIVACY_URL: 'https://policy.school.edu/privacy',
  };
  expect(environmentSchema.safeParse(policy).success).toBe(true);
  for (const value of [
    { ...policy, POLICY_TERMS_URL: undefined },
    { ...policy, POLICY_TERMS_URL: 'http://policy.school.edu/terms' },
    { ...policy, POLICY_PRIVACY_URL: 'https://policy.invalid/privacy' },
    { ...policy, POLICY_PRIVACY_VERSION: 'bad version' },
  ]) expect(environmentSchema.safeParse(value).success).toBe(false);
});

it('blocks production deployment before any remote call', () => {
  const result = spawnSync(process.execPath, ['scripts/check-deploy.mjs', 'production'], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('배포 차단');
});

it('does not accept remote flags in the local seed helper', () => {
  const result = spawnSync(process.execPath, ['scripts/local-db.mjs', 'seed', '--remote'], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Usage:');
});
