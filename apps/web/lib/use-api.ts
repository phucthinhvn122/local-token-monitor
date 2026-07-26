"use client";

import * as React from "react";
import { api } from "@/lib/api";

interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Minimal fetch-on-mount hook.
 *
 * The dashboard's data needs are simple — load on mount, reload after a
 * mutation — so a full query library would be weight without benefit. The
 * generation counter guards against a slow response overwriting a newer one.
 */
export function useApi<T>(path: string | null, deps: React.DependencyList = []): QueryState<T> {
  const [data, setData] = React.useState<T | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(path !== null);
  const [nonce, setNonce] = React.useState(0);
  const generation = React.useRef(0);

  React.useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const current = ++generation.current;
    setLoading(true);
    setError(null);

    api
      .get<T>(path)
      .then((result) => {
        if (generation.current !== current) return;
        setData(result);
      })
      .catch((caught: unknown) => {
        if (generation.current !== current) return;
        setError(caught instanceof Error ? caught.message : "Request failed");
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = React.useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}
