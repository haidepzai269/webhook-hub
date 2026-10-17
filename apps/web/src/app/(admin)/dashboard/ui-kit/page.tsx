"use client";

import { Eye, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { ConfirmDialog, useConfirm } from "@/components/admin/confirm-dialog";
import { IconButton } from "@/components/admin/icon-button";
import { PageHeader } from "@/components/admin/page-header";
import { DeliveryStatusBadge, type StatusTone, StatusBadge } from "@/components/admin/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { httpTone } from "@/lib/hub/format";

/**
 * Trang showcase component dùng chung (dev-only, không có trong sidebar): mở /dashboard/ui-kit.
 * Dữ liệu tĩnh — KHÔNG gọi hub-api. Cần UI nào thì copy từ đây thay vì tự chế (xem ADR-245).
 * Nhãn ở đây là chữ cố định (trang công cụ cho dev, không phải giao diện người dùng cuối).
 */

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {hint && <CardDescription>{hint}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">{children}</CardContent>
    </Card>
  );
}

const TONES: StatusTone[] = ["ok", "warn", "bad", "info", "idle", "progress"];

export default function UiKitPage() {
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(false);
  const [env, setEnv] = useState("test");
  const [tab, setTab] = useState("all");
  const [line, setLine] = useState("a");
  const [pick, setPick] = useState("x");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const [answer, setAnswer] = useState<string>("—");

  return (
    <>
      <PageHeader title="UI kit" description="Component dùng chung của console — copy từ đây, đừng tự dựng lại." />
      <div className="grid gap-4">
        <Section title="Button" hint="variant · size · loading · replay. Mặc định cursor-pointer.">
          <Button>default</Button>
          <Button variant="outline">outline</Button>
          <Button variant="secondary">secondary</Button>
          <Button variant="ghost">ghost</Button>
          <Button variant="destructive">destructive</Button>
          <Button variant="link">link</Button>
          <Button variant="replay">replay</Button>
          <Button size="sm">sm</Button>
          <Button size="xs">xs</Button>
          <Button loading>loading</Button>
          <Button variant="outline" disabled>
            disabled
          </Button>
        </Section>

        <Section title="IconButton" hint="Button + Tooltip + aria-label. Nút chỉ có icon dùng size icon-sm (mặc định). Xoá ở hàng bảng: ghost.">
          <IconButton icon={<Eye />} label="Xem nhanh" />
          <IconButton icon={<Trash2 />} label="Xoá dòng" tooltip="Xoá" />
          <IconButton icon={<Eye />} label="Outline" variant="outline" size="icon" />
          <IconButton icon={<Eye />} label="Cỡ xs" size="icon-xs" />
        </Section>

        <Section title="ConfirmDialog / useConfirm" hint="Thay hộp confirm của trình duyệt. Hộp không tự đóng — nơi gọi đóng khi mutation xong.">
          <Button variant="outline" onClick={() => setOpen(true)}>
            ConfirmDialog (controlled)
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              const ok = await confirm({ title: "Xoá đích này?", description: "Không hoàn tác được.", confirmLabel: "Xoá", destructive: true });
              setAnswer(ok ? "đã xác nhận" : "đã huỷ");
            }}
          >
            useConfirm() → Promise
          </Button>
          <span className="text-muted-foreground text-sm">kết quả: {answer}</span>
          {confirmDialog}
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Thu hồi khoá?"
            description="Dịch vụ dùng khoá này sẽ bị từ chối ngay."
            confirmLabel="Thu hồi"
            destructive
            pending={busy}
            onConfirm={() => {
              setBusy(true);
              setTimeout(() => {
                setBusy(false);
                setOpen(false);
              }, 900);
            }}
          />
        </Section>

        <Section title="StatusBadge" hint="Một bộ tone: ok · warn · bad · info · idle · progress. dot / pulse / tooltip tuỳ chọn.">
          {TONES.map((tone) => (
            <StatusBadge key={tone} tone={tone} dot>
              {tone}
            </StatusBadge>
          ))}
          <StatusBadge tone="progress" pulse tooltip="Đang chạy">
            pulse + tooltip
          </StatusBadge>
          <DeliveryStatusBadge status="SUCCEEDED" />
          <DeliveryStatusBadge status="RETRYING" />
          <DeliveryStatusBadge status="DEAD" />
          {[200, 408, 429, 500, null].map((code) => (
            <StatusBadge key={String(code)} tone={httpTone(code)} className="font-mono">
              {code ? `HTTP ${code}` : "không phản hồi"}
            </StatusBadge>
          ))}
        </Section>

        <Section title="Alert" hint="info · warning · destructive · success; AlertTitle / AlertDescription / AlertAction.">
          <div className="grid w-full gap-3">
            <Alert variant="info">
              <AlertTitle>Thông tin</AlertTitle>
              <AlertDescription>Nội dung giải thích ngắn.</AlertDescription>
            </Alert>
            <Alert variant="warning">
              <AlertTitle>Chỉ hiện một lần</AlertTitle>
              <AlertDescription>Đóng hộp là mất, hub không hiện lại.</AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <AlertTitle>Lỗi</AlertTitle>
              <AlertDescription>Không tải được dữ liệu.</AlertDescription>
              <AlertAction>
                <Button size="xs" variant="outline">
                  Thử lại
                </Button>
              </AlertAction>
            </Alert>
            <Alert variant="success">
              <AlertDescription>Đã lưu.</AlertDescription>
            </Alert>
          </div>
        </Section>

        <Section title="Checkbox / Switch / RadioGroup" hint="Bọc trong <label> để bấm vào chữ cũng bật.">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
            Checkbox
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={on} onCheckedChange={setOn} />
            Switch
          </label>
          <RadioGroup value={env} onValueChange={setEnv} className="flex gap-4 text-sm">
            <label className="flex cursor-pointer items-center gap-1.5">
              <RadioGroupItem value="test" />
              test
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <RadioGroupItem value="live" />
              live
            </label>
          </RadioGroup>
        </Section>

        <Section title="Tabs" hint="variant segmented (thanh công cụ) và line (gạch chân). Không còn role=tab tự dựng.">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList variant="segmented">
              <TabsTrigger value="all">Tất cả</TabsTrigger>
              <TabsTrigger value="ok">Thành công</TabsTrigger>
              <TabsTrigger value="bad">Lỗi</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={line} onValueChange={setLine} className="min-w-64">
            <TabsList variant="line">
              <TabsTrigger value="a">Một</TabsTrigger>
              <TabsTrigger value="b">Hai</TabsTrigger>
            </TabsList>
          </Tabs>
        </Section>

        <Section title="Select" hint='Thay thẻ select gốc: SelectTrigger size="sm".'>
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger size="sm" aria-label="Chọn một">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="x">Lựa chọn X</SelectItem>
              <SelectItem value="y">Lựa chọn Y</SelectItem>
            </SelectContent>
          </Select>
        </Section>
      </div>
    </>
  );
}
