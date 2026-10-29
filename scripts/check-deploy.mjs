import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';

const environment = process.argv[2];
if (!['staging', 'production'].includes(environment) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/check-deploy.mjs staging|production');
}

if (environment === 'production') {
  console.error('production 배포 차단: 학교·정책·운영 검토와 출시 검증이 미완료입니다. Roadmap.md를 확인하세요.');
  process.exitCode = 1;
} else {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const staging = config.env?.staging;
  const database = staging?.d1_databases?.find((binding) => binding.binding === 'DB');
  const validDatabase = database?.database_name === 'campus-ride-staging'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(database.database_id)
    && database.migrations_dir === 'migrations';
  const appOrigin = new URL(staging?.vars?.APP_ORIGIN ?? 'https://invalid');
  const validOrigin = appOrigin.origin === staging?.vars?.APP_ORIGIN
    && appOrigin.hostname.startsWith(`${staging?.name}.`) && appOrigin.hostname.endsWith('.workers.dev');
  if (!validDatabase || !validOrigin || staging?.workers_dev !== true || staging?.preview_urls !== false
    || staging?.vars?.APP_ENV !== 'staging' || staging?.vars?.SCHOOL_CONFIG_READY !== 'false'
    || staging?.vars?.ALLOW_DEV_AUTH !== 'false' || staging?.vars?.STAGING_AUTH_TEST_ONLY !== 'true'
    || staging?.vars?.SCHOOL_ID !== 'gachon-university' || staging?.vars?.CAMPUS_ID !== 'gachon-global-campus'
    || staging?.vars?.ALLOWED_EMAIL_DOMAINS !== 'gachon.ac.kr' || staging?.vars?.ALLOWED_HOSTED_DOMAINS !== 'gachon.ac.kr'
    || staging?.vars?.STUDENT_VERIFICATION_MODE !== 'SCHOOL_ASSERTION') {
    console.error('staging 배포 차단: Gachon 로그인 검증 전용이며 일반 API가 닫힌 설정이어야 합니다.');
    process.exitCode = 1;
  } else {
    const env = {
      ...process.env,
      CLOUDFLARE_ENV: 'staging',
      VITE_STAGING_AUTH_TEST_ONLY: 'true',
      VITE_NAVER_MAP_CLIENT_ID: process.env.VITE_NAVER_MAP_CLIENT_ID ?? '',
    };
    const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', env });
    if (build.status !== 0) {
      process.exitCode = build.status ?? 1;
    } else {
      const deploy = spawnSync('npx', ['wrangler', 'deploy'], { stdio: 'inherit', env });
      process.exitCode = deploy.status ?? 1;
    }
  }
}
