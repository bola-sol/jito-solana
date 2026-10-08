import type { ReactElement } from "react";
import { shortKey } from "../format";

/** A validator's name, else its address: whole where the cell holds it, shortened elsewhere. */
export function WriterName({ name, identity }: { name: string | null; identity: string }): ReactElement {
  return (
    <b>
      {name ?? (
        <>
          <span className="writer-key-full">{identity}</span>
          <span className="writer-key-short">{shortKey(identity, 6, 5)}</span>
        </>
      )}
    </b>
  );
}
