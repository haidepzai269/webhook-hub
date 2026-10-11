# Cần Admin quyết — DX phương án A (2026-10-11)

## Q1 — ĐÃ QUYẾT (a), 2026-10-11 → ADR-139 — `fix` của nguồn tuỳ chỉnh ở `/hooks/generic/:sourceKey` chưa tới tay dev cho lỗi 401 (chữ ký) / 422 (thiếu idempotency)

- Spec DX1 §2.1: "GenericAdapter.buildAck thêm `fix` vào body lỗi". Đã làm (`libs/providers/src/generic.adapter.ts`, `genericAckFix`).
- Nhưng lõi ingest (`apps/hub-api/src/modules/ingest/ingest.service.ts` ~dòng 290 và 304) trả 401/422 TRỰC TIẾP
  (`{error:'Chữ ký webhook không hợp lệ…'}`, `{error:'missing_idempotency_key'}`), không gọi `adapter.buildAck` — nên `fix`
  chỉ xuất hiện ở các ack đi qua adapter.
- Phương án:
  - **(a)** đổi hai chỗ đó thành `adapter.buildAck({accepted:false, status, message})` → mọi provider trả ack lỗi theo định
    dạng của chính nó (PayOS `{code:'01',…}`, SePay `{success:false,…}`, Generic `{ok:false,error,fix}`). Đúng thiết kế
    "adapter sở hữu định dạng ack", nhưng đổi body 401/422 của MỌI provider trên đường nóng → cần chạy lại L2 (VF4) + hub-sim.
  - **(b)** giữ nguyên; dev đọc chẩn đoán ở chế độ lắng nghe (console → Sources → Inspect), vốn đã nói rõ lý do.
- Mình nghiêng (a) nhưng KHÔNG tự sửa vì chạm lõi ingest của mọi provider. Đang để (b).

**Quyết định (Admin, 11/10): (a).** Làm ở commit sau `5a43fc9`: `rejectAck` trong `ingest.service.ts`, status 401/422 do lõi giữ, body theo `buildAck` của từng provider. ADR-139.
