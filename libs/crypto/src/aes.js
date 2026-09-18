"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aesGcmEncrypt = aesGcmEncrypt;
exports.aesGcmDecrypt = aesGcmDecrypt;
const crypto_1 = require("crypto");
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
function deriveKey(masterKey) {
    return (0, crypto_1.createHash)('sha256').update(masterKey).digest();
}
function aesGcmEncrypt(plaintext, masterKey) {
    const key = deriveKey(masterKey);
    const iv = (0, crypto_1.randomBytes)(IV_LENGTH);
    const cipher = (0, crypto_1.createCipheriv)(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}
function aesGcmDecrypt(encryptedPackage, masterKey) {
    const [ivB64, authTagB64, ciphertextB64] = encryptedPackage.split(':');
    if (!ivB64 || !authTagB64 || !ciphertextB64) {
        throw new Error('Định dạng mã hóa AES-GCM không hợp lệ');
    }
    const key = deriveKey(masterKey);
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');
    const decipher = (0, crypto_1.createDecipheriv)(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
}
//# sourceMappingURL=aes.js.map