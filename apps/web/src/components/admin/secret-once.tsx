"use client";

import type { ReactNode } from "react";

import { CopyButton } from "@/components/admin/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Hộp "chỉ hiện một lần" MỘT kiểu (ADR-247) — secret/connection string đóng hộp là mất, hub không hiện lại
 * (SPEC-ket-noi §3.2, SPEC-shop-ket-noi-project §3). `value` là đúng dòng sẽ được sao chép (vd. `HUB_SIGNING_SECRET=whsec_…`);
 * `hint` là dòng nhắc nhỏ bên dưới; `copyLabel` đổi chữ nút ("Sao chép" mặc định).
 */
export function SecretOnce({
  title,
  value,
  hint,
  copyLabel,
}: {
  title: string;
  value: string;
  hint?: ReactNode;
  copyLabel?: string;
}) {
  return (
    <Alert variant="warning">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="w-full">
        <div className="flex w-full items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-foreground text-xs">{value}</code>
          <CopyButton variant="labeled" value={value} label={copyLabel} />
        </div>
        {hint ? <p className="text-xs">{hint}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
