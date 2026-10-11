"use client";

import { type ReactNode, useEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { type AuthMe, hubFetch, LOGIN_PATH } from "@/lib/hub/client";
import type { ProjectSummary } from "@/lib/hub/flow-project";
import { ensureProject } from "@/lib/hub/project-store";
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
    // AU3: có phiên -> chọn project hợp lệ (đã nhớ nếu còn quyền, không thì cái đầu) TRƯỚC khi mount trang:
    // mọi query /api/v1/* cần ?projectId=.
    hubFetch<AuthMe>("/auth/me")
      .then(async (me) => ({ me, projects: await hubFetch<ProjectSummary[]>("/api/v1/projects") }))
      .then(({ me, projects }) => {
        // Lựa chọn nhớ theo user; mặc định project mình là thành viên (sửa lỗi "stale project").
        ensureProject(projects, me.user.id);
        if (alive) setAuthed(true);
      })
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
