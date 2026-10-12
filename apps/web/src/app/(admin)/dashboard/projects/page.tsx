"use client";

import { useState } from "react";

import Link from "next/link";

import { KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";

import { AdminDialogContent } from "@/components/admin/overlay-content";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HubApiError } from "@/lib/hub/client";
import { useFlowProjectStore, useProjects } from "@/lib/hub/flow-project";
import { projectCreateError, slugFromName } from "@/lib/hub/keys-logic";
import { useCreateProject } from "@/lib/hub/project-queries";
import type { MessageKey } from "@/lib/i18n/dictionary";
import { useT } from "@/lib/i18n/use-t";

const ROLE_KEY: Record<string, MessageKey> = { owner: "page.projects.role.owner", member: "page.projects.role.member" };
const ENV_KEY: Record<string, MessageKey> = { test: "page.projects.env.test", live: "page.projects.env.live" };

/** SK1 (SPEC-shop-ket-noi-project §3): danh sách project của mình + tạo project (tên + slug). */
export default function ProjectsPage() {
  const t = useT();
  const roleLabel = (role: string | undefined) => (role && ROLE_KEY[role] ? t(ROLE_KEY[role]) : (role ?? "—"));
  const { data, isLoading, error } = useProjects();
  const projectId = useFlowProjectStore((s) => s.projectId);
  const setProjectId = useFlowProjectStore((s) => s.setProjectId);
  const create = useCreateProject();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [env, setEnv] = useState<"test" | "live">("test");
  const [formError, setFormError] = useState<string | null>(null);

  const close = (o: boolean) => {
    if (create.isPending) return;
    if (!o) {
      setName("");
      setSlug("");
      setSlugTouched(false);
      setFormError(null);
    }
    setOpen(o);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    create.mutate(
      { name: name.trim(), slug: slug.trim(), environment: env },
      {
        onSuccess: (p) => {
          setProjectId(p.id); // làm việc ngay trong project mới
          toast.success(t("page.projects.created", { name: p.name }));
          close(false);
        },
        onError: (err) =>
          setFormError(
            err instanceof HubApiError ? projectCreateError(err.status, err.body, err.message, t) : String(err),
          ),
      },
    );
  };

  return (
    <>
      <PageHeader
        title={t("page.projects.title")}
        description={t("page.projects.description")}
        actions={
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus />
            {t("page.projects.create")}
          </Button>
        }
      />
      {error && <p className="text-destructive text-sm">{t("page.projects.load-error", { message: error.message })}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("page.projects.col.name")}</TableHead>
            <TableHead>{t("page.projects.col.slug")}</TableHead>
            <TableHead>{t("page.projects.col.environment")}</TableHead>
            <TableHead>{t("page.projects.col.role")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={5}>{t("common.loading")}</TableCell>
            </TableRow>
          )}
          {(data ?? []).map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">
                {p.name} {p.id === projectId && <Badge variant="secondary">{t("page.projects.selected")}</Badge>}
              </TableCell>
              <TableCell className="font-mono text-xs">{p.slug}</TableCell>
              <TableCell>{ENV_KEY[p.environment] ? t(ENV_KEY[p.environment]) : p.environment}</TableCell>
              <TableCell>
                {p.member === false ? t("page.projects.role.operator") : roleLabel(p.role)}
              </TableCell>
              <TableCell className="text-right">
                {p.id !== projectId ? (
                  <Button size="sm" variant="outline" onClick={() => setProjectId(p.id)}>
                    {t("page.projects.select")}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href="/dashboard/api-keys">
                      <KeyRound />
                      {t("page.projects.api-keys")}
                    </Link>
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={open} onOpenChange={close}>
        <AdminDialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("page.projects.create")}</DialogTitle>
            <DialogDescription>
              {t("page.projects.dialog.description")}
            </DialogDescription>
          </DialogHeader>
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
                <div className="flex gap-4 text-sm">
                  {(["test", "live"] as const).map((v) => (
                    <label key={v} className="flex items-center gap-1">
                      <input type="radio" name="pj-env" checked={env === v} onChange={() => setEnv(v)} />
                      {t(v === "test" ? "page.projects.field.env-test" : "page.projects.field.env-live")}
                    </label>
                  ))}
                </div>
              </Field>
              {formError && <p className="text-destructive text-sm">{formError}</p>}
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={create.isPending}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="project-form" disabled={create.isPending || !name.trim() || !slug.trim()}>
              {create.isPending ? t("common.creating") : t("common.create")}
            </Button>
          </DialogFooter>
        </AdminDialogContent>
      </Dialog>
    </>
  );
}
