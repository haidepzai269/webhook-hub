/** sessionStorage: "Tạo từ event này" (V1) → playground điền sẵn source + body. Chỉ là tiện ích một lần. */
export const PLAYGROUND_PREFILL_KEY = "playground:prefill";

export interface PlaygroundPrefill {
  sourceId: string | null;
  body: unknown;
}

export function takePlaygroundPrefill(): PlaygroundPrefill | null {
  try {
    const v = sessionStorage.getItem(PLAYGROUND_PREFILL_KEY);
    if (!v) return null;
    sessionStorage.removeItem(PLAYGROUND_PREFILL_KEY);
    return JSON.parse(v) as PlaygroundPrefill;
  } catch {
    return null;
  }
}
