import { defineMessages } from "../locales";

/** Thanh trên của dashboard (nút tuỳ chỉnh, ngôn ngữ, sáng/tối). */
export const header = defineMessages("header", {
  vi: {
    "header.layout-controls": "Tuỳ chỉnh giao diện",
    "header.theme.aria": "Giao diện: {mode}. Bấm để đổi",
    "header.language.aria": "Ngôn ngữ: {language}. Bấm để chuyển sang {next}",
  },
  en: {
    "header.layout-controls": "Customize appearance",
    "header.theme.aria": "Theme: {mode}. Click to change",
    "header.language.aria": "Language: {language}. Click to switch to {next}",
  },
});
