import { defineMessages } from "../locales";

/** Thanh trên của dashboard (menu bánh răng: ngôn ngữ, sáng/tối, tuỳ chỉnh bố cục — ADR-266). */
export const header = defineMessages("header", {
  vi: {
    "header.layout-controls": "Tuỳ chỉnh giao diện",
    "header.settings": "Cài đặt hiển thị",
    "header.settings.language": "Ngôn ngữ",
    "header.settings.theme": "Giao diện",
    "header.settings.layout": "Tuỳ chỉnh bố cục…",
    "header.theme.aria": "Giao diện: {mode}. Bấm để đổi",
    "header.language.aria": "Ngôn ngữ: {language}. Bấm để chuyển sang {next}",
  },
  en: {
    "header.layout-controls": "Customize appearance",
    "header.settings": "Display settings",
    "header.settings.language": "Language",
    "header.settings.theme": "Appearance",
    "header.settings.layout": "Customize layout…",
    "header.theme.aria": "Theme: {mode}. Click to change",
    "header.language.aria": "Language: {language}. Click to switch to {next}",
  },
});
