"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hmacSha256 = hmacSha256;
exports.timingSafeCompare = timingSafeCompare;
const crypto_1 = require("crypto");
function hmacSha256(secret, data) {
    const hmac = (0, crypto_1.createHmac)('sha256', secret);
    hmac.update(data);
    return hmac.digest('hex');
}
function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        return false;
    }
    return (0, crypto_1.timingSafeEqual)(bufA, bufB);
}
//# sourceMappingURL=hmac.js.map