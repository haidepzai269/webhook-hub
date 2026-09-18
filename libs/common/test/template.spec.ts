import { renderTemplate } from '../src';

describe('Template Renderer Tests', () => {
  it('render chính xác các biến dạng {{path.to.field}}', () => {
    const template = 'Xin chào {{user.name}}, đơn {{order.code}} có giá trị {{order.total}}!';
    const data = {
      user: { name: 'Thành' },
      order: { code: 'DH999', total: 10000 },
    };

    const result = renderTemplate(template, data);
    expect(result).toBe('Xin chào Thành, đơn DH999 có giá trị 10000!');
  });

  it('xử lý an toàn khi field bị thiếu hoặc undefined', () => {
    const template = 'Mã: {{order.code}}, Ghi chú: {{order.notes}}';
    const data = { order: { code: 'DH123' } };

    const result = renderTemplate(template, data);
    expect(result).toBe('Mã: DH123, Ghi chú: ');
  });
});
