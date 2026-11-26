import { createContext, useContext } from "react";
import { request } from "./api";

export const ApiTransport = createContext<typeof request>(request);

export function useApiRequest() {
  return useContext(ApiTransport);
}
