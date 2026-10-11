"use client";

import { useState } from "react";

import Link from "next/link";

import { KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HubApiError } from "@/lib/hub/client";
import { useFlowProjectStore, useProjects } from "@/lib/hub/flow-project";
import { projectCreateError, slugFromName } from "@/lib/hub/keys-logic";
import { useCreateProject } from "@/lib/hub/project-queries";

/** SK1 (SPEC-shop-ket-noi-project §3): danh sách project của mình + tạo project (tên + slug). */
export default function ProjectsPage() {
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
          toast.success(`Đã tạo project "${p.name}" — đang chọn project này`);
          close(false);
        },
        onError: (err) =>
          setFormError(
            err instanceof HubApiError ? projectCreateError(err.status, err.body, err.message) : String(err),
          ),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Project"
        description="Tài khoản mới đã có sẵn một project (tạo lúc đăng ký) và console đang chọn nó — vào thẳng API key là dùng được. Tạo thêm project khi cần tách môi trường, sản phẩm hoặc thành viên (ADR-038)."
        actions={
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus />
            Tạo project
          </Button>
        }
      />
      {error && <p className="text-destructive text-sm">Không tải được danh sách project: {error.message}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tên</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Môi trường</TableHead>
            <TableHead>Vai trò</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={5}>Đang tải…</TableCell>
            </TableRow>
          )}
          {(data ?? []).map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">
                {p.name} {p.id === projectId && <Badge variant="secondary">đang chọn</Badge>}
              </TableCell>
              <TableCell className="font-mono text-xs">{p.slug}</TableCell>
              <TableCell>{p.environment}</TableCell>
              <TableCell>{p.role ?? "—"}</TableCell>
              <TableCell className="text-right">
                {p.id !== projectId ? (
                  <Button size="sm" variant="outline" onClick={() => setProjectId(p.id)}>
                    Chọn
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href="/dashboard/api-keys">
                      <KeyRound />
                      API key
                    </Link>
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Tạo project</DialogTitle>
            <DialogDescription>
              Bạn là owner của project mới. Slug nằm trong connection string của service.
            </DialogDescription>
          </DialogHeader>
          <form id="project-form" noValidate onSubmit={submit}>
            <FieldGroup className="gap-4">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="pj-name">Tên</FieldLabel>
                <Input
                  id="pj-name"
                  value={name}
                  placeholder="VD: Cửa hàng của tôi"
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched) setSlug(slugFromName(e.target.value));
                  }}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="pj-slug">Slug</FieldLabel>
                <Input
                  id="pj-slug"
                  className="font-mono"
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                />
                <FieldDescription>Chữ thường, số, gạch ngang; 3–63 ký tự. Không đổi được sau khi tạo.</FieldDescription>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel>Môi trường</FieldLabel>
                <div className="flex gap-4 text-sm">
                  {(["test", "live"] as const).map((v) => (
                    <label key={v} className="flex items-center gap-1">
                      <input type="radio" name="pj-env" checked={env === v} onChange={() => setEnv(v)} />
                      {v === "test" ? "test (hk_test_)" : "live (hk_live_, cần email đã xác minh)"}
                    </label>
                  ))}
                </div>
              </Field>
              {formError && <p className="text-destructive text-sm">{formError}</p>}
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={create.isPending}>
              Huỷ
            </Button>
            <Button type="submit" form="project-form" disabled={create.isPending || !name.trim() || !slug.trim()}>
              {create.isPending ? "Đang tạo…" : "Tạo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
