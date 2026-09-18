export function renderTemplate(template: string, data: Record<string, any>): string {
  if (!template) return '';
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const keys = path.split('.');
    let value: any = data;
    for (const key of keys) {
      if (value === undefined || value === null) {
        return '';
      }
      value = value[key];
    }
    return value !== undefined && value !== null ? String(value) : '';
  });
}
