import { useStoreValue } from "./useStore";

/** Whether the cluster runs alpenglow, for the figures that only exist under one consensus. */
export function useAlpenglow(): boolean {
  return useStoreValue((store) => store.get("summary", "consensus") === "alpenglow");
}
