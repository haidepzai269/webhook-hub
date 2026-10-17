"use client";

import { createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { useQueryClient } from "@tanstack/react-query";
import { RotateCw, ServerCrash } from "lucide-react";

import { Spinner } from "@/components/admin/spinner";
import { Button } from "@/components/ui/button";
import { type BootPhase, runBoot } from "@/lib/hub/auth-boot";
import { holdAuthGate, releaseAuthGate } from "@/lib/hub/auth-gate";
import { LOGIN_PATH } from "@/lib/hub/client";
import { useMeStore } from "@/lib/hub/me-store";
import { ensureProject } from "@/lib/hub/project-store";
import { useHubRealtime } from "@/lib/hub/socket";
import { useT } from "@/lib/i18n/use-t";

function Realtime() {
  useHubRealtime();
  return null;
}

/** Ngoài AuthGuard (trang login, `/projects?demo=1`) coi như đã xong — không có gì để chờ. */
const BootPhaseContext = createContext<BootPhase>("ok");

/**
 * true khi AuthGuard còn chờ phiên (kể cả đang báo lỗi/thử lại). Dùng cho chỗ quyết định theo `me`/project đã chọn mà
 * KHÔNG qua query (vd. "chỉ operator", "chưa chọn dự án"): đang khởi động thì hiện khung chờ, đừng kết luận sớm.
 */
export function useAuthBooting(): boolean {
  return useContext(BootPhaseContext) !== "ok";
}

/**
 * Guard phía client (SPEC-auth §9): cookie phiên là HttpOnly nên JS không "có token" để kiểm — hỏi server
 * `GET /auth/me` (hubFetch tự refresh một lần khi 401; hỏng thì về /login). Việc chặn thật nằm ở server.
 *
 * ADR-238: KHÔNG ẩn cây nữa (trang trắng 10–60s lúc Render cold start). Khung app + trang render ngay với khung chờ; dữ
 * liệu bảo vệ vẫn không thể hiện trước khi auth xong vì mọi request `/api/v1/*` bị giữ ở cổng (`lib/hub/auth-gate.ts`)
 * tới khi phiên xác nhận + project đã chọn. Socket chỉ nối sau đó.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<BootPhase>("pending");
  const [attempt, setAttempt] = useState(0);

  // Layout effect: chạy TRƯỚC mọi passive effect của con (nơi react-query bắn request) — cổng đóng kịp.
  useLayoutEffect(() => {
    holdAuthGate();
    return releaseAuthGate;
  }, []);

  useEffect(() => {
    // `attempt` = lượt bấm "Thử lại"; mỗi lượt là một vòng khởi động mới.
    void attempt;
    return runBoot({
      onPhase: setPhase,
      onReady: ({ me, projects }) => {
        // AU3: chọn project hợp lệ (đã nhớ nếu còn quyền, không thì cái đầu) TRƯỚC khi mở cổng — mọi /api/v1/* cần
        // ?projectId=. Lựa chọn nhớ theo user; mặc định project mình là thành viên (sửa lỗi "stale project").
        ensureProject(projects, me.user.id);
        useMeStore.setState({ me });
        // Bộ chọn dự án dùng ngay danh sách vừa tải (cùng khoá với useProjects) — không chờ lượt đọc thứ hai.
        queryClient.setQueryData(["projects"], projects);
      },
      onLogin: () => router.replace(LOGIN_PATH),
    });
  }, [attempt, router, queryClient]);

  return (
    <BootPhaseContext.Provider value={phase}>
      {phase === "ok" && <Realtime />}
      {children}
      {(phase === "slow" || phase === "failed") && (
        <BootNotice failed={phase === "failed"} onRetry={() => setAttempt((a) => a + 1)} />
      )}
    </BootPhaseContext.Provider>
  );
}

/** Thông báo nhỏ, KHÔNG chặn (góc dưới, không đè nội dung): server đang thức / chưa kết nối được + Thử lại. */
function BootNotice({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const t = useT();
  return (
    <div
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-center"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border bg-popover px-4 py-2 text-popover-foreground text-sm shadow-md">
        {failed ? (
          <ServerCrash className="size-4 shrink-0 text-destructive" aria-hidden />
        ) : (
          <Spinner />
        )}
        <span className="min-w-0">{t(failed ? "admin.boot.failed" : "admin.boot.slow")}</span>
        {failed && (
          <Button size="sm" variant="outline" className="h-7 shrink-0 rounded-full" onClick={onRetry}>
            <RotateCw />
            {t("common.retry")}
          </Button>
        )}
      </div>
    </div>
  );
}
