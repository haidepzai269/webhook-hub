/**
 * Logic thuần của ngăn Nhật ký sự kiện (ADR-163) — tách khỏi component để test và để vòng lặp nạp không tái diễn.
 */

/**
 * Sentinel đáy ngăn có được TỰ nạp trang cũ hơn không. Khi đang lọc phía client (ô tìm), tập hiển thị có thể ít đến
 * mức sentinel luôn lọt khung -> nạp mãi (và với maxPages thì bỏ đầu / nạp lại đầu thành vòng). Lúc đó chỉ nạp khi
 * người xem bấm "Tải thêm".
 */
export function shouldAutoLoadMore(s: { visible: boolean; hasNextPage: boolean; fetching: boolean; clientFilter: string }): boolean {
  return s.visible && s.hasNextPage && !s.fetching && s.clientFilter.trim() === "";
}

/**
 * Nạp lại từ trang mới nhất CHỈ ở bước chuyển thật "không trực tiếp -> trực tiếp" (live = !paused && ở đỉnh) khi trang
 * đầu đã bị maxPages bỏ — gồm cả "về đỉnh khi đang chạy" lẫn "bấm Tiếp tục khi đã ở đỉnh". Không chạy mỗi lần
 * `live` đúng: nếu không, mỗi lần nạp thêm làm rơi trang đầu sẽ kéo theo một lần nạp lại đầu.
 */
export function shouldResetHead(s: { wasLive: boolean; live: boolean; headDropped: boolean }): boolean {
  return !s.wasLive && s.live && s.headDropped;
}
