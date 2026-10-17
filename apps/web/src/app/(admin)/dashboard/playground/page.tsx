"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { type PlaygroundPrefill, takePlaygroundPrefill } from "@/components/flow/prefill";

import Link from "next/link";

import { useQueryClient } from "@tanstack/react-query";
import { Send, Shuffle } from "lucide-react";

import { JsonBlock } from "@/components/admin/copy-button";
import { PageHeader } from "@/components/admin/page-header";
import { ErrorState } from "@/components/admin/state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEMO_SIMULATE, HUB_API_URL } from "@/lib/env";
import { playgroundSources } from "@/lib/hub/listen-logic";
import { useSources } from "@/lib/hub/queries";
import type { Provider } from "@/lib/hub/types";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";
import { StatusBadge } from "@/components/admin/status-badge";

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
const SECRET_LABEL: Record<Provider, MessageKey> = {
  sepay: "page.playground.secret.sepay",
  payos: "page.playground.secret.payos",
  github: "page.playground.secret.sign",
  stripe: "page.playground.secret.sign",
  // Review PK1 TB-1: nguồn generic bị lọc khỏi Playground (`playgroundSources`) — khoá này chỉ để đủ kiểu, không hiện.
  generic: "page.playground.secret.sign",
};

export default function PlaygroundPage() {
  const t = useT();
  const qc = useQueryClient();
  const sources = useSources();
  const [sourceId, setSourceId] = useState<string>("");
  const [secret, setSecret] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // Review PK1 TB-1: bỏ nguồn generic — Playground chưa ký theo cấu hình riêng của nguồn (luôn 401, dev tưởng cấu hình sai).
  const { usable, hiddenGeneric } = useMemo(() => playgroundSources(sources.data), [sources.data]);
  const source = useMemo(() => usable.find((s) => s.id === sourceId), [usable, sourceId]);

  // "Tạo từ event này" (V1 Hành trình): điền sẵn source + body của event gốc — một lần.
  const prefill = useRef<PlaygroundPrefill | null>(null);
  useEffect(() => {
    const p = takePlaygroundPrefill();
    if (p) {
      prefill.current = p;
      if (p.sourceId) setSourceId(p.sourceId);
    }
  }, []);

  // Chọn sẵn nguồn đầu tiên khi danh sách về (cả khi id điền sẵn là nguồn generic đã bị lọc).
  useEffect(() => {
    if (!source && usable.length) setSourceId(usable[0].id);
  }, [usable, source]);

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
      const req = await buildRequest(source.provider, body, secret, t);
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
        title={t("page.playground.title")}
        description={t("page.playground.description")}
      />
      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("page.playground.request.title")}</CardTitle>
            <CardDescription>{t("page.playground.request.desc", { url: HUB_API_URL })}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel>{t("page.playground.field.source")}</FieldLabel>
                <Select value={sourceId} onValueChange={setSourceId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={sources.isLoading ? t("common.loading") : t("page.playground.field.source-placeholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {usable.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} · {s.provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {hiddenGeneric > 0 && <FieldDescription>{t("page.playground.generic-hidden", { count: hiddenGeneric })}</FieldDescription>}
                {!sources.isLoading && !usable.length && !hiddenGeneric && (
                  <FieldDescription>
                    {t("page.playground.no-sources.before")}{" "}
                    <Link href="/dashboard/sources" className="underline">
                      {t("page.playground.no-sources.link")}
                    </Link>{" "}
                    {t("page.playground.no-sources.after")}
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
                  <FieldLabel htmlFor="pg-secret">{t(SECRET_LABEL[source.provider])}</FieldLabel>
                  <Input
                    id="pg-secret"
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={t("page.playground.secret.placeholder")}
                  />
                  <FieldDescription>
                    {t("page.playground.secret.hint")}
                  </FieldDescription>
                </Field>
              )}

              <Field className="gap-1.5">
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="pg-body">{t("page.playground.body.label")}</FieldLabel>
                  {source && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setBody(JSON.stringify(samplePayload(source.provider), null, 2))}
                    >
                      <Shuffle />
                      {t("page.playground.body.sample")}
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
                  {t("page.playground.body.hint")}
                </FieldDescription>
              </Field>

              <Button onClick={() => void send()} disabled={!source || sending}>
                <Send />
                {sending ? t("page.playground.sending") : t("page.playground.send")}
              </Button>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {t("page.playground.response.title")}
              {result && (
                <StatusBadge tone={ok ? "ok" : "bad"} className="font-mono">
                  HTTP {result.status}
                </StatusBadge>
              )}
              {result && <span className="font-normal text-muted-foreground text-xs">{result.ms}ms</span>}
            </CardTitle>
            <CardDescription>
              {t("page.playground.response.desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {sendError && <ErrorState message={t("page.playground.send-error", { message: sendError })} />}
            {!result && !sendError && <p className="text-muted-foreground text-sm">{t("page.playground.nothing-sent")}</p>}
            {result && (
              <>
                <div className="space-y-1.5">
                  <h3 className="font-medium text-sm">{t("page.playground.response.body")}</h3>
                  <JsonBlock value={result.body} maxHeight="16rem" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="font-medium text-sm">{t("page.playground.response.headers")}</h3>
                  <JsonBlock value={result.requestHeaders} maxHeight="12rem" />
                </div>
                {ok && (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/dashboard/events">{t("page.playground.view-events")}</Link>
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
