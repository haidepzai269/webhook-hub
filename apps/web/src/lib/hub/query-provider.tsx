"use client";

import { type ReactNode, useState } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { HubApiError } from "./client";

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            // 401 đã redirect về login, 4xx khác retry cũng vô ích.
            retry: (failureCount, error) =>
              !(error instanceof HubApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
