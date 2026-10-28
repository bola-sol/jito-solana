import { useEffect, useState, type RefObject } from "react";

export function useHeight(ref: RefObject<Element | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Measured once up front: some embedded webviews never deliver a
    // ResizeObserver callback.
    setHeight(element.getBoundingClientRect().height);
    if (typeof ResizeObserver !== "function") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return height;
}
