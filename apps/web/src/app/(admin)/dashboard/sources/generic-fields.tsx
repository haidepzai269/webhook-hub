"use client";

import { type Control, Controller, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ACK_REJECT_CHOICES,
  ACK_SUCCESS_CHOICES,
  AFTER_VERIFY_CHOICES,
  ECHO_RESPOND_CHOICES,
  ALGO_IN_PREFIX,
  FORWARD_HEADERS_MAX,
  FORWARD_URL_CHOICES,
  UNVERIFIED_MAX_BODY_KB,
  UNVERIFIED_SCHEME,
  UNVERIFIED_STORAGE_FACTOR,
  GENERIC_SCHEMES,
  type GenericFormValues,
  HANDSHAKE_CHOICES,
  HMAC_ALGO_CHOICES,
  ID_KIND_CHOICES,
  type IdKind,
  KEY_ENCODING_CHOICES,
  KV_SEP_CHOICES,
  needsHeader,
  needsPrefix,
  SIG_MODE_CHOICES,
  TEMPLATE_ALGO_CHOICES,
  TEMPLATE_PRESETS,
  type TemplatePreset,
  TIMESTAMP_FORMAT_CHOICES,
  TOKEN_LOCATION_CHOICES,
  WHEN_KIND_CHOICES,
} from "@/lib/hub/listen-logic";
import type { Provider } from "@/lib/hub/types";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** PK10 (E31): nhãn bốn kiểu khoá chống trùng. */
const ID_KIND_KEY: Record<IdKind, MessageKey> = {
  field: "page.sources.generic.id-kind.field",
  header: "page.sources.generic.id-kind.header",
  path: "page.sources.generic.id-kind.path",
  bodyHash: "page.sources.generic.id-kind.body-hash",
};

/**
 * Review PK2 T-7: khuôn ĐẦY ĐỦ của form tạo nguồn (trang `sources/page.tsx` khẳng định `z.infer` của schema = kiểu này) — các ô
 * generic gắn thẳng vào `Control<SourceFormValues>`, không ép kiểu.
 */
export type SourceFormValues = GenericFormValues & { provider: Provider; name: string; secret: string };

const SCHEME_KEY: Record<GenericFormValues["scheme"], MessageKey> = {
  hmac: "page.sources.generic.scheme.hmac",
  "signed-template": "page.sources.generic.scheme.signed-template",
  "static-token": "page.sources.generic.scheme.static-token",
  "standard-webhooks": "page.sources.generic.scheme.standard-webhooks",
  unverified: "page.sources.generic.scheme.unverified",
};
const FORWARD_URL_KEY: Record<GenericFormValues["forwardUrl"], MessageKey> = {
  no: "page.sources.generic.unverified.forward-url.no",
  yes: "page.sources.generic.unverified.forward-url.yes",
};
const ALGO_KEY: Record<GenericFormValues["algo"], MessageKey> = {
  sha256: "page.sources.generic.algo.sha256",
  sha512: "page.sources.generic.algo.sha512",
  sha1: "page.sources.generic.algo.sha1",
  "from-prefix": "page.sources.generic.algo.from-prefix",
};
const KEY_ENCODING_KEY: Record<GenericFormValues["keyEncoding"], MessageKey> = {
  utf8: "page.sources.generic.key-encoding.utf8",
  hex: "page.sources.generic.key-encoding.hex",
  base64: "page.sources.generic.key-encoding.base64",
};
const SIG_MODE_KEY: Record<GenericFormValues["sigMode"], MessageKey> = {
  headers: "page.sources.generic.sig-mode.headers",
  kv: "page.sources.generic.sig-mode.kv",
};
const TIMESTAMP_FORMAT_KEY: Record<GenericFormValues["timestampFormat"], MessageKey> = {
  unix: "page.sources.generic.timestamp-format.unix",
  "unix-ms": "page.sources.generic.timestamp-format.unix-ms",
  iso8601: "page.sources.generic.timestamp-format.iso8601",
};
const PRESET_KEY: Record<TemplatePreset, MessageKey> = {
  stripe: "page.sources.generic.preset.stripe",
  slack: "page.sources.generic.preset.slack",
  paddle: "page.sources.generic.preset.paddle",
};

const HANDSHAKE_KEY: Record<GenericFormValues["hsKind"], MessageKey> = {
  none: "page.sources.generic.hs.kind.none",
  "query-echo": "page.sources.generic.hs.kind.query-echo",
  "body-echo": "page.sources.generic.hs.kind.body-echo",
  "header-echo": "page.sources.generic.hs.kind.header-echo",
  "hmac-echo": "page.sources.generic.hs.kind.hmac-echo",
  "manual-url": "page.sources.generic.hs.kind.manual-url",
  "head-ok": "page.sources.generic.hs.kind.head-ok",
};
const AFTER_VERIFY_KEY: Record<GenericFormValues["hsAfterVerify"], MessageKey> = {
  no: "page.sources.generic.hs.after-verify.no",
  yes: "page.sources.generic.hs.after-verify.yes",
};
const RESPOND_KEY: Record<GenericFormValues["hsRespond"], MessageKey> = {
  text: "page.sources.generic.hs.respond.text",
  json: "page.sources.generic.hs.respond.json",
};
const WHEN_KIND_KEY: Record<GenericFormValues["hsWhenKind"], MessageKey> = {
  field: "page.sources.generic.hs.when-kind.field",
  header: "page.sources.generic.hs.when-kind.header",
};

const LOCATION_KEY: Record<GenericFormValues["location"], MessageKey> = {
  header: "page.sources.generic.location.header",
  basic: "page.sources.generic.location.basic",
  query: "page.sources.generic.location.query",
};

/** Một ô chọn (Select) gắn với form — các lựa chọn là cặp giá trị / nhãn. */
function SelectField({
  control,
  name,
  label,
  options,
  hint,
}: {
  control: Control<SourceFormValues>;
  name:
    | "scheme"
    | "algo"
    | "encoding"
    | "keyEncoding"
    | "location"
    | "idKind"
    | "sigMode"
    | "kvSep"
    | "timestampFormat"
    | "hsKind"
    | "hsWhenKind"
    | "hsAfterVerify"
    | "hsRespond"
    | "ackSuccess"
    | "ackReject"
    | "forwardUrl";
  label: string;
  options: readonly { value: string; label: string }[];
  hint?: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <Field className="gap-1.5">
          <FieldLabel>{label}</FieldLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hint && <FieldDescription>{hint}</FieldDescription>}
        </Field>
      )}
    />
  );
}

/** Một ô nhập chữ gắn với form, có lỗi theo ô. */
function TextField({
  control,
  name,
  id,
  label,
  placeholder,
  hint,
  wide = false,
}: {
  control: Control<SourceFormValues>;
  name:
    | "header"
    | "prefix"
    | "param"
    | "idValue"
    | "eventType"
    | "template"
    | "header2"
    | "kvSig"
    | "kvTimestamp"
    | "timestampHeader"
    | "idHeader"
    | "toleranceSec"
    | "hsParam"
    | "hsVerifyTokenParam"
    | "hsVerifyToken"
    | "hsWhenName"
    | "hsWhenEquals"
    | "hsEchoField"
    | "hsHeader"
    | "hsTokenParent"
    | "hsTokenField"
    | "hsMacField"
    | "hsUrlField"
    | "forwardHeaders";
  id: string;
  label: string;
  placeholder: string;
  hint: string;
  /** Ô dài (chuỗi ký) — chiếm cả hàng khi form xếp 2 cột (UI-MS review T2). */
  wide?: boolean;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field className={wide ? "gap-1.5 sm:col-span-2" : "gap-1.5"} data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input {...field} id={id} placeholder={placeholder} aria-invalid={fieldState.invalid} />
          <FieldDescription>{hint}</FieldDescription>
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

/**
 * PK1 (SPEC-provider-khac §3.1, ADR-202) + PK2 (§4, ADR-203): các ô tay của "Nhà cung cấp khác" (generic). PK7 thay bằng
 * form nhận diện. Ô nào hiện theo đúng luật của `validateGenericConfig`:
 * - `hmac`: tiêu đề, thuật toán (hoặc "đọc từ tiền tố"), mã hoá chữ ký, cách đọc khoá, tiền tố tĩnh;
 * - `static-token`: vị trí token — tiêu đề (+ tiền tố) | Basic (Authorization, secret "user:pass") | query (tên tham số);
 * - `standard-webhooks`: không ô nào (đọc bộ webhook-* / svix-*), khoá chống trùng luôn là tiêu đề;
 * - `signed-template` (PK3, ADR-204): chuỗi ký, thuật toán, chữ ký ở tiêu đề (1–2, + tiền tố) hoặc khoá=giá trị, nguồn
 *   timestamp + định dạng + độ lệch (khi có `{timestamp}`), tiêu đề `{id}`; ba nút điền nhanh chỉ điền sẵn giá trị.
 */
export function GenericFields({
  control,
  scheme,
  onPreset,
}: {
  control: Control<SourceFormValues>;
  scheme: GenericFormValues["scheme"];
  onPreset: (p: TemplatePreset) => void;
}) {
  const t = useT();
  const algo = useWatch({ control, name: "algo" });
  const location = useWatch({ control, name: "location" });
  const prefix = useWatch({ control, name: "prefix" });
  const sigMode = useWatch({ control, name: "sigMode" });
  const template = useWatch({ control, name: "template" });
  const kvTimestamp = useWatch({ control, name: "kvTimestamp" });
  const sw = scheme === "standard-webhooks";
  const tpl = scheme === "signed-template";
  const unv = scheme === UNVERIFIED_SCHEME;
  const forwardUrl = useWatch({ control, name: "forwardUrl" });
  const idKind = useWatch({ control, name: "idKind" });
  const v = { scheme, algo, location, sigMode };
  const hasTs = tpl && template.includes("{timestamp}");
  const tsInKv = sigMode === "kv" && kvTimestamp.trim() !== "";
  // Review PK2 T-6: gõ tay `<algo>=` = đọc thuật toán từ tiền tố -> ẩn ô thuật toán (form không gửi `algo`).
  const typedAlgoPrefix = scheme === "hmac" && algo !== "from-prefix" && prefix === ALGO_IN_PREFIX;
  const locationHint =
    location === "basic" ? t("page.sources.generic.location-basic-hint") : location === "query" ? t("page.sources.generic.location-query-hint") : undefined;
  const algoHint =
    algo === "sha1" ? t("page.sources.generic.algo-sha1-hint") : algo === "from-prefix" ? t("page.sources.generic.algo-from-prefix-hint") : undefined;
  return (
    <>
      <SelectField
        control={control}
        name="scheme"
        label={t("page.sources.generic.scheme")}
        options={GENERIC_SCHEMES.map((s) => ({ value: s, label: t(SCHEME_KEY[s]) }))}
      />
      {unv && (
        // PK5 (SPEC-provider-khac §7, ADR-206): bốn khoá phải nói rõ TRƯỚC khi tạo — hub không xác thực, project phải bật cờ,
        // đích phải tự bật nhận và tự verify chữ ký gốc; trần 45KB (E17); dung lượng ≈ 2,33× body (E26).
        <Alert variant="warning">
          <AlertTitle>{t("page.sources.generic.unverified.title")}</AlertTitle>
          <AlertDescription>
            {t("page.sources.generic.unverified.note", { kb: UNVERIFIED_MAX_BODY_KB, factor: UNVERIFIED_STORAGE_FACTOR.toLocaleString() })}
          </AlertDescription>
        </Alert>
      )}
      {unv && (
        <TextField
          control={control}
          name="forwardHeaders"
          id="src-forward-headers"
          label={t("page.sources.generic.unverified.forward-headers")}
          placeholder="x-twilio-signature"
          hint={t("page.sources.generic.unverified.forward-headers-hint", { max: FORWARD_HEADERS_MAX })}
        />
      )}
      {unv && (
        <SelectField
          control={control}
          name="forwardUrl"
          label={t("page.sources.generic.unverified.forward-url")}
          options={FORWARD_URL_CHOICES.map((c) => ({ value: c, label: t(FORWARD_URL_KEY[c]) }))}
          hint={t(forwardUrl === "yes" ? "page.sources.generic.unverified.forward-url-warning" : "page.sources.generic.unverified.forward-url-hint")}
        />
      )}
      {tpl && (
        <Field className="gap-1.5 sm:col-span-2">
          <FieldLabel>{t("page.sources.generic.preset")}</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TEMPLATE_PRESETS) as TemplatePreset[]).map((p) => (
              <Button key={p} type="button" size="sm" variant="outline" onClick={() => onPreset(p)}>
                {t(PRESET_KEY[p])}
              </Button>
            ))}
          </div>
          <FieldDescription>{t("page.sources.generic.preset-hint")}</FieldDescription>
        </Field>
      )}
      {tpl && (
        <TextField
          control={control}
          name="template"
          id="src-template"
          wide
          label={t("page.sources.generic.template")}
          placeholder="v0:{timestamp}:{body}"
          hint={t("page.sources.generic.template-hint")}
        />
      )}
      {tpl && (
        <SelectField
          control={control}
          name="sigMode"
          label={t("page.sources.generic.sig-mode")}
          options={SIG_MODE_CHOICES.map((m) => ({ value: m, label: t(SIG_MODE_KEY[m]) }))}
        />
      )}
      {scheme === "static-token" && (
        <SelectField
          control={control}
          name="location"
          label={t("page.sources.generic.location")}
          options={TOKEN_LOCATION_CHOICES.map((l) => ({ value: l, label: t(LOCATION_KEY[l]) }))}
          hint={locationHint}
        />
      )}
      {needsHeader(v) && (
        <TextField
          control={control}
          name="header"
          id="src-header"
          label={t("page.sources.generic.header")}
          placeholder="x-acme-signature"
          hint={t("page.sources.generic.header-hint")}
        />
      )}
      {scheme === "static-token" && location === "query" && (
        <TextField control={control} name="param" id="src-param" label={t("page.sources.generic.param")} placeholder="token" hint={t("page.sources.generic.param-hint")} />
      )}
      {tpl && sigMode === "headers" && (
        <TextField
          control={control}
          name="header2"
          id="src-header2"
          label={t("page.sources.generic.header2")}
          placeholder="box-signature-secondary"
          hint={t("page.sources.generic.header2-hint")}
        />
      )}
      {tpl && sigMode === "kv" && (
        <>
          <SelectField
            control={control}
            name="kvSep"
            label={t("page.sources.generic.kv-sep")}
            options={KV_SEP_CHOICES.map((s) => ({ value: s, label: s }))}
          />
          <TextField control={control} name="kvSig" id="src-kv-sig" label={t("page.sources.generic.kv-sig")} placeholder="v1" hint={t("page.sources.generic.kv-sig-hint")} />
          {hasTs && (
            <TextField
              control={control}
              name="kvTimestamp"
              id="src-kv-ts"
              label={t("page.sources.generic.kv-timestamp")}
              placeholder="t"
              hint={t("page.sources.generic.kv-timestamp-hint")}
            />
          )}
        </>
      )}
      {hasTs && !tsInKv && (
        <TextField
          control={control}
          name="timestampHeader"
          id="src-ts-header"
          label={t("page.sources.generic.timestamp-header")}
          placeholder="x-slack-request-timestamp"
          hint={t("page.sources.generic.timestamp-header-hint")}
        />
      )}
      {hasTs && (
        <>
          <SelectField
            control={control}
            name="timestampFormat"
            label={t("page.sources.generic.timestamp-format")}
            options={TIMESTAMP_FORMAT_CHOICES.map((f) => ({ value: f, label: t(TIMESTAMP_FORMAT_KEY[f]) }))}
          />
          <TextField
            control={control}
            name="toleranceSec"
            id="src-tolerance"
            label={t("page.sources.generic.tolerance")}
            placeholder="300"
            hint={t("page.sources.generic.tolerance-hint")}
          />
        </>
      )}
      {tpl && template.includes("{id}") && (
        <TextField
          control={control}
          name="idHeader"
          id="src-id-header"
          label={t("page.sources.generic.id-header")}
          placeholder="twitch-eventsub-message-id"
          hint={t("page.sources.generic.id-header-hint")}
        />
      )}
      {tpl && (
        <>
          <SelectField
            control={control}
            name="algo"
            label={t("page.sources.generic.algo")}
            options={TEMPLATE_ALGO_CHOICES.map((a) => ({ value: a, label: t(ALGO_KEY[a]) }))}
          />
          <SelectField
            control={control}
            name="encoding"
            label={t("page.sources.generic.encoding")}
            options={[
              { value: "hex", label: "hex" },
              { value: "base64", label: "base64" },
            ]}
          />
          <SelectField
            control={control}
            name="keyEncoding"
            label={t("page.sources.generic.key-encoding")}
            options={KEY_ENCODING_CHOICES.map((k) => ({ value: k, label: t(KEY_ENCODING_KEY[k]) }))}
          />
        </>
      )}
      {scheme === "hmac" && (
        <>
          {!typedAlgoPrefix && (
            <SelectField
              control={control}
              name="algo"
              label={t("page.sources.generic.algo")}
              options={HMAC_ALGO_CHOICES.map((a) => ({ value: a, label: t(ALGO_KEY[a]) }))}
              hint={algoHint}
            />
          )}
          <SelectField
            control={control}
            name="encoding"
            label={t("page.sources.generic.encoding")}
            options={[
              { value: "hex", label: "hex" },
              { value: "base64", label: "base64" },
            ]}
          />
          <SelectField
            control={control}
            name="keyEncoding"
            label={t("page.sources.generic.key-encoding")}
            options={KEY_ENCODING_CHOICES.map((k) => ({ value: k, label: t(KEY_ENCODING_KEY[k]) }))}
          />
        </>
      )}
      {needsPrefix(v) && (
        <TextField
          control={control}
          name="prefix"
          id="src-prefix"
          label={t("page.sources.generic.prefix")}
          placeholder={scheme === "hmac" ? "sha256=" : tpl ? "v0=" : "Bearer "}
          hint={t(typedAlgoPrefix ? "page.sources.generic.algo-in-prefix-typed" : "page.sources.generic.prefix-hint")}
        />
      )}
      {/* Review PK1 T-1: standard-webhooks lấy khoá từ tiêu đề (id của bộ đang dùng) — không có lựa chọn "trường body". */}
      {!sw && (
        <SelectField
          control={control}
          name="idKind"
          label={t("page.sources.generic.id-kind")}
          options={ID_KIND_CHOICES.map((k) => ({ value: k, label: t(ID_KIND_KEY[k]) }))}
        />
      )}
      {/* PK10 (E31, ADR-230): băm nội dung không có ô tên — chỉ câu đánh đổi. */}
      {!sw && idKind === "bodyHash" ? (
        <p className="text-sm text-muted-foreground" role="note">
          {t(unv ? "page.sources.generic.id-body-hash-unverified" : "page.sources.generic.id-body-hash-tradeoff")}
        </p>
      ) : (
        <TextField
          control={control}
          name="idValue"
          id="src-id"
          label={t(!sw && idKind === "path" ? "page.sources.generic.id-path" : "page.sources.generic.id-value")}
          placeholder={sw ? "" : idKind === "path" ? "data.id" : "transId"}
          hint={t(
            sw
              ? "page.sources.generic.id-value-hint-sw"
              : idKind === "path"
                ? "page.sources.generic.id-path-hint"
                : unv
                  ? "page.sources.generic.unverified.id-value-hint"
                  : "page.sources.generic.id-value-hint",
          )}
        />
      )}
      <TextField
        control={control}
        name="eventType"
        id="src-event-type"
        label={t("page.sources.generic.event-type")}
        placeholder="acme.invoice.paid"
        hint={t("page.sources.generic.event-type-hint")}
      />
      <HandshakeFields control={control} />
      <AckFields control={control} />
    </>
  );
}

/**
 * PK4 (SPEC-provider-khac §6.1, ADR-205): khối "Bắt tay" — kiểu + tham số của đúng kiểu đó. Hub không bao giờ tự gọi URL
 * lấy từ request (SNS: console chỉ hiện link). Token xác minh gửi một lần, server mã hoá (E13).
 */
function HandshakeFields({ control }: { control: Control<SourceFormValues> }) {
  const t = useT();
  const kind = useWatch({ control, name: "hsKind" });
  const vtp = useWatch({ control, name: "hsVerifyTokenParam" });
  const usesWhen = kind === "body-echo" || kind === "hmac-echo" || kind === "manual-url";
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t("page.sources.generic.hs.title")}</legend>
      <SelectField
        control={control}
        name="hsKind"
        label={t("page.sources.generic.hs.kind")}
        options={HANDSHAKE_CHOICES.map((k) => ({ value: k, label: t(HANDSHAKE_KEY[k]) }))}
        hint={t("page.sources.generic.hs.kind-hint")}
      />
      {kind === "query-echo" && (
        <>
          <TextField control={control} name="hsParam" id="src-hs-param" label={t("page.sources.generic.hs.param")} placeholder="hub.challenge" hint={t("page.sources.generic.hs.param-hint")} />
          <TextField
            control={control}
            name="hsVerifyTokenParam"
            id="src-hs-vtp"
            label={t("page.sources.generic.hs.verify-token-param")}
            placeholder="hub.verify_token"
            hint={t("page.sources.generic.hs.verify-token-param-hint")}
          />
          {vtp.trim() !== "" && (
            <TextField control={control} name="hsVerifyToken" id="src-hs-vt" label={t("page.sources.generic.hs.verify-token")} placeholder="" hint={t("page.sources.generic.hs.verify-token-hint")} />
          )}
        </>
      )}
      {usesWhen && (
        <>
          <SelectField
            control={control}
            name="hsWhenKind"
            label={t("page.sources.generic.hs.when-kind")}
            options={WHEN_KIND_CHOICES.map((k) => ({ value: k, label: t(WHEN_KIND_KEY[k]) }))}
          />
          <TextField control={control} name="hsWhenName" id="src-hs-when-name" label={t("page.sources.generic.hs.when-name")} placeholder="type" hint={t("page.sources.generic.hs.when-name-hint")} />
          <TextField
            control={control}
            name="hsWhenEquals"
            id="src-hs-when-equals"
            label={t("page.sources.generic.hs.when-equals")}
            placeholder="url_verification"
            hint={t("page.sources.generic.hs.when-equals-hint")}
          />
        </>
      )}
      {kind === "body-echo" && (
        <>
          <TextField control={control} name="hsEchoField" id="src-hs-echo" label={t("page.sources.generic.hs.echo-field")} placeholder="challenge" hint={t("page.sources.generic.hs.echo-field-hint")} />
          <SelectField
            control={control}
            name="hsRespond"
            label={t("page.sources.generic.hs.respond")}
            options={ECHO_RESPOND_CHOICES.map((k) => ({ value: k, label: t(RESPOND_KEY[k]) }))}
          />
        </>
      )}
      {(kind === "body-echo" || kind === "manual-url") && (
        <SelectField
          control={control}
          name="hsAfterVerify"
          label={t("page.sources.generic.hs.after-verify")}
          options={AFTER_VERIFY_CHOICES.map((k) => ({ value: k, label: t(AFTER_VERIFY_KEY[k]) }))}
          hint={t("page.sources.generic.hs.after-verify-hint")}
        />
      )}
      {kind === "head-ok" && <p className="text-sm text-muted-foreground">{t("page.sources.generic.hs.head-ok-hint")}</p>}
      {kind === "header-echo" && (
        <TextField control={control} name="hsHeader" id="src-hs-header" label={t("page.sources.generic.hs.header")} placeholder="x-hook-secret" hint={t("page.sources.generic.hs.header-hint")} />
      )}
      {kind === "hmac-echo" && (
        <>
          <TextField control={control} name="hsTokenParent" id="src-hs-parent" label={t("page.sources.generic.hs.token-parent")} placeholder="payload" hint={t("page.sources.generic.hs.token-parent-hint")} />
          <TextField control={control} name="hsTokenField" id="src-hs-token" label={t("page.sources.generic.hs.token-field")} placeholder="plainToken" hint={t("page.sources.generic.hs.token-field-hint")} />
          <TextField control={control} name="hsMacField" id="src-hs-mac" label={t("page.sources.generic.hs.mac-field")} placeholder="encryptedToken" hint={t("page.sources.generic.hs.mac-field-hint")} />
        </>
      )}
      {kind === "manual-url" && (
        <TextField control={control} name="hsUrlField" id="src-hs-url" label={t("page.sources.generic.hs.url-field")} placeholder="SubscribeURL" hint={t("page.sources.generic.hs.url-field-hint")} />
      )}
    </fieldset>
  );
}

/** PK4 §6.3: khối "Phản hồi" — mã khi nhận / khi từ chối. Từ chối không có 2xx; 503 kèm câu nhắc hộp phạt (E21). */
function AckFields({ control }: { control: Control<SourceFormValues> }) {
  const t = useT();
  const reject = useWatch({ control, name: "ackReject" });
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t("page.sources.generic.ack.title")}</legend>
      <SelectField
        control={control}
        name="ackSuccess"
        label={t("page.sources.generic.ack.success")}
        options={ACK_SUCCESS_CHOICES.map((c) => ({ value: c, label: c }))}
        hint={t("page.sources.generic.ack.success-hint")}
      />
      <SelectField
        control={control}
        name="ackReject"
        label={t("page.sources.generic.ack.reject")}
        options={ACK_REJECT_CHOICES.map((c) => ({ value: c, label: c }))}
        hint={t(reject === "503" ? "page.sources.generic.ack.reject-503-hint" : "page.sources.generic.ack.reject-hint")}
      />
    </fieldset>
  );
}
