"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.createLoggerWithContext = createLoggerWithContext;
const pino_1 = require("pino");
exports.logger = (0, pino_1.default)({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
        level: (label) => ({ level: label }),
    },
    timestamp: pino_1.default.stdTimeFunctions.isoTime,
});
function createLoggerWithContext(context) {
    return exports.logger.child(context);
}
//# sourceMappingURL=logger.js.map