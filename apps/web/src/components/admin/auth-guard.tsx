"use client";

import { type ReactNode, useEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { LOGIN_PATH } from "@/lib/hub/client";
import { useHubRealtime } from "@/lib/hub/socket";
import { getToken } from "@/lib/hub/token";

function Realtime() {
  useHubRealtime();
  return null;
}

/**
 * Guard phía client: JWT nằm ở localStorage nên server không đọc được (không dùng proxy/middleware).
 * Có token chưa chắc hợp lệ — request đầu tiên trả 401 thì `hubFetch` tự xoá token và về login.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    const ok = Boolean(getToken());
    setAuthed(ok);
    if (!ok) router.replace(LOGIN_PATH);
  }, [router]);

  if (!authed) return null;
  return (
    <>
      <Realtime />
      {children}
    </>
  );
}
