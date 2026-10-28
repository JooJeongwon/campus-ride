import { z } from 'zod';

const localOrigin = (value: string) => {
  const url = new URL(value);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
};
const exactDomain = (value: string) => {
  const labels = value.split('.');
  return value.length <= 253 && labels.length >= 2
    && !labels.every((label) => /^\d+$/.test(label))
    && !/^\d+$/.test(labels.at(-1) ?? '')
    && labels.every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
};

export const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'staging', 'production']),
  APP_ORIGIN: z.url(),
  SCHOOL_CONFIG_READY: z.enum(['true', 'false']),
  ALLOW_DEV_AUTH: z.enum(['true', 'false']),
  SCHOOL_ID: z.string().optional(),
  CAMPUS_ID: z.string().optional(),
  ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  ALLOWED_HOSTED_DOMAINS: z.string().optional(),
  STUDENT_VERIFICATION_MODE: z.enum(['MANUAL_REVIEW', 'AUTHORIZED_ROSTER', 'SCHOOL_ASSERTION']).optional(),
  DEPARTMENT_SOURCE_FIELD: z.enum(['EMAIL_LOCAL_PART', 'GOOGLE_NAME']).optional(),
  DEPARTMENT_TEMPLATE: z.string().optional(),
  DEPARTMENT_PARSER_VERSION: z.string().optional(),
  DEPARTMENT_ALIASES_JSON: z.string().optional(),
  POLICY_TERMS_VERSION: z.string().optional(),
  POLICY_TERMS_URL: z.string().optional(),
  POLICY_PRIVACY_VERSION: z.string().optional(),
  POLICY_PRIVACY_URL: z.string().optional(),
  POLICY_LOCATION_COLLECTION_VERSION: z.string().optional(),
  POLICY_LOCATION_COLLECTION_URL: z.string().optional(),
  POLICY_LOCATION_SHARING_VERSION: z.string().optional(),
  POLICY_LOCATION_SHARING_URL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  CSRF_HMAC_KEY: z.string().optional(),
  BOARDING_HMAC_KEY: z.string().optional(),
}).superRefine((value, context) => {
  const origin = new URL(value.APP_ORIGIN);
  if (origin.origin !== value.APP_ORIGIN || origin.username || origin.password) {
    context.addIssue({ code: 'custom', message: 'APP_ORIGIN must be an exact origin' });
  }
  for (const [versionKey, urlKey] of [
    ['POLICY_TERMS_VERSION', 'POLICY_TERMS_URL'],
    ['POLICY_PRIVACY_VERSION', 'POLICY_PRIVACY_URL'],
    ['POLICY_LOCATION_COLLECTION_VERSION', 'POLICY_LOCATION_COLLECTION_URL'],
    ['POLICY_LOCATION_SHARING_VERSION', 'POLICY_LOCATION_SHARING_URL'],
  ] as const) {
    const version = value[versionKey];
    const urlValue = value[urlKey];
    if ((version !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(version)) || Boolean(version) !== Boolean(urlValue)) {
      context.addIssue({ code: 'custom', message: `${versionKey} and ${urlKey} must be configured together` });
    }
    if (urlValue) {
      try {
        const url = new URL(urlValue);
        if (url.protocol !== 'https:' || url.username || url.password || !exactDomain(url.hostname)
          || ['.invalid', '.example', '.test', '.localhost', '.local'].some((suffix) => url.hostname.endsWith(suffix))) throw new Error();
      } catch {
        context.addIssue({ code: 'custom', message: `${urlKey} must be an HTTPS policy URL` });
      }
    }
  }
  if (value.APP_ENV === 'development') {
    if (!localOrigin(value.APP_ORIGIN)) context.addIssue({ code: 'custom', message: 'Development is local only' });
    return;
  }
  if (value.ALLOW_DEV_AUTH !== 'false') context.addIssue({ code: 'custom', message: 'Development authentication is disabled remotely' });
  if (origin.protocol !== 'https:' || !exactDomain(origin.hostname)
    || ['.invalid', '.example', '.test', '.localhost', '.local'].some((suffix) => origin.hostname.endsWith(suffix))) {
    context.addIssue({ code: 'custom', message: 'Remote origin must be an HTTPS domain' });
  }
  if (value.SCHOOL_CONFIG_READY !== 'true') context.addIssue({ code: 'custom', message: 'School configuration is not ready' });
  for (const [key, entry] of Object.entries({
    SCHOOL_ID: value.SCHOOL_ID,
    CAMPUS_ID: value.CAMPUS_ID,
    GOOGLE_CLIENT_ID: value.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: value.GOOGLE_CLIENT_SECRET,
    CSRF_HMAC_KEY: value.CSRF_HMAC_KEY,
    BOARDING_HMAC_KEY: value.BOARDING_HMAC_KEY,
    STUDENT_VERIFICATION_MODE: value.STUDENT_VERIFICATION_MODE,
    DEPARTMENT_SOURCE_FIELD: value.DEPARTMENT_SOURCE_FIELD,
    DEPARTMENT_TEMPLATE: value.DEPARTMENT_TEMPLATE,
    DEPARTMENT_PARSER_VERSION: value.DEPARTMENT_PARSER_VERSION,
    DEPARTMENT_ALIASES_JSON: value.DEPARTMENT_ALIASES_JSON,
    POLICY_TERMS_VERSION: value.POLICY_TERMS_VERSION,
    POLICY_TERMS_URL: value.POLICY_TERMS_URL,
    POLICY_PRIVACY_VERSION: value.POLICY_PRIVACY_VERSION,
    POLICY_PRIVACY_URL: value.POLICY_PRIVACY_URL,
    POLICY_LOCATION_COLLECTION_VERSION: value.POLICY_LOCATION_COLLECTION_VERSION,
    POLICY_LOCATION_COLLECTION_URL: value.POLICY_LOCATION_COLLECTION_URL,
    POLICY_LOCATION_SHARING_VERSION: value.POLICY_LOCATION_SHARING_VERSION,
    POLICY_LOCATION_SHARING_URL: value.POLICY_LOCATION_SHARING_URL,
  })) {
    if (!entry) context.addIssue({ code: 'custom', message: `${key} is required` });
  }
  if ((value.CSRF_HMAC_KEY?.length ?? 0) < 32) {
    context.addIssue({ code: 'custom', message: 'CSRF_HMAC_KEY must contain at least 32 characters' });
  }
  if ((value.BOARDING_HMAC_KEY?.length ?? 0) < 32) {
    context.addIssue({ code: 'custom', message: 'BOARDING_HMAC_KEY must contain at least 32 characters' });
  }
  for (const key of ['ALLOWED_EMAIL_DOMAINS', 'ALLOWED_HOSTED_DOMAINS'] as const) {
    const entries = value[key]?.split(',').map((domain) => domain.trim().toLowerCase()) ?? [];
    const domains = entries.filter(Boolean);
    if (!domains.length || entries.length !== domains.length || domains.some((domain) => domain.startsWith('.')
      || ['.invalid', '.example', '.test', '.localhost', '.local'].some((suffix) => domain.endsWith(suffix)) || domain.includes('*')
      || !exactDomain(domain))) {
      context.addIssue({ code: 'custom', message: `${key} must contain exact school domains` });
    }
    if (key === 'ALLOWED_EMAIL_DOMAINS' && (domains.length !== 1 || domains[0] !== 'gachon.ac.kr')) {
      context.addIssue({ code: 'custom', message: 'Remote email access is restricted to gachon.ac.kr' });
    }
  }
  if (value.GOOGLE_CLIENT_ID && !value.GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com')) {
    context.addIssue({ code: 'custom', message: 'GOOGLE_CLIENT_ID is not a Google web client ID' });
  }
  if (Object.values(value).some((entry) => typeof entry === 'string' && /^(synthetic|replace|test|demo|your-|placeholder|example)/i.test(entry))) {
    context.addIssue({ code: 'custom', message: 'Placeholder configuration cannot enable a remote environment' });
  }
  if (value.STUDENT_VERIFICATION_MODE !== 'SCHOOL_ASSERTION') {
    context.addIssue({ code: 'custom', message: 'Remote student access must use the verified school Google account' });
  }
  const template = value.DEPARTMENT_TEMPLATE;
  if (template && (template.length > 128 || template.split('{department}').length !== 2
    || !['-', '.', '_'].some((delimiter) => template.includes(delimiter))
    || template.replace('{department}', '').replaceAll('{id}', '').replaceAll('{*}', '').includes('{'))) {
    context.addIssue({ code: 'custom', message: 'DEPARTMENT_TEMPLATE must have a department placeholder and a simple delimiter' });
  }
  try {
    const aliases = JSON.parse(value.DEPARTMENT_ALIASES_JSON ?? '');
    if (!aliases || Array.isArray(aliases) || typeof aliases !== 'object' || Object.values(aliases).some((item) => typeof item !== 'string')) throw new Error();
  } catch {
    context.addIssue({ code: 'custom', message: 'DEPARTMENT_ALIASES_JSON must map aliases to department codes' });
  }
});

export type Bindings = z.infer<typeof environmentSchema> & {
  DB: D1Database;
  ASSETS: Fetcher;
};

export function allowedDomains(value: string | undefined): string[] {
  return value?.split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean) ?? [];
}

export function consentPolicies(env: Pick<Bindings,
  'POLICY_TERMS_VERSION' | 'POLICY_TERMS_URL' | 'POLICY_PRIVACY_VERSION' | 'POLICY_PRIVACY_URL'
  | 'POLICY_LOCATION_COLLECTION_VERSION' | 'POLICY_LOCATION_COLLECTION_URL'
  | 'POLICY_LOCATION_SHARING_VERSION' | 'POLICY_LOCATION_SHARING_URL'>) {
  return {
    TERMS: { version: env.POLICY_TERMS_VERSION || 'local-demo-v1', url: env.POLICY_TERMS_URL || null },
    PRIVACY: { version: env.POLICY_PRIVACY_VERSION || 'local-demo-v1', url: env.POLICY_PRIVACY_URL || null },
    LOCATION_COLLECTION: {
      version: env.POLICY_LOCATION_COLLECTION_VERSION || 'local-location-v1',
      url: env.POLICY_LOCATION_COLLECTION_URL || null,
    },
    LOCATION_SHARING: {
      version: env.POLICY_LOCATION_SHARING_VERSION || 'local-location-v1',
      url: env.POLICY_LOCATION_SHARING_URL || null,
    },
  };
}

export function cookieOptions(env: Pick<Bindings, 'APP_ENV'>) {
  return { path: '/', httpOnly: true, secure: env.APP_ENV !== 'development', sameSite: 'Lax' as const };
}

export function cookieName(env: Pick<Bindings, 'APP_ENV'>, kind: 'session' | 'oauth') {
  const suffix = kind === 'session' ? 'session' : 'oauth';
  return env.APP_ENV === 'development' ? `campus_${suffix}` : `__Host-campus_${suffix}`;
}
