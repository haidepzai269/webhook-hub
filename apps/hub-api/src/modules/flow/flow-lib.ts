/**
 * Cửa ngõ duy nhất tới `libs/common/src/flow` từ hub-api. Import tương đối (không qua `@hub/common`)
 * vì `libs/common/src/index.ts` nằm ngoài phạm vi được sửa của spec này; lúc merge thêm
 * `export * from './flow'` vào index rồi đổi dòng dưới thành `from '@hub/common'` (ADR nháp EF-1).
 */
export * from '../../../../../libs/common/src/flow';
