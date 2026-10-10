"use client";

import { type ReactNode, useEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { type AuthMe, hubFetch, LOGIN_PATH } from "@/lib/hub/client";
import { useHubRealtime } from "@/lib/hub/socket";

function Realtime() {
  useHubRealtime();
  return null;
}

/**
 * Guard phía client (SPEC-auth §9): cookie phiên là HttpOnly nên JS không "có token" để kiểm — hỏi server
 * `GET /auth/me` (hubFetch tự refresh một lần khi 401; hỏng thì về /login). Việc chặn thật nằm ở server.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    hubFetch<AuthMe>("/auth/me")
      .then(() => alive && setAuthed(true))
      .catch(() => {
        if (!alive) return;
        setAuthed(false);
        router.replace(LOGIN_PATH);
      });
    return () => {
      alive = false;
    };
  }, [router]);

  if (!authed) return null;
  return (
    <>
      <Realtime />
      {children}
    </>
  );
}
