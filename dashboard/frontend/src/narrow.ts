import { useMedia } from "./useMedia";

/** The same 700px the stylesheet changes shape at. */
const NARROW_QUERY = "(max-width: 700px)";

export const useNarrow = (): boolean => useMedia(NARROW_QUERY);
