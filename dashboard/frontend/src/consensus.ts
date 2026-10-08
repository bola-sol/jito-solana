import { useStoreValue } from "./useStore";

export function useAlpenglow(): boolean {
  return useStoreValue((store) => store.get("summary", "consensus") === "alpenglow");
}
