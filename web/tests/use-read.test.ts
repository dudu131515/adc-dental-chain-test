import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useRead } from "../src/shared/useRead";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function success(name: string) {
  return new Response(JSON.stringify({ data: { name } }));
}

test("a read refresh removes its previous data immediately and after a failed response", async () => {
  let finish: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(success("合成患者甲"))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })));
  const { result, rerender } = renderHook(({ revision }) => useRead<{ name: string }>("/visits/1", revision), {
    initialProps: { revision: 0 },
  });
  await waitFor(() => expect(result.current.data?.name).toBe("合成患者甲"));
  rerender({ revision: 1 });
  expect(result.current.data).toBeUndefined();
  expect(result.current.loading).toBe(true);
  await act(async () => finish(new Response(JSON.stringify({ error: {
    code: "PERMISSION_DENIED", message: "权限已撤销",
  } }), { status: 403 })));
  expect(result.current).toEqual({ data: undefined, loading: false, fault: "权限已撤销" });
});

test("a late response cannot restore data after navigating away and back to the same address", async () => {
  let finish: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(success("合成患者乙"))
    .mockResolvedValueOnce(success("当前获授权患者")));
  const { result, rerender } = renderHook(({ path }) => useRead<{ name: string }>(path), {
    initialProps: { path: "/visits/1" },
  });
  rerender({ path: "/visits/2" });
  await waitFor(() => expect(result.current.data?.name).toBe("合成患者乙"));
  rerender({ path: "/visits/1" });
  await waitFor(() => expect(result.current.data?.name).toBe("当前获授权患者"));
  await act(async () => finish(success("过期患者资料")));
  expect(result.current.data?.name).toBe("当前获授权患者");
});
