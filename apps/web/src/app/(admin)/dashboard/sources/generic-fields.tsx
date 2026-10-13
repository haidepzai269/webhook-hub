"use client";

import { type Control, Controller } from "react-hook-form";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GENERIC_SCHEMES, type GenericFormValues } from "@/lib/hub/listen-logic";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

const SCHEME_KEY: Record<GenericFormValues["scheme"], MessageKey> = {
  "hmac-sha256": "page.sources.generic.scheme.hmac-sha256",
  "static-token": "page.sources.generic.scheme.static-token",
  "standard-webhooks": "page.sources.generic.scheme.standard-webhooks",
};

/**
 * PK1 (SPEC-provider-khac §3.1, ADR-202): các ô tay của "Provider khác" (generic) — scheme, header, encoding, khoá chống
 * trùng, eventType. PK7 thay bằng form nhận diện. Header ẩn với standard-webhooks (đọc webhook-* / svix-*), encoding chỉ
 * cho hmac-sha256 — đúng luật của `validateGenericConfig`.
 */
export function GenericFields({ control, scheme }: { control: Control<GenericFormValues>; scheme: GenericFormValues["scheme"] }) {
  const t = useT();
  const sw = scheme === "standard-webhooks";
  return (
    <>
      <Controller
        control={control}
        name="scheme"
        render={({ field }) => (
          <Field className="gap-1.5">
            <FieldLabel>{t("page.sources.generic.scheme")}</FieldLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GENERIC_SCHEMES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(SCHEME_KEY[s])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      />
      {!sw && (
        <Controller
          control={control}
          name="header"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="src-header">{t("page.sources.generic.header")}</FieldLabel>
              <Input {...field} id="src-header" placeholder="x-acme-signature" aria-invalid={fieldState.invalid} />
              <FieldDescription>{t("page.sources.generic.header-hint")}</FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      )}
      {scheme === "hmac-sha256" && (
        <Controller
          control={control}
          name="encoding"
          render={({ field }) => (
            <Field className="gap-1.5">
              <FieldLabel>{t("page.sources.generic.encoding")}</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hex">hex</SelectItem>
                  <SelectItem value="base64">base64</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        />
      )}
      <Controller
        control={control}
        name="idKind"
        render={({ field }) => (
          <Field className="gap-1.5">
            <FieldLabel>{t("page.sources.generic.id-kind")}</FieldLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="field">{t("page.sources.generic.id-kind.field")}</SelectItem>
                <SelectItem value="header">{t("page.sources.generic.id-kind.header")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      />
      <Controller
        control={control}
        name="idValue"
        render={({ field, fieldState }) => (
          <Field className="gap-1.5" data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="src-id">{t("page.sources.generic.id-value")}</FieldLabel>
            <Input {...field} id="src-id" placeholder={sw ? "svix-id" : "transId"} aria-invalid={fieldState.invalid} />
            <FieldDescription>{t("page.sources.generic.id-value-hint")}</FieldDescription>
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        )}
      />
      <Controller
        control={control}
        name="eventType"
        render={({ field, fieldState }) => (
          <Field className="gap-1.5" data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="src-event-type">{t("page.sources.generic.event-type")}</FieldLabel>
            <Input {...field} id="src-event-type" placeholder="acme.invoice.paid" aria-invalid={fieldState.invalid} />
            <FieldDescription>{t("page.sources.generic.event-type-hint")}</FieldDescription>
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        )}
      />
    </>
  );
}
