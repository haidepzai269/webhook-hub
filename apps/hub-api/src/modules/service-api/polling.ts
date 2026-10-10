/**
 * S7 (SPEC §4.5): long-poll KHÔNG dùng Redis. Kết quả rỗng và `waitSec > 0` thì truy vấn lại mỗi `intervalMs`
 * cho tới khi có kết quả, hết `waitSec`, hoặc client ngắt kết nối (`isClosed`). Trần 20s ở controller
 * (Render cắt request ~30s).
 */
export async function longPoll<T>(
  query: () => Promise<T[]>,
  waitSec: number,
  isClosed: () => boolean,
  intervalMs = 1000,
): Promise<T[]> {
  const deadline = Date.now() + waitSec * 1000;
  let rows = await query();
  while (rows.length === 0 && !isClosed()) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleepUnlessClosed(Math.min(intervalMs, left), isClosed);
    if (isClosed()) break;
    rows = await query();
  }
  return rows;
}

/** Ngủ theo nhịp 100ms để client ngắt thì dừng sớm, không giữ kết nối DB/timer thêm cả giây. */
async function sleepUnlessClosed(ms: number, isClosed: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !isClosed()) {
    await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())));
  }
}
