import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { offsetsOf, visibleRange } from "../virtual";
import { LIVE_EDGE_PX } from "./ScrollTop";

/** A screen past each edge is drawn, so a fast scroll does not show blank space. */
const OVERSCAN_SCREENS = 1;

/** More is asked for while two screens are still left below. */
const NEAR_END_SCREENS = 2;

interface Viewport {
  top: number;
  height: number;
}

/**
 * Draws only the items near the scroller's view, each measured once drawn; the rest are estimated
 * from items of the same size class. The first item in view holds its place when items above it
 * arrive or change height, unless the list is at its top.
 */
export function VirtualList({
  keys,
  sizeClass,
  fallback,
  render,
  scroller,
  onNearEnd,
}: {
  keys: readonly number[];
  sizeClass: (key: number) => number;
  /** The height guessed before anything has been measured. */
  fallback: number;
  render: (key: number) => ReactNode;
  scroller: RefObject<HTMLElement | null>;
  onNearEnd?: () => void;
}): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  // Each drawn item's height and the size class it was measured in.
  const measured = useRef(new Map<number, { height: number; size: number }>());
  const classes = useRef(new Map<number, { sum: number; count: number }>());
  const sizeOf = useRef(sizeClass);
  useLayoutEffect(() => {
    sizeOf.current = sizeClass;
  });
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 0 });

  // Measurements arrive in bursts; one recount per frame covers them.
  const pending = useRef<number | null>(null);
  const bump = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = null;
      setRevision((was) => was + 1);
    });
  }, []);
  useEffect(() => () => {
    if (pending.current !== null) cancelAnimationFrame(pending.current);
  }, []);

  const [observer] = useState(
    () =>
      new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const key = Number((entry.target as HTMLElement).dataset.key);
          const height = entry.borderBoxSize[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight;
          if (!Number.isFinite(key) || height <= 0) continue;
          const was = measured.current.get(key);
          if (was !== undefined && Math.abs(was.height - height) < 0.5) continue;
          if (was !== undefined) {
            const old = classes.current.get(was.size);
            if (old) classes.current.set(was.size, { sum: old.sum - was.height, count: old.count - 1 });
          }
          const size = sizeOf.current(key);
          const into = classes.current.get(size) ?? { sum: 0, count: 0 };
          classes.current.set(size, { sum: into.sum + height, count: into.count + 1 });
          measured.current.set(key, { height, size });
          changed = true;
        }
        if (changed) bump();
      }),
  );
  useEffect(() => () => observer.disconnect(), [observer]);

  // Follows the scroller, and forgets every height when its width changes, since cards reflow.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame: number | null = null;
    let width = element.clientWidth;
    const follow = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setViewport({ top: element.scrollTop, height: element.clientHeight });
      });
    };
    const resized = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        measured.current.clear();
        classes.current.clear();
        bump();
      }
      follow();
    });
    element.addEventListener("scroll", follow, { passive: true });
    resized.observe(element);
    follow();
    return () => {
      element.removeEventListener("scroll", follow);
      resized.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [scroller, bump]);

  const estimate = useCallback(
    (key: number) => {
      const size = classes.current.get(sizeClass(key));
      return size && size.count > 0 ? size.sum / size.count : fallback;
    },
    [sizeClass, fallback],
  );

  const { offsets, indexOf } = useMemo(() => {
    const heights = keys.map((key) => measured.current.get(key)?.height ?? estimate(key));
    return { offsets: offsetsOf(heights), indexOf: new Map(keys.map((key, index) => [key, index])) };
    // `revision` stands for the measurements, which live in a ref.
  }, [keys, estimate, revision]);

  // The list's own top within the scroller, below whatever sits above it.
  const start = container.current?.offsetTop ?? 0;
  const [first, last] = visibleRange(
    offsets,
    viewport.top - start,
    viewport.height,
    viewport.height * OVERSCAN_SCREENS,
  );
  const total = offsets[keys.length] ?? 0;

  // Holds the first item in view where it was, when the list is away from its top.
  const anchor = useRef<{ key: number; offset: number } | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const held = anchor.current;
    if (held && element.scrollTop > LIVE_EDGE_PX) {
      const index = indexOf.get(held.key);
      const offset = index === undefined ? undefined : offsets[index];
      if (offset !== undefined && offset !== held.offset) element.scrollTop += offset - held.offset;
    }
    const [inView] = visibleRange(offsets, element.scrollTop - start, 0, 0);
    const key = keys[inView];
    anchor.current = key === undefined ? null : { key, offset: offsets[inView] ?? 0 };
  });

  // Observes what is drawn and lets go of what no longer is.
  const observed = useRef(new Set<Element>());
  useLayoutEffect(() => {
    const drawn = new Set<Element>(container.current ? [...container.current.children] : []);
    for (const element of observed.current) if (!drawn.has(element)) observer.unobserve(element);
    for (const element of drawn) if (!observed.current.has(element)) observer.observe(element);
    observed.current = drawn;
  });

  useEffect(() => {
    if (!onNearEnd || viewport.height === 0) return;
    if (total - (viewport.top - start + viewport.height) < viewport.height * NEAR_END_SCREENS) onNearEnd();
  });

  const items: ReactNode[] = [];
  for (let index = Math.max(0, first); index <= last && index < keys.length; index++) {
    const key = keys[index];
    if (key === undefined) continue;
    items.push(
      <div
        key={key}
        className="virtual-item"
        data-key={key}
        style={{ transform: `translateY(${offsets[index] ?? 0}px)` }}
      >
        {render(key)}
      </div>,
    );
  }

  return (
    <div className="virtual-list" ref={container} style={{ height: total }}>
      {items}
    </div>
  );
}
