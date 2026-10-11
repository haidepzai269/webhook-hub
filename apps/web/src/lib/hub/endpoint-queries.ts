"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { hubFetch } from "./client";
import { keysAfterAudited } from "./ui-logic";

/** KN1 (SPEC-ket-noi §3, ADR-138): console tạo endpoint webhook — hub sinh whsec_ (hiện MỘT lần) + challenge. */
export interface EndpointView {
  id: string;
  name: string;
  url: string | null;
  verification: "PENDING" | "VERIFIED" | "FAILED";
  verificationError: string | null;
  verificationFix: string | null;
  verifiedAt: string | null;
  createdAt: string;
  managedBy?: "service" | "console";
}

export interface CreateEndpointResult {
  endpoint: EndpointView;
  subscription: { id: string; eventTypes: string[]; sourceIds: string[] };
  verification: "VERIFIED" | "FAILED";
  verificationError: string | null;
  verificationFix: string | null;
  /** Chỉ có khi hub sinh secret — lần duy nhất secret rời khỏi hub. */
  signingSecret?: string;
}

export interface EndpointDetail {
  endpoint: EndpointView;
  subscriptions: { id: string; name: string; eventTypes: string[]; sourceIds: string[]; isActive: boolean }[];
  deliveries: {
    id: string;
    status: string;
    attemptCount: number;
    eventType: string | null;
    lastError: string | null;
    createdAt: string;
  }[];
}

export interface VerifyResult {
  verification: "VERIFIED" | "FAILED";
  verificationError: string | null;
  verificationFix: string | null;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const key of keysAfterAudited(["destinations"], ["subscriptions"], ["endpoint"]))
      void qc.invalidateQueries({ queryKey: key });
  };
}

export function useEventTypeCatalog() {
  return useQuery({
    queryKey: ["catalog", "event-types"],
    queryFn: () => hubFetch<{ wildcards: string[]; types: string[] }>("/api/v1/catalog/event-types"),
    staleTime: Infinity,
  });
}

export function useCreateEndpoint() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { name: string; url: string; eventTypes: string[]; sourceIds?: string[] }) =>
      hubFetch<CreateEndpointResult>("/api/v1/endpoints", { method: "POST", body: JSON.stringify(body) }),
    onSettled: invalidate,
  });
}

export function useEndpointDetail(id: string | null) {
  return useQuery({
    queryKey: ["endpoint", id],
    queryFn: () => hubFetch<EndpointDetail>(`/api/v1/endpoints/${encodeURIComponent(id ?? "")}`),
    enabled: Boolean(id),
  });
}

export function useVerifyEndpoint() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      hubFetch<VerifyResult>(`/api/v1/endpoints/${encodeURIComponent(id)}/verify`, { method: "POST" }),
    onSettled: invalidate,
  });
}

export function useRotateEndpointSecret() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      hubFetch<{ endpoint: EndpointView; signingSecret: string }>(
        `/api/v1/endpoints/${encodeURIComponent(id)}/rotate-secret`,
        { method: "POST" },
      ),
    onSettled: invalidate,
  });
}
