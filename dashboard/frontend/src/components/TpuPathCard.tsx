import { useEffect, useState } from "react";
import { count, percent } from "../format";
import { useNarrow } from "../narrow";
import {
  admittedShare,
  doorSection,
  executedSection,
  listenerSection,
  LOSSES_SHOWN,
  LOSSES_SHOWN_NARROW,
  portNamed,
  readOpenPorts,
  stakedShare,
  streamSection,
  verifySection,
  writeOpenPorts,
  type PathLoss,
  type PathSection,
} from "../tpuPath";
import type { ExecutedStage, QuicPaths, QuicPort, VerifyStage } from "../types";
import { useStore } from "../useStore";
import { Card, Explain } from "./primitives";

/**
 * Everything that happens to a transaction before the scheduler sees it.
 *
 * The card is here whenever the TPU port has been offered anything, which on a
 * validator with an open port is always. That is the point of it: the two
 * sections at the foot go quiet between leader slots, and the card this
 * replaces left the grid entirely whenever they did, so an operator with few
 * slots could rarely open the dashboard at a moment it was there to read.
 *
 * Five sections, each drawn against its own total. They do not reconcile and
 * are not meant to: the door counts connections, the streams count streams, and
 * the three below count transactions, measured by three subsystems on three
 * cadences. A single chain across them would look authoritative and be quietly
 * wrong, so each restarts at its own hundred percent under its own heading.
 *
 * What the scheduler did with what arrived is not here. It is per leader slot
 * and it is on the slot page, joined to the block it produced, which is where a
 * figure that only exists during leader slots belongs.
 */
export function TpuPathCard() {
  const store = useStore();
  const paths = store.get<QuicPaths | null>("summary", "quic_paths");
  const verify = store.get<VerifyStage | null>("summary", "verify");
  const executed = store.get<ExecutedStage | null>("summary", "executed");
  const [open, setOpen] = useState(readOpenPorts);
  useEffect(() => writeOpenPorts(open), [open]);

  if (!paths) return null;
  const tpu = portNamed(paths.ports, "tpu");
  if (!tpu) return null;

  const admitted = admittedShare(tpu);
  const staked = stakedShare(tpu);
  const others = paths.ports.filter((port) => port.name !== "tpu");
  const sections = [
    doorSection(tpu, tpu.kernel_drops),
    streamSection(tpu),
    listenerSection(tpu),
    ...(verify ? [verifySection(verify)] : []),
    ...(executed ? [executedSection(executed)] : []),
  ];

  return (
    <Card
      title="TPU Path"
      aside={`${count(tpu.open)} open · ${count(tpu.active_streams)} streams`}
      className="path-body"
    >
      <div className="path-headline">
        <div className="path-figure">
          <span className="path-figure-value is-through">
            {admitted === null ? "—" : percent(admitted, 1)}
          </span>
          <span className="path-figure-label">
            <Explain text="Of every connection offered to the TPU port, the share this validator let in. The offer says more about the cluster than about this node, since an open port is offered far more than it could ever carry. What the node decides is how much of it to take, and this is that decision as one figure.">
              Admitted of offered
            </Explain>
          </span>
        </div>
        <div className="path-figure">
          <span className="path-figure-value">
            {staked === null ? "—" : percent(staked, 0)}
          </span>
          <span className="path-figure-label">
            <Explain text="Of the connections that were admitted, the share from peers holding stake. This is the figure that says whether stake weighting is doing anything for you: under pressure the limits are meant to keep letting staked peers in while the rest are shed, and a leader watching this fall during a busy slot is watching that fail.">
              Staked
            </Explain>
          </span>
        </div>
      </div>

      {sections.map((section) => (
        <Section key={section.key} section={section} />
      ))}

      {others.map((port) => (
        <OtherPort
          key={port.name}
          port={port}
          open={open.includes(port.name)}
          onFold={() =>
            setOpen((names) =>
              names.includes(port.name)
                ? names.filter((name) => name !== port.name)
                : [...names, port.name],
            )
          }
        />
      ))}

      <div className="card-footnote">
        Five minutes of the QUIC listener's own counters. Each section is drawn
        against its own total; the sections do not add up against each other,
        because nothing counts a transaction across all of them. What the
        scheduler then did with a leader slot's traffic is on that slot's own
        page.
      </div>
    </Card>
  );
}

/**
 * One stage: a bar, what came out of it, and the losses beside it.
 *
 * The heading matters more here than it would in a single list. Every section
 * restarts at a hundred percent against its own total, and without a rule and a
 * name between them the card would read as one cascade that repeatedly climbs
 * back to full.
 */
function Section({ section }: { section: PathSection }) {
  const narrow = useNarrow();
  const [expanded, setExpanded] = useState(false);
  const cap = narrow ? LOSSES_SHOWN_NARROW : LOSSES_SHOWN;
  const shown = expanded ? section.losses : section.losses.slice(0, cap);
  // The detail rows never appear in the bar and never appear folded: they are
  // reasons behind one of the rows above rather than siblings of it, so showing
  // them alongside would read as another share of the same total.
  const more = section.losses.length - shown.length + (expanded ? 0 : section.detail.length);
  // Whether there is anything to expand at all, which is not the same as
  // whether anything is hidden right now: counted from what is hidden, the
  // control disappears the moment it is used and the section cannot be folded
  // back up again.
  const foldable = section.losses.length > cap || section.detail.length > 0;

  return (
    <section className="path-section">
      <div className="path-section-head">
        <Explain text={section.explain}>
          <span className="path-section-title">{section.title}</span>
        </Explain>
        <span className="path-section-note">{section.note}</span>
        {/* What went in and what came out, which is the whole section in one
            line for anyone not reading the rest of it. The word is the
            section's own: admitted, carried, verified. */}
        <span className="path-section-flow">
          {count(section.total)} in · {count(section.through.count)}{" "}
          {section.through.label}
        </span>
      </div>

      {section.aside && (
        <div className={`path-aside${section.aside.warn ? " tone-warn" : ""}`}>
          <Explain text={section.aside.explain}>
            {section.aside.label} {count(section.aside.count)} {section.aside.unit}
          </Explain>
        </div>
      )}

      {/* One bar cut into what got through and what did not, rather than a bar
          per row. The segments are a single hue stepped by lightness in the
          order the losses are listed, so the ramp says which is larger and
          nothing implies a severity that is not there. Tone lives on the
          figures below, where it can mean something. */}
      <div className="path-bar" aria-hidden="true">
        <i
          className="path-seg is-through"
          style={{ width: `${(section.through.count / Math.max(1, section.total)) * 100}%` }}
        />
        {section.losses.map((loss, index) => (
          <i
            key={loss.key}
            className={`path-seg is-${Math.min(index + 1, LOSSES_SHOWN)}`}
            style={{ width: `${loss.share * 100}%` }}
          />
        ))}
      </div>
      <div className="path-legend">
        {shown.map((loss, index) => (
          <Loss key={loss.key} loss={loss} rank={Math.min(index + 1, LOSSES_SHOWN)} />
        ))}
        {expanded &&
          section.detail.map((loss) => <Loss key={loss.key} loss={loss} rank={null} />)}
      </div>

      {(foldable || section.zeros > 0) && (
        <div className="path-quiet">
          {foldable && (
            <button
              type="button"
              className="path-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((was) => !was)}
            >
              {expanded ? "show fewer" : `+ ${count(more)} more`}
            </button>
          )}
          {section.zeros > 0 && (
            <Explain text="Counters this section watches that stayed at nought over the window. Kept as a figure rather than as rows: a counter at nought is worth knowing, since it is the difference between nothing having gone wrong and nothing being measured, but a column of noughts is most of what made this card too tall to read.">
              <span>
                {count(section.zeros)} counter{section.zeros === 1 ? "" : "s"} at zero
              </span>
            </Explain>
          )}
        </div>
      )}
    </section>
  );
}

/** One loss in the legend, keyed to its segment by colour. */
function Loss({ loss, rank }: { loss: PathLoss; rank: number | null }) {
  return (
    <div className={`path-loss${rank === null ? " is-detail" : ""}`}>
      <i className={`path-swatch${rank === null ? "" : ` is-${rank}`}`} aria-hidden="true" />
      <Explain text={loss.explain} className="path-loss-label">
        {loss.label}
      </Explain>
      <span className={`path-loss-count${loss.warn ? " tone-warn" : ""}`}>
        {count(loss.count)}
      </span>
      <span className="path-loss-share">{percent(loss.share, 1)}</span>
    </div>
  );
}

/**
 * One of the two quieter QUIC ports, folded to a line.
 *
 * Neither feeds verification or the scheduler, so neither gets the sections
 * below the door, and on most validators neither has much to report. Folded
 * they are a line saying so, which is what an operator wants from them almost
 * always, and unfolded they are the two sections the TPU port gets.
 *
 * The head is a row with a button in it rather than a row that is a button,
 * because the share needs an explanation and an explanation is itself a button,
 * which cannot be nested inside another one.
 */
function OtherPort({
  port,
  open,
  onFold,
}: {
  port: QuicPort;
  open: boolean;
  onFold: () => void;
}) {
  const admitted = admittedShare(port);

  return (
    <section className="path-port">
      <div className="path-port-head" onClick={onFold}>
        <span className="path-port-name">{port.name}</span>
        <span className="path-port-note">
          <Explain
            text={`Connections offered to the ${port.name} port over the same five minutes, and the share of them admitted. This port has its own listener with its own limits, so it is counted separately rather than added to the TPU port above.`}
          >
            {count(port.offered)} offered
            {admitted === null ? "" : ` · ${percent(admitted, 1)} admitted`}
          </Explain>
        </span>
        <button
          type="button"
          className="path-port-fold"
          aria-expanded={open}
          aria-label={`${open ? "Fold" : "Unfold"} ${port.name}`}
          onClick={(event) => {
            // The row under it toggles too, and two toggles are none.
            event.stopPropagation();
            onFold();
          }}
        >
          {open ? "−" : "+"}
        </button>
      </div>
      {open && (
        <div className="path-port-open">
          <Section section={doorSection(port, port.kernel_drops)} />
          <Section section={streamSection(port)} />
        </div>
      )}
    </section>
  );
}
