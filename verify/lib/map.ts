/**
 * VF2 (SPEC-verification §3.1, §3.2): bản đồ mã test.
 * - Mã KHAI BÁO: đọc từ các spec theo `verify/spec-sources.json` (regex trên bảng test).
 * - Mã MANG: tag `[NS:CODE]` trong tên test (`*.spec.ts`) và trong kịch bản `verify/scenarios/*.ts`.
 * Đỏ khi: mồ côi (story đã xong mà chưa test nào mang mã), ma (mã không có trong spec), trùng (hai test cùng mã
 * mà không đánh dấu `(phần a/b)`). Mồ côi có lý do trong `acceptedOrphans` thì không đỏ nhưng luôn được liệt kê.
 */

export interface DoneSpec {
  /** Regex bắt tên story đã đánh `[x]` trong file spec (nhóm 1 = id story). */
  checklist?: string;
  /** story → danh sách mã ("U34-U50,T15"). Mã không thuộc nhóm nào: coi là xong khi MỌI story của checklist đã [x]. */
  groups?: Record<string, string>;
  /** true: mọi mã của nguồn này đã xong (spec cũ đã đóng). */
  all?: boolean;
}

export interface SourceDef {
  ns: string;
  file: string;
  /** Regex theo dòng, nhóm 1 = mã. */
  pattern: string;
  /** Tiền tố ghép vào mã bắt được (vd `#` cho dòng REVIEW-CHECKLIST). */
  codePrefix?: string;
  /** false: mã hợp lệ (không ma) nhưng không bắt buộc có test (vd mã story `AF:S1-2`). */
  requireTest?: boolean;
  /** Dòng khớp regex này = mục chưa làm/hoãn (vd `⏭`). */
  notDoneIfLineMatches?: string;
  /** Regex nhóm 1 = story trên cùng dòng khai báo (cột story của REVIEW-CHECKLIST). */
  storyOnLine?: string;
  done?: DoneSpec;
  note?: string;
}

export interface SourcesConfig {
  sources: SourceDef[];
  inline: { ns: string; codes: string; requireTest?: boolean; note?: string }[];
  doneOverrides: { codes: string; reason: string }[];
  acceptedOrphans: Record<string, string>;
}

export interface Declared {
  key: string;
  ns: string;
  code: string;
  file: string;
  line: number;
  story?: string;
  done: boolean;
  requireTest: boolean;
}

export interface TagHit {
  key: string;
  file: string;
  line: number;
  part?: string;
  title: string;
}

export interface MapResult {
  ok: boolean;
  orphans: Declared[];
  acceptedOrphans: (Declared & { reason: string })[];
  ghosts: TagHit[];
  dups: { key: string; hits: TagHit[] }[];
  covered: Map<string, TagHit[]>;
}

export const TAG_RE = /\[(AF|MS|DX|AU|AR|VF|BB|KN|SK):([^\]\s]+)\]/g;

/** "U34-U36,U50" → U34,U35,U36,U50 · "1-3" → 1,2,3 · "AU:UA1-UA3" giữ tiền tố namespace. */
export function expandCodes(spec: string): string[] {
  const out: string[] = [];
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const ns = raw.includes(':') ? raw.slice(0, raw.indexOf(':') + 1) : '';
    const body = raw.slice(ns.length);
    const m = /^([^\d-]*)(\d+)-([^\d-]*)(\d+)$/.exec(body);
    if (m && m[1] === m[3]) {
      for (let i = Number(m[2]); i <= Number(m[4]); i++) out.push(`${ns}${m[1]}${i}`);
    } else {
      out.push(raw);
    }
  }
  return out;
}

export function declaredCodes(config: SourcesConfig, read: (file: string) => string): Map<string, Declared> {
  const out = new Map<string, Declared>();
  for (const src of config.sources) {
    const text = read(src.file);
    const lines = text.split(/\r?\n/);
    const re = new RegExp(src.pattern);
    const notDoneRe = src.notDoneIfLineMatches ? new RegExp(src.notDoneIfLineMatches) : null;
    const storyRe = src.storyOnLine ? new RegExp(src.storyOnLine) : null;

    // story đã [x]
    const doneStories = new Set<string>();
    const allStories = new Set<string>();
    if (src.done?.checklist) {
      const ck = new RegExp(src.done.checklist, 'g');
      for (const m of text.matchAll(ck)) doneStories.add(m[1]);
      const any = new RegExp(src.done.checklist.replace('\\[x\\]', '\\[[ x]\\]'), 'g');
      for (const m of text.matchAll(any)) allStories.add(m[1]);
    }
    const storyOf = new Map<string, string>();
    for (const [story, codes] of Object.entries(src.done?.groups ?? {})) {
      for (const c of expandCodes(codes)) storyOf.set(c, story);
    }
    const everyStoryDone = allStories.size > 0 && [...allStories].every((s) => doneStories.has(s));

    lines.forEach((ln, i) => {
      const m = re.exec(ln);
      if (!m) return;
      const code = `${src.codePrefix ?? ''}${m[1]}`;
      const key = `${src.ns}:${code}`;
      if (out.has(key)) return; // bảng kết quả cuối spec lặp lại mã: lấy lần khai báo đầu
      const story = storyRe?.exec(ln)?.[1] ?? storyOf.get(code);
      let done: boolean;
      if (notDoneRe?.test(ln)) done = false;
      else if (src.done?.all) done = true;
      else if (story && storyOf.has(code)) done = doneStories.has(story);
      else done = everyStoryDone;
      out.set(key, { key, ns: src.ns, code, file: src.file, line: i + 1, story, done, requireTest: src.requireTest !== false });
    });
  }
  for (const inl of config.inline) {
    for (const code of expandCodes(inl.codes)) {
      const key = `${inl.ns}:${code}`;
      out.set(key, { key, ns: inl.ns, code, file: 'spec-sources.json', line: 0, done: false, requireTest: inl.requireTest !== false });
    }
  }
  for (const ov of config.doneOverrides) {
    for (const key of expandCodes(ov.codes)) {
      const d = out.get(key);
      if (d) d.done = true;
    }
  }
  return out;
}

/** Quét tag trong text; bỏ dòng comment (`//`, `*`, `/*`). */
export function scanTags(files: { file: string; text: string }[]): TagHit[] {
  const hits: TagHit[] = [];
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((ln, i) => {
      const t = ln.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      const part = /\(phần ([a-z])\)/.exec(ln)?.[1];
      for (const m of ln.matchAll(TAG_RE)) {
        hits.push({ key: `${m[1]}:${m[2]}`, file: f.file, line: i + 1, part, title: t.slice(0, 160) });
      }
    });
  }
  return hits;
}

export function analyzeMap(declared: Map<string, Declared>, hits: TagHit[], config: SourcesConfig): MapResult {
  const covered = new Map<string, TagHit[]>();
  const ghosts: TagHit[] = [];
  for (const h of hits) {
    if (!declared.has(h.key)) {
      ghosts.push(h);
      continue;
    }
    covered.set(h.key, [...(covered.get(h.key) ?? []), h]);
  }
  const dups: MapResult['dups'] = [];
  for (const [key, hs] of covered) {
    if (hs.length < 2) continue;
    const parts = hs.map((h) => h.part);
    const allParted = parts.every(Boolean) && new Set(parts).size === parts.length;
    if (!allParted) dups.push({ key, hits: hs });
  }
  const orphans: Declared[] = [];
  const acceptedOrphans: (Declared & { reason: string })[] = [];
  for (const d of declared.values()) {
    if (!d.done || !d.requireTest || covered.has(d.key)) continue;
    const reason = config.acceptedOrphans[d.key];
    if (reason) acceptedOrphans.push({ ...d, reason });
    else orphans.push(d);
  }
  return { ok: orphans.length === 0 && ghosts.length === 0 && dups.length === 0, orphans, acceptedOrphans, ghosts, dups, covered };
}
