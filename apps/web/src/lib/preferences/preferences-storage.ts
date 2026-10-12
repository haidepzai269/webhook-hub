"use client";

import { setValueToCookie } from "@/server/server-actions";

import { setClientCookie } from "../cookie.client";
import { setLocalStorageValue } from "../local-storage.client";
import {
  getPreferencePersistence,
  type PreferenceKey,
  type PreferencePersistence,
  type PreferenceValueMap,
} from "./preferences-config";

/**
 * Số ngày sống của cookie theo từng preference; vắng = mặc định của setClientCookie (7 ngày). Ngôn ngữ là lựa chọn
 * lâu dài — hết hạn sau 7 ngày thì giao diện tự nhảy về tiếng Việt, người dùng tưởng lỗi.
 */
const COOKIE_DAYS: Partial<Record<PreferenceKey, number>> = { language: 365 };

async function persistByMode(mode: PreferencePersistence, key: PreferenceKey, value: string): Promise<void> {
  switch (mode) {
    case "none":
      return;

    case "client-cookie":
      setClientCookie(key, value, COOKIE_DAYS[key]);
      return;

    case "server-cookie":
      await setValueToCookie(key, value);
      return;

    case "localStorage":
      setLocalStorageValue(key, value);
      return;
  }
}

export function persistPreference<K extends PreferenceKey>(key: K, value: PreferenceValueMap[K]): Promise<void> {
  return persistByMode(getPreferencePersistence(key), key, value);
}
