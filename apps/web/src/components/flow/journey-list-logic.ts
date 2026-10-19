import { type DotRole, pipelineRoles } from "./event-notes";

// Kiểu cấu trúc tối thiểu (khớp StageView / FlowBranch của @hub/flow) — file thuần, jest không có alias @hub/flow.
interface StageLike {
  id: string;
  key: string;
  status: string;
  offsetMs: number | null;
  reason?: { code: string };
}
interface BranchLike<S extends StageLike> {
  stages: S[];
}

/**
 * Danh sách dọc các chặng cho màn hẹp (ADR-261) — CÙNG dữ liệu `stages` + `branches` với canvas, chỉ đổi cách vẽ.
 * Hàm thuần: ánh xạ chặng → hàng (tone, mốc `+ms` so với chặng trước, có dừng chủ đích hay không).
 */
export interface JourneyStep<S extends StageLike = StageLike> {
  stage: S;
  /** ms kể từ chặng trước (như nhãn `+Xms` trên cạnh canvas); null khi server chưa có mốc. */
  deltaMs: number | null;
  /** Vai của chặng trong dải 6 ô (cùng `pipelineRoles` với MiniPipeline): `faded` = sau điểm dừng, không áp dụng. */
  role: DotRole;
  /** Định tuyến không khớp subscription nào = dừng CÓ CHỦ ĐÍCH (ADR-259) — vẽ trung tính, không "bỏ qua". */
  intentionalStop: boolean;
}

export interface JourneyBranchList<S extends StageLike, B extends BranchLike<S>> {
  branch: B;
  attempts: number;
  steps: JourneyStep<S>[];
}

export function isIntentionalStop(stage: StageLike): boolean {
  return stage.key === "routed" && stage.status === "skipped" && stage.reason?.code !== "provider_probe";
}

function toStep<S extends StageLike>(stage: S, prev: S | undefined, roles: RoleMap): JourneyStep<S> {
  const deltaMs = stage.offsetMs === null ? null : Math.max(0, stage.offsetMs - (prev?.offsetMs ?? 0));
  const intentionalStop = isIntentionalStop(stage);
  // Chặng không có trong dải 6 ô (lần thử, kết thúc) luôn là `real`; chỉ chặng bị MiniPipeline mờ mới `faded`.
  return { stage, deltaMs, intentionalStop, role: intentionalStop ? "stop" : (roles[stage.key] ?? "real") };
}

export type RoleMap = Partial<Record<string, DotRole>>;

/** Vai theo khoá chặng, lấy từ ĐÚNG `pipelineRoles` của dải mini → mobile và desktop cùng kết luận. */
export function stageRoleMap(ctx: Parameters<typeof pipelineRoles>[0]): RoleMap {
  const { roles } = pipelineRoles(ctx);
  return Object.fromEntries(ctx.summary.map((d, k) => [d.stage, roles[k]]));
}

export function buildJourneyList<S extends StageLike, B extends BranchLike<S>>(
  stages: S[],
  branches: B[],
  roles: RoleMap = {},
): { steps: JourneyStep<S>[]; branches: JourneyBranchList<S, B>[] } {
  const steps = stages.map((s, i) => toStep(s, stages[i - 1], roles));
  const routed = stages[stages.length - 1];
  return {
    steps,
    branches: branches.map((b) => ({
      branch: b,
      attempts: b.stages.filter((s) => s.id.includes(":attempt:")).length,
      // Chặng đầu của nhánh tính mốc từ Định tuyến (giống cạnh routed → delivery trên canvas).
      steps: b.stages.map((s, i) => toStep(s, i === 0 ? routed : b.stages[i - 1], {})),
    })),
  };
}

/** Cách vẽ một thẻ chặng theo vai (cùng quy ước với canvas / MiniPipeline): thuần để test được. */
export interface StepCardView {
  idleTone: boolean;
  glyph: "status" | "stop" | "dot";
  /** Thẻ thu nhỏ + mờ (chặng sau điểm dừng — không áp dụng). */
  faded: boolean;
  /** Dòng gợi ý "tạo đăng ký nhận" — chỉ khi dừng vì không subscription nào khớp. */
  hint: boolean;
}

export function stepCardView(step: JourneyStep<StageLike>): StepCardView {
  if (step.intentionalStop) return { idleTone: true, glyph: "stop", faded: false, hint: step.stage.reason?.code === "no_subscription" };
  if (step.role === "faded") return { idleTone: true, glyph: "dot", faded: true, hint: false };
  return { idleTone: false, glyph: "status", faded: false, hint: false };
}
