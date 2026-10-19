# Luật nhánh — webhook-hub (Admin chốt 2026-10-16)

Mọi skill BMAD (build, dev, party-mode) giữ luật này suốt phiên. Nhánh chỉ là phương tiện, không phải thứ cần giữ gìn.

## Hai loại nhánh

| Loại | Nhận diện | Làm gì khi xong việc |
|---|---|---|
| **Gấp, cần lên production** | Admin nói "gấp", "đẩy lên prod", "fix ngay"; hotfix; tính năng đang chờ demo hoặc deploy | **Tự mở PR vào `master` ngay**, không cần hỏi. Trước khi mở PR, gộp `master` vào nhánh và giải hết xung đột. **Không tự merge PR.** |
| **Giao việc giữa các máy dev** | Nhánh bàn giao, WIP, `*-VIEC-MAY-CONG-TY.md`, việc dở để máy khác chạy tiếp | **Push nhánh, không PR, không merge.** Máy nhận việc làm tiếp trên chính nhánh đó. |

Không rõ nhánh thuộc loại nào thì coi là nhánh giao việc: chỉ push, rồi hỏi Admin một câu.

## CI đỏ không phải lúc nào cũng chặn

- Test chập chờn (đỏ một lần, chạy lại xanh) hoặc gitleaks bắt secret giả trong test: **không chặn PR**. Thêm allowlist vào `.gitleaks.toml` trên mọi nhánh đang chạy CI rồi đi tiếp.
- Đỏ thật (test hỏng ổn định, xung đột merge, trùng số ADR): sửa trước khi mở PR.

## Khi gộp

- Gộp `master` vào nhánh bằng merge commit. Không rebase, không force push.
- ADR (ADR-267): mỗi ADR một file `docs/adr/NNNN-<slug>.md`, bổ sung ADR cũ ở `docs/adr/bo-sung/NNNN-YYYY-MM-DD-<slug>.md`; KHÔNG sửa `docs/adr/README.md` (đóng băng ở ADR-266). Trùng số ADR: gate `adr-unique` đỏ ở nhánh vào sau; nhánh đó đổi tên file và số trong tiêu đề sang số kế tiếp mà gate nêu. Trước khi chọn số, `git fetch` rồi xem số lớn nhất trên `origin/master` (`npm run adr:new` tự lấy số theo cây hiện tại).
- Gitleaks (image CI ghim `v8.18.4`) phải báo sạch trước khi push, và chạy thành một bước riêng.
