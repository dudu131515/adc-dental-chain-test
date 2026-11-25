import { useEffect, useState } from "react";
import { request } from "./api";
import { errorMessage } from "./format";

export function useRead<T>(path?: string, change = 0) {
  const [response, setResponse] = useState<{ path: string; value: T }>();
  const [loading, setLoading] = useState(Boolean(path));
  const [fault, setFault] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setFault("");
    setLoading(Boolean(path));
    if (!path) return;
    request<T>(path, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setResponse({ path, value: result });
    }).catch(error => {
      if (!controller.signal.aborted) setFault(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, change]);
  return { data: response?.path === path ? response?.value : undefined, loading, fault };
}
