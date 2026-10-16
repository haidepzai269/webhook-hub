import { ProjectsHome } from "./_components/projects-home";

/** `/projects` — "Tất cả dự án" (ADR-234/235). `?demo=1`: dữ liệu giả, không cần đăng nhập/hub-api. */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { demo } = await searchParams;
  return <ProjectsHome demo={demo === "1"} />;
}
