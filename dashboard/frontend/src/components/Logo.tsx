import { useState, type ReactElement } from "react";

/** A failed load hides the element until the URL changes, as one element can show leader after
 *  leader; `no-referrer` keeps the dashboard's address out of the request. */
export function Logo({ url, size }: { url: string | null; size: number }): ReactElement | null {
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return null;
  return (
    <img
      className="logo"
      src={url}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(url)}
    />
  );
}
