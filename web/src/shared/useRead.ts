import { useEffect, useMemo, useState } from "react";
import { useApiRequest } from "./ApiTransport";
import { errorMessage } from "./format";

export function useRead<T>(path?: string, change = 0, scope = "") {
  const request = useApiRequest();
  const query = useMemo(() => ({ path, change, scope, request }), [path, change, scope, request]);
  const [response, setResponse] = useState<{ query: typeof query; data?: T; fault: string }>();

  useEffect(() => {
    if (!query.path) return;
    const controller = new AbortController();
    query.request<T>(query.path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setResponse({ query, data, fault: "" });
    }).catch(error => {
      if (!controller.signal.aborted) setResponse({ query, fault: errorMessage(error) });
    });
    return () => controller.abort();
  }, [query]);

  const current = path && response?.query === query ? response : undefined;
  return { data: current?.data, loading: Boolean(path && !current), fault: current?.fault ?? "" };
}
