import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { monogram } from "../logo";

/** A logo in a circle, with the name's first letter until it loads, or where there is none or it
 *  fails. Keyed by URL, so a new leader never shows the last one's logo while its own loads;
 *  `no-referrer` keeps the dashboard's address out of the request. */
export function Logo({
  url,
  size,
  name,
}: {
  url: string | null;
  size: number;
  name?: string | null;
}): ReactElement {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const src = url && failedUrl !== url ? url : null;

  // A cached image is complete before paint; caught here so its letter does not flash.
  useLayoutEffect(() => {
    const current = image.current;
    if (src && current?.complete && current.naturalWidth > 0) setLoadedUrl(src);
  }, [src]);

  return (
    <span className="logo" style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}>
      {(src === null || loadedUrl !== src) && (
        <span className="logo-letter" aria-hidden="true">
          {monogram(name)}
        </span>
      )}
      {src && (
        <img
          key={src}
          ref={image}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedUrl(src)}
          onError={() => setFailedUrl(src)}
        />
      )}
    </span>
  );
}
