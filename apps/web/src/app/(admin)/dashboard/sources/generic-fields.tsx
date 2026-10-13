"use client";

import { type Control, Controller, useWatch } from "react-hook-form";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  GENERIC_SCHEMES,
  type GenericFormValues,
  HMAC_ALGO_CHOICES,
  KEY_ENCODING_CHOICES,
  needsHeader,
  needsPrefix,
  TOKEN_LOCATION_CHOICES,
} from "@/lib/hub/listen-logic";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

const SCHEME_KEY: Record<GenericFormValues["scheme"], MessageKey> = {
  hmac: "page.sources.generic.scheme.hmac",
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
  control: Control<GenericFormValues>;
  name: "scheme" | "algo" | "encoding" | "keyEncoding" | "location" | "idKind";
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
  control: Control<GenericFormValues>;
  name: "header" | "prefix" | "param" | "idValue" | "eventType";
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
 * - `standard-webhooks`: không ô nào (đọc bộ webhook-* / svix-*), khoá chống trùng luôn là tiêu đề.
 */
export function GenericFields({ control, scheme }: { control: Control<GenericFormValues>; scheme: GenericFormValues["scheme"] }) {
  const t = useT();
  const algo = useWatch({ control, name: "algo" });
  const location = useWatch({ control, name: "location" });
  const sw = scheme === "standard-webhooks";
  const v = { scheme, algo, location };
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
      {scheme === "hmac" && (
        <>
          <SelectField
            control={control}
            name="algo"
            label={t("page.sources.generic.algo")}
            options={HMAC_ALGO_CHOICES.map((a) => ({ value: a, label: t(ALGO_KEY[a]) }))}
            hint={algoHint}
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
      {needsPrefix(v) && (
        <TextField
          control={control}
          name="prefix"
          id="src-prefix"
          label={t("page.sources.generic.prefix")}
          placeholder={scheme === "hmac" ? "sha256=" : "Bearer "}
          hint={t("page.sources.generic.prefix-hint")}
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
