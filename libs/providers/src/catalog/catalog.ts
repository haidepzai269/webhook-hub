import { validateGenericConfig } from '../generic-config';
import { ProviderRegistry } from '../provider.registry';
import { CATALOG_DATA } from './catalog.data';
import { BODY_FORMATS, CatalogEntry } from './types';

/**
 * PK9 (SPEC-provider-khac §8.1, ADR-208): danh mục provider là DỮ LIỆU (`entries/<id>.json`), không phải code — thêm
 * một bên không sửa lõi. `tools/build-catalog.ts` kiểm từng mục (+ fixture trên đĩa) rồi sinh `catalog.data.ts`;
 * file này kiểm LẠI dữ liệu đã sinh ngay khi được import (hub-api import lúc khởi động) — sai thì ném, app không lên.
 *
 * Luật của một mục (`entries/`):
 * - `id` khớp `^[a-z0-9-]{2,32}$`, không trùng;
 * - `confidence` là `cao` | `trung bình` (mục `thấp` nằm ở `entries-pending/`, không build);
 * - fingerprint có ≥ 1 `required` (header/body/query) — mục không có required nào khớp mọi request;
 * - đúng MỘT handler: `config` qua `validateGenericConfig` (cả `alternatives`), `native` có trong `ProviderRegistry`,
 *   `unsupported` có `reason` + `workaround` dùng `POST /v1/p/:project/events` (E22);
 * - config dùng sha1 thì bắt buộc `sha1Reason` (ADR-203: sha1 chỉ khi nhà cung cấp quy định);
 * - `sources` khác rỗng (§8.4: mọi chi tiết phải có nguồn).
 * Fixture (≥ 1 mỗi mục) kiểm ở bước build vì cần đọc đĩa.
 */
export const CATALOG_ID_RE = /^[a-z0-9-]{2,32}$/;
const HEADER_NAME_RE = /^[a-z0-9-]{1,64}$/;
const NOT_NATIVE = new Set(['generic', 'api']);
export const EVENTS_ROUTE = 'POST /v1/p/:project/events';

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function usesSha1(config: Record<string, unknown>): boolean {
  return config.algo === 'sha1' || (Array.isArray(config.algos) && config.algos.includes('sha1'));
}

/** Lỗi của MỘT mục (rỗng = hợp lệ). */
export function entryProblems(e: unknown): string[] {
  const out: string[] = [];
  if (!isObj(e)) return ['mục không phải object'];
  const at = (m: string) => out.push(`${typeof e.id === 'string' ? e.id : '?'}: ${m}`);
  if (typeof e.id !== 'string' || !CATALOG_ID_RE.test(e.id)) at('id phải khớp ^[a-z0-9-]{2,32}$');
  if (typeof e.name !== 'string' || e.name.trim() === '') at('name rỗng');
  if (!isStrArr(e.aliases)) at('aliases phải là mảng chuỗi');
  if (e.group !== null && (typeof e.group !== 'string' || !CATALOG_ID_RE.test(e.group))) at('group là null hoặc ^[a-z0-9-]{2,32}$');
  if (e.confidence === 'thấp') at('confidence "thấp" không được nạp — chuyển sang entries-pending/');
  else if (e.confidence !== 'cao' && e.confidence !== 'trung bình') at('confidence là "cao" | "trung bình"');
  if (typeof e.docs !== 'string' || !/^https?:\/\//.test(e.docs)) at('docs phải là URL');
  if (!isStrArr(e.sources) || e.sources.length === 0) at('sources rỗng (mọi chi tiết phải có nguồn)');
  if (!Array.isArray(e.fields) || !e.fields.every((f: unknown) => isObj(f) && typeof f.name === 'string' && typeof f.label === 'string' && typeof f.secret === 'boolean')) {
    at('fields là mảng {name, label, secret}');
  }
  if (![null, 'provider', 'hub', 'first-request'].includes(e.secretSource)) at('secretSource là provider | hub | first-request | null');

  const fp = e.fingerprint;
  if (!isObj(fp)) at('thiếu fingerprint');
  else {
    if (fp.method !== 'POST' && fp.method !== 'GET') at('fingerprint.method là POST | GET');
    const parts = ['headers', 'body', 'query'] as const;
    let required = 0;
    for (const p of parts) {
      const part = fp[p];
      if (!isObj(part) || !isStrArr(part.required) || !isStrArr(part.optional)) {
        at(`fingerprint.${p} là {required: string[], optional: string[]}`);
        continue;
      }
      required += part.required.length;
      if (p === 'headers' && ![...part.required, ...part.optional].every((h) => HEADER_NAME_RE.test(h))) at('fingerprint.headers: tên header viết thường ^[a-z0-9-]{1,64}$');
    }
    if (required === 0) at('fingerprint không có required nào (sẽ khớp mọi request)');
    if (isObj(fp.body)) {
      const formats = Array.isArray(fp.body.format) ? fp.body.format : [fp.body.format];
      if (formats.length === 0 || !formats.every((f: unknown) => (BODY_FORMATS as readonly unknown[]).includes(f))) at(`fingerprint.body.format thuộc ${BODY_FORMATS.join(', ')}`);
    }
    if (fp.userAgent !== null) {
      try {
        if (typeof fp.userAgent !== 'string') throw new Error();
        new RegExp(fp.userAgent);
      } catch {
        at('fingerprint.userAgent là null hoặc regex hợp lệ');
      }
    }
  }

  const h = e.handler;
  const kinds = isObj(h) ? ['config', 'native', 'unsupported'].filter((k) => k in h) : [];
  if (kinds.length !== 1) at('handler có ĐÚNG MỘT trong config | native | unsupported');
  else if (kinds[0] === 'config') {
    const configs: Array<[string, unknown]> = [['handler.config', h.config]];
    if (h.alternatives !== undefined) {
      if (!Array.isArray(h.alternatives)) at('handler.alternatives là mảng');
      else h.alternatives.forEach((a: any, i: number) => {
        if (!isObj(a) || typeof a.note !== 'string') at(`handler.alternatives[${i}] là {note, config}`);
        configs.push([`handler.alternatives[${i}].config`, isObj(a) ? a.config : undefined]);
      });
    }
    for (const [where, c] of configs) {
      const r = validateGenericConfig(c);
      if (!r.ok) at(`${where} sai: ${(r as { field: string }).field} — ${(r as { message: string }).message}`);
      else if (usesSha1(c as Record<string, unknown>) && (typeof e.sha1Reason !== 'string' || e.sha1Reason.trim() === '')) at(`${where} dùng sha1: bắt buộc sha1Reason (ADR-203)`);
    }
  } else if (kinds[0] === 'native') {
    if (typeof h.native !== 'string' || NOT_NATIVE.has(h.native) || !ProviderRegistry.has(h.native)) at(`handler.native "${h.native}" không có adapter trong ProviderRegistry`);
  } else {
    const u = h.unsupported;
    if (!isObj(u) || typeof u.reason !== 'string' || u.reason.trim() === '' || typeof u.workaround !== 'string' || u.workaround.trim() === '') {
      at('handler.unsupported cần reason + workaround');
    } else if (!u.workaround.includes(EVENTS_ROUTE)) at(`handler.unsupported.workaround phải chỉ đường ${EVENTS_ROUTE} (E22)`);
  }
  return out;
}

/** Kiểm cả danh mục (thêm luật id không trùng). Ném khi sai — dùng lúc khởi động. */
export function validateCatalog(entries: unknown[]): CatalogEntry[] {
  const problems = entries.flatMap(entryProblems);
  const seen = new Set<string>();
  for (const e of entries) {
    const id = isObj(e) ? e.id : undefined;
    if (typeof id === 'string' && seen.has(id)) problems.push(`${id}: id trùng`);
    if (typeof id === 'string') seen.add(id);
  }
  if (problems.length > 0) throw new Error(`Danh mục provider không hợp lệ:\n- ${problems.join('\n- ')}`);
  return entries as CatalogEntry[];
}

/** Danh mục đã build, đã kiểm lúc import (sai -> ném -> hub-api không lên). `GET /api/v1/catalog` trả đúng mảng này. */
export const CATALOG: readonly CatalogEntry[] = Object.freeze(validateCatalog(CATALOG_DATA as unknown[]));
