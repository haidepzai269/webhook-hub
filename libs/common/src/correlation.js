"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CORRELATION_HEADER = void 0;
exports.generateCorrelationId = generateCorrelationId;
const crypto_1 = require("crypto");
function generateCorrelationId() {
    return (0, crypto_1.randomUUID)();
}
exports.CORRELATION_HEADER = 'x-correlation-id';
//# sourceMappingURL=correlation.js.map