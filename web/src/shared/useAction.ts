import { useRef, useState } from "react";
import { ApiError, captureScope } from "./api";
import { useApiRequest } from "./ApiTransport";
import { errorMessage } from "./format";

export function useAction() {
  const request = useApiRequest();
  const current = useRef<((recovery: boolean) => Promise<void>) | null>(null);
  const active = useRef(false);
  const rejected = useRef<(() => void) | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState("");
  const [unknown, setUnknown] = useState(false);

  async function submit(recovery: boolean) {
    if (!current.current || active.current) return;
    active.current = true;
    setBusy(true);
    setFault("");
    try {
      await current.current(recovery);
      current.current = null;
      setUnknown(false);
    } catch (error) {
      const unclear = error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.error.code === "RESULT_UNKNOWN");
      if (!unclear) {
        current.current = null;
        rejected.current?.();
      }
      setUnknown(unclear);
      setFault(unclear ? "办理结果待核对。恢复连接后查询原办理结果。" : errorMessage(error));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  function execute<T>(
    path: string, body: unknown, complete: (result: T) => void,
    lookup?: (actionKey: string) => Promise<T | undefined>,
    options?: { actionKey?: string; recover?: boolean; onStart?: () => void; onRejection?: () => void },
  ) {
    if (current.current) return;
    const actionKey = options?.actionKey ?? crypto.randomUUID();
    const activeScope = captureScope();
    rejected.current = options?.onRejection;
    current.current = async recovery => {
      if (!activeScope()) return;
      const existing = recovery && lookup ? await lookup(actionKey) : undefined;
      if (!activeScope()) return;
      const result = existing ?? await request<T>(path, { method: "POST", body, actionKey });
      if (activeScope()) complete(result);
    };
    options?.onStart?.();
    void submit(Boolean(options?.recover));
  }

  return { execute, retry: () => submit(true), busy, unknown, fault };
}
