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

function toStep<S extends StageLike>(stage: S, prev: S | undefined): JourneyStep<S> {
  const deltaMs = stage.offsetMs === null ? null : Math.max(0, stage.offsetMs - (prev?.offsetMs ?? 0));
  const intentionalStop = isIntentionalStop(stage);
  return { stage, deltaMs, intentionalStop };
}

export function buildJourneyList<S extends StageLike, B extends BranchLike<S>>(
  stages: S[],
  branches: B[],
): { steps: JourneyStep<S>[]; branches: JourneyBranchList<S, B>[] } {
  const steps = stages.map((s, i) => toStep(s, stages[i - 1]));
  const routed = stages[stages.length - 1];
  return {
    steps,
    branches: branches.map((b) => ({
      branch: b,
      attempts: b.stages.filter((s) => s.id.includes(":attempt:")).length,
      // Chặng đầu của nhánh tính mốc từ Định tuyến (giống cạnh routed → delivery trên canvas).
      steps: b.stages.map((s, i) => toStep(s, i === 0 ? routed : b.stages[i - 1])),
    })),
  };
}
