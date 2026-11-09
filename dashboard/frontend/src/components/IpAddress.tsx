import type { ReactElement } from "react";
import { Copyable } from "./Copyable";

/** A gossip address with its country code, as every validator list shows it. */
export function IpAddress({ ip, country }: { ip: string; country: string | null }): ReactElement {
  return (
    <span className="ip-address">
      <Copyable text={ip} />
      {country && <span className="country-code">{country}</span>}
    </span>
  );
}
