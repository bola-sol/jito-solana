import { useEffect, useState, type RefObject } from "react";

function useExtent(ref: RefObject<Element | null>, side: "width" | "height"): number | null {
  const [extent, setExtent] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Measured once up front: some embedded webviews never deliver a
    // ResizeObserver callback.
    setExtent(element.getBoundingClientRect()[side]);
    if (typeof ResizeObserver !== "function") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setExtent(entry.contentRect[side]);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, side]);

  return extent;
}

export const useWidth = (ref: RefObject<Element | null>) => useExtent(ref, "width");
export const useHeight = (ref: RefObject<Element | null>) => useExtent(ref, "height");
