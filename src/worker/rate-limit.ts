import { sha256 } from './auth/session';

export async function rateLimit(db: D1Database, userId: string, operation: string, now: number, limit: number, windowMs: number) {
  const subject = await sha256(userId);
  const windowStart = Math.floor(now / windowMs) * windowMs;
  await db.prepare('DELETE FROM rate_limit_buckets WHERE expires_at<=?').bind(now).run();
  return db.prepare(`INSERT INTO rate_limit_buckets (subject_hash,operation,window_start,count,expires_at)
      VALUES(?,?,?,1,?) ON CONFLICT(subject_hash,operation,window_start)
      DO UPDATE SET count=count+1 WHERE count<? RETURNING count`)
    .bind(subject, operation, windowStart, windowStart + windowMs * 2, limit).first<{ count: number }>();
}

