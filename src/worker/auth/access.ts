import { consentPolicies, type Bindings } from '../env';
import { getSession, verifyMutation, type Session } from './session';
import type { AppContext } from '../types';

export async function requiredConsentFailure(c: AppContext, userId: string) {
  if (await hasRequiredConsents(c.env.DB, c.env, userId)) return null;
  return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
}

export async function studentAccessFailure(c: AppContext, session: Session, now?: number) {
  const consentFailure = await requiredConsentFailure(c, session.userId);
  if (consentFailure) return consentFailure;
  if (session.role !== 'STUDENT' || session.affiliationStatus !== 'VERIFIED'
    || (session.verifiedUntil ?? 0) <= (now ?? Date.now())) {
    return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  return null;
}

export async function adminAccessFailure(c: AppContext, session: Session) {
  const consentFailure = await requiredConsentFailure(c, session.userId);
  if (consentFailure) return consentFailure;
  if (session.role !== 'ADMIN') {
    return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
  }
  return null;
}

export async function requireStudentMutation(c: AppContext) {
  const result = await getSession(c);
  if (!result) return { result: null, response: c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401) };
  if (!await verifyMutation(c, result.token, result.session)) return { result: null, response: c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403) };
  const response = await studentAccessFailure(c, result.session);
  if (response) return { result: null, response };
  return { result, response: null };
}

export async function currentConsents(db: D1Database, env: Bindings, userId: string) {
  const policies = consentPolicies(env);
  const rows = await db.prepare(`SELECT kind FROM consents WHERE user_id=? AND revoked_at IS NULL
    AND ((kind='TERMS' AND policy_version=?) OR (kind='PRIVACY' AND policy_version=?)
      OR (kind='LOCATION_COLLECTION' AND policy_version=?) OR (kind='LOCATION_SHARING' AND policy_version=?))`)
    .bind(userId, policies.TERMS.version, policies.PRIVACY.version,
      policies.LOCATION_COLLECTION.version, policies.LOCATION_SHARING.version)
    .all<{ kind: keyof ReturnType<typeof consentPolicies> }>();
  const accepted = new Set(rows.results.map((row) => row.kind));
  return {
    TERMS: { ...policies.TERMS, accepted: accepted.has('TERMS') },
    PRIVACY: { ...policies.PRIVACY, accepted: accepted.has('PRIVACY') },
    LOCATION_COLLECTION: { ...policies.LOCATION_COLLECTION, accepted: accepted.has('LOCATION_COLLECTION') },
    LOCATION_SHARING: { ...policies.LOCATION_SHARING, accepted: accepted.has('LOCATION_SHARING') },
  };
}

export async function hasRequiredConsents(db: D1Database, env: Bindings, userId: string): Promise<boolean> {
  const consents = await currentConsents(db, env, userId);
  return consents.TERMS.accepted && consents.PRIVACY.accepted;
}


