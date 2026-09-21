import { useStore } from "./useStore";

/** Whether the cluster runs alpenglow, for the figures that only exist under one consensus. */
export function useAlpenglow(): boolean {
  return useStore().get("summary", "consensus") === "alpenglow";
}
