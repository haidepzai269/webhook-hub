"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderTemplate = renderTemplate;
function renderTemplate(template, data) {
    if (!template)
        return '';
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
        const keys = path.split('.');
        let value = data;
        for (const key of keys) {
            if (value === undefined || value === null) {
                return '';
            }
            value = value[key];
        }
        return value !== undefined && value !== null ? String(value) : '';
    });
}
//# sourceMappingURL=template.js.map