import { hmacSha256, timingSafeCompare, aesGcmEncrypt, aesGcmDecrypt, isPrivateIp } from '../src';

describe('Crypto Module Tests', () => {
  const secret = 'test-secret-key-12345';
  const masterKey = 'master-secret-key-32-characters!';

  describe('HMAC & Timing Safe Compare', () => {
    it('tính HMAC SHA256 chính xác và so sánh an toàn timingSafeCompare', () => {
      const data = 'hello world webhook hub';
      const sig1 = hmacSha256(secret, data);
      const sig2 = hmacSha256(secret, data);

      expect(sig1).toBe(sig2);
      expect(timingSafeCompare(sig1, sig2)).toBe(true);
      expect(timingSafeCompare(sig1, 'invalid_signature')).toBe(false);
    });
  });

  describe('AES-256-GCM Encryption', () => {
    it('mã hóa và giải mã chuỗi nhạy cảm thành công', () => {
      const plaintext = 'sk_live_payos_checksum_secret_abc123';
      const encrypted = aesGcmEncrypt(plaintext, masterKey);

      expect(encrypted).not.toBe(plaintext);
      expect(encrypted.split(':')).toHaveLength(3); // iv:authTag:ciphertext

      const decrypted = aesGcmDecrypt(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it('báo lỗi khi auth tag hoặc ciphertext bị giả mạo', () => {
      const plaintext = 'sensitive_data';
      const encrypted = aesGcmEncrypt(plaintext, masterKey);
      const parts = encrypted.split(':');
      parts[1] = Buffer.from('tampered_tag_123').toString('base64'); // sửa auth tag

      expect(() => aesGcmDecrypt(parts.join(':'), masterKey)).toThrow();
    });
  });

  describe('SSRF Guard & Private IP Detection', () => {
    it('nhận diện chính xác các địa chỉ IP private và loopback bị chặn', () => {
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('10.0.1.50')).toBe(true);
      expect(isPrivateIp('192.168.1.1')).toBe(true);
      expect(isPrivateIp('172.16.0.1')).toBe(true);
      expect(isPrivateIp('169.254.169.254')).toBe(true); // AWS/Cloud metadata
      expect(isPrivateIp('0.0.0.0')).toBe(true);
      expect(isPrivateIp('::1')).toBe(true);
    });

    it('cho phép các IP public hợp lệ', () => {
      expect(isPrivateIp('8.8.8.8')).toBe(false);
      expect(isPrivateIp('1.1.1.1')).toBe(false);
      expect(isPrivateIp('104.26.10.228')).toBe(false);
    });
  });
});
