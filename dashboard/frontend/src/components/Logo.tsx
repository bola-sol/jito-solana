import { useState } from "react";

/** A validator's on-chain icon, a third-party URL. A failed load hides the
 *  element; `no-referrer` keeps the dashboard's address out of the request. */
export function Logo({ url, size }: { url: string | null; size: number }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
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
      onError={() => setFailed(true)}
    />
  );
}
