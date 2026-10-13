"use client";

import { type Control, Controller, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ALGO_IN_PREFIX,
  GENERIC_SCHEMES,
  type GenericFormValues,
  HMAC_ALGO_CHOICES,
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
} from "@/lib/hub/listen-logic";
import type { Provider } from "@/lib/hub/types";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

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
  name: "scheme" | "algo" | "encoding" | "keyEncoding" | "location" | "idKind" | "sigMode" | "kvSep" | "timestampFormat";
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
}: {
  control: Control<SourceFormValues>;
  name: "header" | "prefix" | "param" | "idValue" | "eventType" | "template" | "header2" | "kvSig" | "kvTimestamp" | "timestampHeader" | "idHeader" | "toleranceSec";
  id: string;
  label: string;
  placeholder: string;
  hint: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field className="gap-1.5" data-invalid={fieldState.invalid}>
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
      {tpl && (
        <Field className="gap-1.5">
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
          options={[
            { value: "field", label: t("page.sources.generic.id-kind.field") },
            { value: "header", label: t("page.sources.generic.id-kind.header") },
          ]}
        />
      )}
      <TextField
        control={control}
        name="idValue"
        id="src-id"
        label={t("page.sources.generic.id-value")}
        placeholder={sw ? "" : "transId"}
        hint={t(sw ? "page.sources.generic.id-value-hint-sw" : "page.sources.generic.id-value-hint")}
      />
      <TextField
        control={control}
        name="eventType"
        id="src-event-type"
        label={t("page.sources.generic.event-type")}
        placeholder="acme.invoice.paid"
        hint={t("page.sources.generic.event-type-hint")}
      />
    </>
  );
}
