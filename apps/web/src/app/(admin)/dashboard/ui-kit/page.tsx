"use client";

import { Eye, Inbox, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { CopyButton, JsonBlock } from "@/components/admin/copy-button";
import { SearchInput } from "@/components/admin/search-input";
import { SecretOnce } from "@/components/admin/secret-once";
import { Spinner } from "@/components/admin/spinner";
import { ConfirmDialog, useConfirm } from "@/components/admin/confirm-dialog";
import { DataTable, type HubColumn } from "@/components/admin/data-table";
import { GridList, GridListRow } from "@/components/admin/grid-list";
import { IconButton } from "@/components/admin/icon-button";
import { MonoId } from "@/components/admin/mono-id";
import { PageHeader } from "@/components/admin/page-header";
import { SimpleTable } from "@/components/admin/simple-table";
import { CardSkeleton, DetailSkeleton, PageSkeleton, TableRowsSkeleton } from "@/components/admin/skeletons";
import { EmptyState, ErrorState } from "@/components/admin/state";
import { TimeCell } from "@/components/admin/time-cell";
import { DeliveryStatusBadge, type StatusTone, StatusBadge } from "@/components/admin/status-badge";
import { UsageMeter } from "@/components/storage/usage-meter";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TONE_VAR } from "@/components/flow/tokens";
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

interface DemoRow {
  id: string;
  name: string;
  status: number;
  at: string;
}

const NOW = Date.parse("2026-10-17T10:00:00Z");
const DEMO_ROWS: DemoRow[] = [
  { id: "7f3a9c21-5b1e-4d77-9a10-0c2e8b6d4a11", name: "payos-orders", status: 200, at: new Date(NOW - 45_000).toISOString() },
  { id: "b21c4e90-1a2d-4f60-8e33-71d5c9f0a2b4", name: "github-push", status: 500, at: new Date(NOW - 3_600_000).toISOString() },
  { id: "0e6d1f48-93bc-4a52-b7d1-5e8a3c2f9d60", name: "stripe-events", status: 429, at: new Date(NOW - 86_400_000).toISOString() },
];

const DEMO_COLUMNS: HubColumn<DemoRow>[] = [
  { id: "name", header: "Tên (sắp xếp được)", accessorFn: (r) => r.name, cell: ({ row }) => <span className="font-medium">{row.original.name}</span>, enableHiding: false },
  { id: "id", header: "Mã", enableSorting: false, cell: ({ row }) => <MonoId id={row.original.id} copy /> },
  { id: "status", header: "HTTP", accessorFn: (r) => String(r.status), cell: ({ row }) => <StatusBadge tone={httpTone(row.original.status)}>{row.original.status}</StatusBadge> },
  { id: "at", header: "Lúc", accessorFn: (r) => r.at, cell: ({ row }) => <TimeCell iso={row.original.at} /> },
];

const DEMO_TONE = { ok: TONE_VAR.healthy, warn: TONE_VAR.warning, bad: TONE_VAR.crashed, info: TONE_VAR.progress, idle: TONE_VAR.idle, progress: TONE_VAR.progress } as const;

const GRID_TEMPLATE = "7rem minmax(0,1fr) 6rem";

export default function UiKitPage() {
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(false);
  const [env, setEnv] = useState("test");
  const [tab, setTab] = useState("all");
  const [line, setLine] = useState("a");
  const [pick, setPick] = useState("x");
  const [search, setSearch] = useState("");
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

        <Section title="ConfirmDialog / useConfirm" hint="Thay hộp confirm của trình duyệt. ConfirmDialog (controlled) KHÔNG tự đóng khi xác nhận — nơi gọi truyền pending và đóng khi xong. useConfirm() đóng ngay khi chọn, không có pending.">
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

        <Section title="EmptyState / ErrorState" hint="Trạng thái rỗng (size md/sm, icon hoặc illustration, action) và lỗi tải (dựa trên Alert destructive; onRetry hiện nút Thử lại; inline = một dòng).">
          <div className="grid w-full gap-4 md:grid-cols-2">
            <EmptyState icon={<Inbox />} title="Chưa có nguồn nào" description="Tạo nguồn đầu tiên để nhận webhook." action={<Button size="sm">Tạo nguồn</Button>} />
            <div className="grid content-start gap-3">
              <EmptyState size="sm" icon={<Inbox />} title="Không có kết quả" description="Thử bỏ bớt bộ lọc." />
              <ErrorState message="Không tải được danh sách: timeout" onRetry={() => undefined} />
              <ErrorState inline message="Không tải được biểu đồ" onRetry={() => undefined} />
            </div>
          </div>
        </Section>

        <Section title="TimeCell / MonoId" hint='TimeCell mode relative (mặc định) | absolute | both — tooltip là phần còn lại. MonoId: mono, rút gọn 8 ký tự, tooltip đủ mã, copy tuỳ chọn; n="full" cắt bằng CSS.'>
          <TimeCell iso={new Date(Date.now() - 300_000).toISOString()} />
          <TimeCell iso={new Date(Date.now() - 300_000).toISOString()} mode="absolute" />
          <TimeCell iso={new Date(Date.now() - 300_000).toISOString()} mode="both" />
          <TimeCell iso={null} />
          <MonoId id="7f3a9c21-5b1e-4d77-9a10-0c2e8b6d4a11" />
          <MonoId id="7f3a9c21-5b1e-4d77-9a10-0c2e8b6d4a11" copy />
          <div className="w-48">
            <MonoId id="7f3a9c21-5b1e-4d77-9a10-0c2e8b6d4a11" n="full" copy />
          </div>
        </Section>

        <Section title="DataTable" hint="Bấm tiêu đề để sắp xếp (aria-sort; enableSorting:false thì tắt). Hàng bấm được: Tab tới hàng, Enter/Space kích hoạt. footer = chỗ của CursorPager (kèm ghi chú 'trong trang này').">
          <div className="w-full">
            <DataTable
              data={DEMO_ROWS}
              columns={DEMO_COLUMNS}
              getRowId={(r) => r.id}
              pageSize={false}
              searchPlaceholder="Tìm trong bảng"
              onRowClick={(r) => setAnswer(`hàng ${r.name}`)}
              footer={<span className="text-muted-foreground text-xs">footer (CursorPager)</span>}
            />
          </div>
        </Section>

        <Section title="SimpleTable" hint="Bảng nhỏ không cần sắp xếp/phân trang; cùng token khung/tiêu đề với DataTable. loading / error / empty có sẵn.">
          <div className="grid w-full gap-3">
            <SimpleTable
              rows={DEMO_ROWS}
              getRowKey={(r) => r.id}
              columns={[
                { key: "name", header: "Tên", cell: (r) => r.name },
                { key: "status", header: "HTTP", align: "right", cell: (r) => r.status },
              ]}
            />
            <SimpleTable rows={[]} getRowKey={(r: DemoRow) => r.id} columns={[{ key: "name", header: "Rỗng", cell: (r: DemoRow) => r.name }]} empty="Chưa có dữ liệu" />
            <SimpleTable rows={undefined} loading getRowKey={(r: DemoRow) => r.id} columns={[{ key: "name", header: "Đang tải", cell: (r: DemoRow) => r.name }, { key: "x", header: "Cột", cell: () => null }]} />
          </div>
        </Section>

        <Section title="GridList / GridListRow" hint="Danh sách lưới realtime (trang Sự kiện, ngăn Nhật ký): tiêu đề, hàng bấm được (div role=button hoặc href), viền trái theo tone, trạng thái rỗng/tải/lỗi. Cuộn vô hạn/unroll do trang tự thêm.">
          <div className="w-full overflow-hidden rounded-xl border">
            <GridList template={GRID_TEMPLATE} headers={["Lúc", "Tên", "HTTP"]}>
              {DEMO_ROWS.map((r) => (
                <GridListRow key={r.id} tone={DEMO_TONE[httpTone(r.status)]} onActivate={() => setAnswer(`lưới: ${r.name}`)}>
                  <TimeCell iso={r.at} />
                  <span className="truncate">{r.name}</span>
                  <StatusBadge tone={httpTone(r.status)}>{r.status}</StatusBadge>
                </GridListRow>
              ))}
            </GridList>
          </div>
          <div className="w-full overflow-hidden rounded-xl border">
            <GridList template={GRID_TEMPLATE} headers={["Lúc", "Tên", "HTTP"]} isEmpty emptyText="Không có dòng nào" />
          </div>
        </Section>

        <Section title="Skeleton (PageSkeleton / CardSkeleton / DetailSkeleton / TableRowsSkeleton)" hint="Dùng thay Skeleton h-xx trần. Suspense fallback của trang danh sách = PageSkeleton.">
          <div className="grid w-full gap-4 md:grid-cols-2">
            <CardSkeleton lines={4} />
            <DetailSkeleton rows={3} />
            <div className="md:col-span-2">
              <PageSkeleton />
            </div>
            <Table>
              <TableBody>
                <TableRowsSkeleton cols={4} rows={3} />
              </TableBody>
            </Table>
          </div>
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

        <Section title="Badge size" hint='size="sm" = chữ 11px (text-2xs) cho badge dày đặc trong bảng/dòng phụ. Đừng viết text-[11px] / text-[10px].'>
          <Badge variant="outline">default</Badge>
          <Badge variant="outline" size="sm">sm</Badge>
          <Badge variant="secondary" size="sm" className="font-mono">payment.*</Badge>
          <StatusBadge tone="ok">StatusBadge (đã sm)</StatusBadge>
          <span className="text-2xs text-muted-foreground">dòng phụ text-2xs</span>
        </Section>

        <Section title="SearchInput" hint='Ô tìm kiếm có icon kính lúp (pointer-events-none). size="sm" cao 7 cho thanh lọc dày; wrapperClassName đặt chiều rộng.'>
          <SearchInput wrapperClassName="w-56" placeholder="Tìm…" aria-label="Tìm" value={search} onChange={(e) => setSearch(e.target.value)} />
          <SearchInput size="sm" wrapperClassName="w-48" placeholder="Tìm (sm)…" aria-label="Tìm nhỏ" className="text-xs" />
        </Section>

        <Section title="Spinner" hint='Thay Loader2/LoaderCircle + animate-spin. size auto|sm|md|lg; có label thì là role=status. Button loading đã dùng sẵn.'>
          <Spinner size="sm" />
          <Spinner />
          <Spinner size="lg" label="Đang tải" />
          <Button loading>Đang lưu</Button>
        </Section>

        <Section title="UsageMeter" hint="Mức dùng dung lượng theo nấc OK / 70 / 85 / 95: inline (cột bảng) · bar (thẻ dự án) · card (trang Dung lượng).">
          <div className="grid w-full gap-4 md:grid-cols-3">
            {(["OK", "WARN_85", "CRITICAL_95"] as const).map((level, i) => (
              <div key={level} className="space-y-3">
                <UsageMeter usage={{ usedPct: [30, 86, 100][i], usedBytes: [3, 86, 100][i] * 1024 * 1024, quotaBytes: 100 * 1024 * 1024, level }} />
                <UsageMeter variant="bar" label="Dung lượng" usage={{ usedPct: [30, 86, 100][i], usedBytes: [3, 86, 100][i] * 1024 * 1024, quotaBytes: 100 * 1024 * 1024, level }} />
                <UsageMeter variant="card" label="Dung lượng" aside={<span>dự báo: còn ~5 ngày</span>} usage={{ usedPct: [30, 86, 100][i], usedBytes: [3, 86, 100][i] * 1024 * 1024, quotaBytes: 100 * 1024 * 1024, level }} />
              </div>
            ))}
          </div>
        </Section>

        <Section title="CopyButton / JsonBlock" hint='CopyButton variant="icon" (mặc định, IconButton nhỏ) hoặc "labeled" (nút outline có chữ). JsonBlock = JsonViewer + nút chép.'>
          <CopyButton value="whsec_demo" />
          <CopyButton value="whsec_demo" variant="labeled" />
          <div className="w-full">
            <JsonBlock value={{ id: "evt_1", type: "payment.succeeded", data: { amount: 120000, currency: "VND" } }} maxHeight="10rem" />
          </div>
        </Section>

        <Section title="SecretOnce" hint="Hộp 'chỉ hiện một lần' cho secret / connection string. value = đúng dòng được chép; hint tuỳ chọn.">
          <div className="w-full">
            <SecretOnce
              title="Secret ký — chỉ hiện một lần"
              value="HUB_SIGNING_SECRET=whsec_demo_000000"
              hint="Dán vào biến môi trường của service nhận rồi đóng hộp này."
            />
          </div>
        </Section>

        <Section title="PageHeader (back / adornment / meta) và Card inset" hint="PageHeader: back = '← quay lại', adornment = pill cạnh h1, meta = dòng mã + chép. Card variant=inset là ô phụ trong một khối (thay div rounded-md border p-3). Canvas/flow giữ flow-surface.">
          <div className="w-full">
            <PageHeader
              className="mb-3"
              back={{ href: "/dashboard/events", label: "Quay lại" }}
              title="Chi tiết sự kiện"
              adornment={<StatusBadge tone="ok">Thành công</StatusBadge>}
              meta={<MonoId id="7f3a9c21-5b1e-4d77-9a10-0c2e8b6d4a11" copy />}
              actions={<Button size="sm" variant="outline">Hành động</Button>}
            />
            <Card variant="inset" className="text-sm">
              Ô phụ (Card variant=&quot;inset&quot;): viền mảnh, không ring, p-3.
            </Card>
          </div>
        </Section>
      </div>
    </>
  );
}
