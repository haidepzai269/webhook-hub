"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { type PlaygroundPrefill, takePlaygroundPrefill } from "@/components/flow/prefill";

import Link from "next/link";

import { useQueryClient } from "@tanstack/react-query";
import { Send, Shuffle } from "lucide-react";

import { JsonBlock } from "@/components/admin/copy-button";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEMO_SIMULATE, HUB_API_URL } from "@/lib/env";
import { useSources } from "@/lib/hub/queries";
import type { Provider } from "@/lib/hub/types";

import { buildRequest, samplePayload } from "./_components/build-request";

interface SendResult {
  status: number;
  ms: number;
  url: string;
  requestHeaders: Record<string, string>;
  body: unknown;
}

// Chỉ để tiện demo ở LOCAL (ADR-027): điền sẵn API key SePay seed. Deployed không đặt biến này.
// Gate bằng DEMO_SIMULATE: lỡ đặt biến key ở deployed thì vẫn không dùng tới.
const DEMO_SEPAY_APIKEY = DEMO_SIMULATE ? (process.env.NEXT_PUBLIC_DEMO_SEPAY_APIKEY ?? "") : "";

/** S2-4: PayOS cũng có ô khoá — Playground ký `data` bằng checksum key như PayOS thật. */
const SECRET_LABEL: Record<Provider, string> = {
  sepay: "API key",
  payos: "Checksum key",
  github: "Secret để ký",
  stripe: "Secret để ký",
};

export default function PlaygroundPage() {
  const qc = useQueryClient();
  const sources = useSources();
  const [sourceId, setSourceId] = useState<string>("");
  const [secret, setSecret] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const source = useMemo(() => sources.data?.find((s) => s.id === sourceId), [sources.data, sourceId]);

  // "Tạo từ event này" (V1 Hành trình): điền sẵn source + body của event gốc — một lần.
  const prefill = useRef<PlaygroundPrefill | null>(null);
  useEffect(() => {
    const p = takePlaygroundPrefill();
    if (p) {
      prefill.current = p;
      if (p.sourceId) setSourceId(p.sourceId);
    }
  }, []);

  // Chọn sẵn nguồn đầu tiên khi danh sách về.
  useEffect(() => {
    if (!sourceId && sources.data?.length) setSourceId(sources.data[0].id);
  }, [sources.data, sourceId]);

  // Đổi nguồn → nạp payload mẫu của provider đó.
  useEffect(() => {
    if (!source) return;
    const p = prefill.current;
    if (p && (!p.sourceId || p.sourceId === source.id) && p.body !== null && p.body !== undefined) {
      prefill.current = null;
      setBody(typeof p.body === "string" ? p.body : JSON.stringify(p.body, null, 2));
    } else {
      setBody(JSON.stringify(samplePayload(source.provider), null, 2));
    }
    setSecret(source.provider === "sepay" ? DEMO_SEPAY_APIKEY : "");
    setResult(null);
  }, [source]);

  const send = async () => {
    if (!source) return;
    setSending(true);
    setSendError(null);
    setResult(null);
    const url = `${HUB_API_URL}${source.webhookUrl}`;
    try {
      const req = await buildRequest(source.provider, body, secret);
      // PayOS: Playground ký lại body -> hiện đúng bản đã gửi để "Gửi lại" ra 200 duplicate.
      if (req.body !== body) setBody(req.body);
      const t0 = performance.now();
      const res = await fetch(url, { method: "POST", headers: req.headers, body: req.body });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // giữ nguyên text
      }
      setResult({
        status: res.status,
        ms: Math.round(performance.now() - t0),
        url,
        requestHeaders: req.headers,
        body: parsed,
      });
      // Socket cũng sẽ đẩy event.received, nhưng invalidate ngay để không phải chờ.
      void qc.invalidateQueries({ queryKey: ["events"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const ok = result && result.status >= 200 && result.status < 300;

  return (
    <>
      <PageHeader
        title="Playground"
        description="Bắn một webhook thử vào hub, ký đúng như provider thật — rồi xem nó chảy qua Sự kiện → Deliveries."
      />
      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Yêu cầu</CardTitle>
            <CardDescription>Gửi thẳng từ trình duyệt tới {HUB_API_URL}/hooks/…</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel>Nguồn</FieldLabel>
                <Select value={sourceId} onValueChange={setSourceId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={sources.isLoading ? "Đang tải…" : "Chọn nguồn"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(sources.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} · {s.provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!sources.isLoading && !sources.data?.length && (
                  <FieldDescription>
                    Chưa có nguồn —{" "}
                    <Link href="/dashboard/sources" className="underline">
                      tạo một nguồn
                    </Link>{" "}
                    trước.
                  </FieldDescription>
                )}
                {source && (
                  <FieldDescription className="break-all font-mono text-xs">
                    POST {HUB_API_URL}
                    {source.webhookUrl}
                  </FieldDescription>
                )}
              </Field>

              {source && (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="pg-secret">{SECRET_LABEL[source.provider]}</FieldLabel>
                  <Input
                    id="pg-secret"
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="Để trống = gửi chữ ký sai"
                  />
                  <FieldDescription>
                    Tính HMAC ngay trong trình duyệt (WebCrypto), không gửi secret đi đâu. Để trống để xem hub trả 401.
                  </FieldDescription>
                </Field>
              )}

              <Field className="gap-1.5">
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="pg-body">Body (gửi nguyên văn)</FieldLabel>
                  {source && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setBody(JSON.stringify(samplePayload(source.provider), null, 2))}
                    >
                      <Shuffle />
                      Mẫu mới
                    </Button>
                  )}
                </div>
                <Textarea
                  id="pg-body"
                  rows={12}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="font-mono text-xs"
                  spellCheck={false}
                />
                <FieldDescription>
                  Gửi lại đúng body này hai lần (cùng id) để thấy idempotency: lần hai không tạo sự kiện mới.
                </FieldDescription>
              </Field>

              <Button onClick={() => void send()} disabled={!source || sending}>
                <Send />
                {sending ? "Đang gửi…" : "Gửi webhook"}
              </Button>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Phản hồi
              {result && (
                <Badge className={ok ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"}>
                  HTTP {result.status}
                </Badge>
              )}
              {result && <span className="font-normal text-muted-foreground text-xs">{result.ms}ms</span>}
            </CardTitle>
            <CardDescription>
              Hub chỉ trả 2xx SAU khi COMMIT raw event vào Postgres (BB-3) — 2xx nghĩa là sự kiện không thể mất.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {sendError && <p className="text-destructive text-sm">Không gửi được: {sendError}</p>}
            {!result && !sendError && <p className="text-muted-foreground text-sm">Chưa gửi gì.</p>}
            {result && (
              <>
                <div className="space-y-1.5">
                  <h3 className="font-medium text-sm">Body phản hồi</h3>
                  <JsonBlock value={result.body} maxHeight="16rem" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="font-medium text-sm">Header đã gửi</h3>
                  <JsonBlock value={result.requestHeaders} maxHeight="12rem" />
                </div>
                {ok && (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/dashboard/events">Xem trong Sự kiện →</Link>
                  </Button>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
