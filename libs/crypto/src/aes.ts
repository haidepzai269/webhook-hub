import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;

function deriveKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey).digest();
}

/**
 * Mã hóa chuỗi bằng AES-256-GCM
 * Trả về: iv:authTag:ciphertext (base64)
 */
export function aesGcmEncrypt(plaintext: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Giải mã chuỗi AES-256-GCM
 */
export function aesGcmDecrypt(encryptedPackage: string, masterKey: string): string {
  const [ivB64, authTagB64, ciphertextB64] = encryptedPackage.split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Định dạng mã hóa AES-GCM không hợp lệ');
  }

  const key = deriveKey(masterKey);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf8');
}
