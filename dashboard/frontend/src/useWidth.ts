import { useEffect, useState, type RefObject } from "react";

export function useWidth(ref: RefObject<Element | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Measured once up front: some embedded webviews never deliver a
    // ResizeObserver callback.
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
