import { useEffect, useState, type ReactElement } from "react";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./layout";
import { EpochCard, ClusterCard, TransactionsCard } from "./components/cards";
import { Header } from "./components/Header";
import { CachesCard } from "./components/CachesCard";
import { HostCard } from "./components/HostCard";
import { IngestCard } from "./components/IngestCard";
import { NetworkCard } from "./components/NetworkCard";
import { ReplayCard } from "./components/ReplayCard";
import { SchedulePage } from "./components/SchedulePage";
import { SlotDetailsPage } from "./components/SlotDetailsPage";
import { Sidebar } from "./components/Sidebar";
import { Verdict } from "./components/Verdict";
import { VersionsCard } from "./components/VersionsCard";
import { TpuPathCard } from "./components/TpuPathCard";
import { GossipStakeCard } from "./components/GossipStakeCard";
import { MissesPanel } from "./components/MissesPanel";
import { SlotStrip } from "./components/SlotStrip";
import { HOME, useRoute, type Page } from "./route";
import { useStore } from "./useStore";
import { pageTitle } from "./title";

export function App(): ReactElement {
  const store = useStore();
  const connection = store.getConnection();
  const name = store.get("summary", "identity_name");
  const identity = store.get("summary", "identity_key");
  const cluster = store.get("summary", "cluster");
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [route, go] = useRoute();
  const page = route.page;

  useEffect(() => {
    document.title = pageTitle(name, identity, cluster);
  }, [name, identity, cluster]);

  // Only the overview keeps the slot rail; the collapsed state is remembered
  // across pages.
  const rail = page === "overview";
  const classes = ["app"];
  if (rail && collapsed) classes.push("is-collapsed");
  if (!rail) classes.push("is-full");
  // While the validator boots everything but the boot sequence is blurred:
  // the rest has nothing to say yet, and the eye goes to the one thing that
  // does. The same test the verdict makes to show the phases.
  const startup = store.get("summary", "startup_progress");
  if (startup && !startup.running) classes.push("is-booting");

  return (
    <div className={classes.join(" ")}>
      {rail && (
        <Sidebar
          collapsed={collapsed}
          onToggle={() => {
            const next = !collapsed;
            setCollapsed(next);
            writeSidebarCollapsed(next);
          }}
        />
      )}
      <main className="main">
        <Header />
        {connection === "closed" && (
          <div className="banner">
            Disconnected from the validator. Retrying…
          </div>
        )}
        <Nav page={page} onSelect={(next) => go({ ...HOME, page: next })} />
        {page === "overview" && <Overview />}
        {page === "slots" && (
          <SlotDetailsPage
            slot={route.slot}
            query={route.query}
            onSlot={(slot) => go({ ...route, slot }, true)}
            onQuery={(query) => go({ ...route, query }, true)}
          />
        )}
        {page === "schedule" && (
          <SchedulePage
            query={route.query}
            ours={route.ours}
            onFilter={(query, ours) => go({ ...route, query, ours }, true)}
          />
        )}
      </main>
    </div>
  );
}

/** What this validator is doing, which is what the dashboard opens on: the
 *  sentence, the slots, the three cards, then the sections that fold. */
function Overview() {
  // Open for this visit only: a list of a hundred rows is not a place to
  // come back to on a reload.
  const [missesOpen, setMissesOpen] = useState(false);
  return (
    <>
      <Verdict />
      <SlotStrip />
      <div className="grid is-three">
        <EpochCard missesOpen={missesOpen} onToggleMisses={() => setMissesOpen((was) => !was)} />
        <ClusterCard />
        <VersionsCard />
      </div>
      {missesOpen && <MissesPanel onClose={() => setMissesOpen(false)} />}
      <GossipStakeCard />
      <TransactionsCard />
      {/* Both read the same traffic from opposite ends: bytes on the wire, and
          what the sockets failed to take off it. */}
      <div className="grid">
        <NetworkCard />
        <IngestCard />
      </div>
      {/* The machine the cards above are running on. Last of the host group
          rather than first: an operator comes to this page for the validator,
          and reaches for the box only once something here says the validator
          is struggling. */}
      <HostCard />
      {/* What replay does, then the two things it spends that time waiting
          on. Loading programs and loading accounts are rows on the first
          section and parts of the one under it, so they read downwards: how
          long, then how well each of the two is going. */}
      <ReplayCard />
      <CachesCard />
      {/* Picks the same traffic up where the socket card leaves it. That one
          counts the datagrams the kernel never handed over; this one counts
          what the QUIC listener above it made of the rest, and carries the
          three QUIC ports the socket card therefore does not draw. */}
      <TpuPathCard />
    </>
  );
}

const PAGES: { page: Page; label: string }[] = [
  { page: "overview", label: "Overview" },
  { page: "slots", label: "Slot details" },
  { page: "schedule", label: "Schedule" },
];

/** Anchors rather than buttons, so a page can open in a new tab; the click is
 *  still handled to avoid a reload. */
function Nav({ page, onSelect }: { page: Page; onSelect: (page: Page) => void }) {
  return (
    <nav className="nav" aria-label="Pages">
      {PAGES.map((entry) => (
        <a
          key={entry.page}
          href={entry.page === "overview" ? "#" : `#/${entry.page}`}
          className={`nav-tab${page === entry.page ? " is-current" : ""}`}
          aria-current={page === entry.page ? "page" : undefined}
          onClick={(event) => {
            event.preventDefault();
            onSelect(entry.page);
          }}
        >
          {entry.label}
        </a>
      ))}
    </nav>
  );
}
