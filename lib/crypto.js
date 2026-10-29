/** Simple AES-256-GCM helpers for API secrets at rest */
import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

export function getMasterKey() {
  const raw = process.env.MASTER_KEY || '';
  if (!raw || raw.length < 32) {
    // dev fallback — set MASTER_KEY in Railway!
    return crypto.createHash('sha256').update('dev-only-change-me').digest();
  }
  return crypto.createHash('sha256').update(raw).digest();
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const key = getMasterKey();
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(blob) {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, getMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
