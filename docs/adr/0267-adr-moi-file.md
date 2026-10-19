# ADR-267 — Mỗi ADR một file; đóng băng docs/adr/README.md ở ADR-266 (2026-10-19)

**Vấn đề:** Mọi ADR nằm trong MỘT file (`docs/adr/README.md`, ~2700 dòng) và mọi nhánh đều chèn vào CUỐI file. Hai nhánh mở cùng lúc thì chắc chắn xung đột; GitHub không tự gộp hai đoạn chèn cùng vị trí, và `merge=union` không áp dụng khi merge trên giao diện web. Một ngày gặp ~8 lần.

**Chọn:** (1) Đóng băng README ở ADR-266, KHÔNG dời mục cũ (báo cáo và tài liệu đang link tới anchor trong README). Phần hướng dẫn ở đầu README được sửa sang quy ước mới; đó là sửa hướng dẫn chứ không sửa nội dung ADR nên không phạm "append-only". (2) ADR từ 267: mỗi ADR một file `docs/adr/NNNN-<slug-không-dấu>.md`, tiêu đề `# ADR-NNNN — … (ngày)`, mẫu Vấn đề / Chọn / Đánh đổi, thêm `Thay thế`/`Liên quan` khi cần. (3) Bổ sung cho ADR cũ (≤ 266 hoặc đã chốt): file mới `docs/adr/bo-sung/NNNN-YYYY-MM-DD-<slug>.md` (NNNN = số ADR được bổ sung), không sửa README. (4) Gate `adr-unique` trong `npm run verify:gates` chặn trùng số, lệch tên file/tiêu đề, ADR mới mang số ≤ 266, `## ADR-` > 266 trong README, bổ sung trỏ tới số không có. (5) `npm run adr:new -- "<tiêu đề>"` tự lấy số kế tiếp.

**Đánh đổi:** Hai chỗ để đọc (README cho ≤ 266, thư mục cho ≥ 267). Hai nhánh song song vẫn có thể cùng lấy số 267, nhưng nay là hai file khác tên nên merge sạch; trùng số bị gate bắt ở CI và nhánh vào sau đổi tên file + số trong file (thông báo gate nêu số kế tiếp), thay vì gỡ tay xung đột văn bản.

**Liên quan:** `_bmad/custom/BRANCH-POLICY.md` (mục "Trùng số ADR").
