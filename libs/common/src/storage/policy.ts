import type { PolicyImportance } from './importance';

/**
 * QT §5.4 (Q10, ADR-186): chính sách dọn tự động theo mức quan trọng. Thuật ngữ cho người đọc: "Dọn" (`trim`) và
 * "Xoá hẳn" (`delete`). Mức "Cao"/"Giữ" không có ở đây -> không thể đặt dọn tự động cho chúng.
 */
export type StoragePolicyAction = 'trim' | 'delete' | 'off';
export type StoragePolicyTrigger = 'always' | 'above_85';

export interface StoragePolicyDefault {
  importance: PolicyImportance;
  action: StoragePolicyAction;
  afterDays: number;
  trigger: StoragePolicyTrigger;
}

/**
 * Q10 (Admin chốt): Rác `delete` sau 1 ngày; Thấp `trim` sau 3 ngày; Trung bình `off`. Cùng bộ này được migration QT1
 * seed cho project có sẵn (audit `system:migration`) và được ghi khi tạo project mới. Đổi ở đây = đổi cả migration mới.
 */
export const DEFAULT_STORAGE_POLICIES: readonly StoragePolicyDefault[] = [
  { importance: 'junk', action: 'delete', afterDays: 1, trigger: 'always' },
  { importance: 'low', action: 'trim', afterDays: 3, trigger: 'always' },
  { importance: 'medium', action: 'off', afterDays: 5, trigger: 'always' },
];
