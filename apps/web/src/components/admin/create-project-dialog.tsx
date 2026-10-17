"use client";

import { useState } from "react";

import { FormDialog } from "@/components/admin/form-dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { HubApiError } from "@/lib/hub/client";
import type { ProjectSummary } from "@/lib/hub/flow-project";
import { projectCreateError, slugFromName } from "@/lib/hub/keys-logic";
import { useCreateProject } from "@/lib/hub/project-queries";
import { useT } from "@/lib/i18n/use-t";

export interface CreateProjectInput {
  name: string;
  slug: string;
  environment: "test" | "live";
}

/**
 * SK1: hộp "Tạo dự án" (tên + slug tự sinh + môi trường) — dùng chung cho trang Dự án trong dashboard và trang "Dự án của
 * tôi" ở tầng tài khoản. Lỗi slug/trần/xác minh dịch qua `projectCreateError` (keys-logic). `submitOverride`: chỉ cho
 * chế độ demo `?demo=1` — thay `POST /api/v1/projects` bằng hàm cục bộ (ném HubApiError để đi đúng đường dịch lỗi).
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
  submitOverride,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (p: ProjectSummary) => void;
  submitOverride?: (input: CreateProjectInput) => Promise<ProjectSummary>;
}) {
  const t = useT();
  const create = useCreateProject();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [env, setEnv] = useState<"test" | "live">("test");
  const [formError, setFormError] = useState<string | null>(null);
  const [overridePending, setOverridePending] = useState(false);
  const pending = create.isPending || overridePending;

  const close = (o: boolean) => {
    if (pending) return;
    if (!o) {
      setName("");
      setSlug("");
      setSlugTouched(false);
      setFormError(null);
    }
    onOpenChange(o);
  };
  const fail = (err: unknown) =>
    setFormError(err instanceof HubApiError ? projectCreateError(err.status, err.body, err.message, t) : String(err));
  const done = (p: ProjectSummary) => {
    onCreated(p);
    setName("");
    setSlug("");
    setSlugTouched(false);
    setFormError(null);
    onOpenChange(false);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const input = { name: name.trim(), slug: slug.trim(), environment: env };
    if (submitOverride) {
      setOverridePending(true);
      submitOverride(input)
        .then(done, fail)
        .finally(() => setOverridePending(false));
      return;
    }
    create.mutate(input, { onSuccess: done, onError: fail });
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t("page.projects.create")}
      description={t("page.projects.dialog.description")}
      formId="project-form"
      submitting={pending}
      submittingLabel={t("common.creating")}
      submitDisabled={!name.trim() || !slug.trim()}
    >
      <form id="project-form" noValidate onSubmit={submit}>
        <FieldGroup className="gap-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="pj-name">{t("page.projects.field.name")}</FieldLabel>
            <Input
              id="pj-name"
              value={name}
              placeholder={t("page.projects.field.name-placeholder")}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugFromName(e.target.value));
              }}
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="pj-slug">{t("page.projects.field.slug")}</FieldLabel>
            <Input
              id="pj-slug"
              className="font-mono"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
            <FieldDescription>{t("page.projects.field.slug-hint")}</FieldDescription>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel>{t("page.projects.field.environment")}</FieldLabel>
            <RadioGroup value={env} onValueChange={(v) => setEnv(v as "test" | "live")} className="flex gap-4 text-sm">
              {(["test", "live"] as const).map((v) => (
                <label key={v} className="flex cursor-pointer items-center gap-1.5">
                  <RadioGroupItem value={v} />
                  {t(v === "test" ? "page.projects.field.env-test" : "page.projects.field.env-live")}
                </label>
              ))}
            </RadioGroup>
          </Field>
          {formError && <FieldError>{formError}</FieldError>}
        </FieldGroup>
      </form>
    </FormDialog>
  );
}
