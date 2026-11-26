import { createContext, useContext } from "react";
import { localDay } from "./format";

type Route = { url: string; path: string; search: string };

function parseRoute(url: string): Route {
  const index = url.indexOf("?");
  return { url, path: index < 0 ? url : url.slice(0, index), search: index < 0 ? "" : url.slice(index) };
}

export function createWorkspaceRouter(readPath?: () => string) {
  const href = (path: string) => readPath ? "#" + path : path;
  return {
    read: () => parseRoute(readPath ? readPath() : window.location.pathname + window.location.search),
    href,
    write(path: string, replace = true) {
      if (replace) window.history.replaceState(window.history.state, "", href(path));
      else window.history.pushState({}, "", href(path));
    },
    subscribe(sync: () => void) {
      window.addEventListener("popstate", sync);
      if (readPath) window.addEventListener("hashchange", sync);
      return () => {
        window.removeEventListener("popstate", sync);
        if (readPath) window.removeEventListener("hashchange", sync);
      };
    },
  };
}

const router = createWorkspaceRouter();
export const WorkspaceRuntime = createContext<{ router: typeof router; sampleTime?: number }>({ router });

export function useWorkspaceRuntime() {
  const { router, sampleTime } = useContext(WorkspaceRuntime);
  return { router, sampleTime, workday: localDay(sampleTime === undefined ? undefined : new Date(sampleTime)) };
}
