import { createT } from "../../lib/i18n/dictionary";
import { disconnectedNote, groupActive, isDisconnected } from "./disconnected";

describe("ADR-161 — mục đã Ngắt luôn ở lại bản đồ (vẽ mờ)", () => {
  it("isDisconnected: source/đích/subscription/nhóm có active=false; gate/normalize không", () => {
    expect(isDisconnected({ id: "src:1", kind: "source", active: false })).toBe(true);
    expect(isDisconnected({ id: "dst:1", kind: "destination", active: false })).toBe(true);
    expect(isDisconnected({ id: "sub:1", kind: "subscription", active: false })).toBe(true);
    expect(isDisconnected({ id: "subgroup:d", kind: "subscription", active: false })).toBe(true);
    expect(isDisconnected({ id: "sub:1", kind: "subscription", active: true })).toBe(false);
    expect(isDisconnected({ id: "dst:old", kind: "destination" })).toBe(false); // thiếu trường = đang chạy
    expect(isDisconnected({ id: "gate", kind: "gate", active: false })).toBe(false);
  });

  it("groupActive: nhóm chỉ ngắt khi mọi subscription đã ngắt", () => {
    expect(groupActive([{ active: false }, { active: true }])).toBe(true);
    expect(groupActive([{ active: false }, { active: false }])).toBe(false);
  });

  it("disconnectedNote: nhãn cạnh gộp ghi rõ số đã ngắt", () => {
    const vi = createT("vi");
    expect(disconnectedNote([{ active: true }], vi)).toBe("");
    expect(disconnectedNote([{ active: false }, { active: true }], vi)).toBe("1 đã ngắt");
    expect(disconnectedNote([{ active: false }], vi)).toBe("đã ngắt");
    const en = createT("en");
    expect(disconnectedNote([{ active: false }, { active: true }], en)).toBe("1 disconnected");
    expect(disconnectedNote([{ active: false }], en)).toBe("disconnected");
  });
});
