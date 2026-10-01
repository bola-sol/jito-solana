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
import { GossipPage } from "./components/GossipPage";
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

  const rail = page === "overview";
  const classes = ["app"];
  if (rail && collapsed) classes.push("is-collapsed");
  if (!rail) classes.push("is-full");
  // While the validator boots, everything but the boot sequence is blurred, by the same test the
  // verdict uses.
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
        {page === "gossip" && <GossipPage query={route.query} onQuery={(query) => go({ ...route, query }, true)} />}
      </main>
    </div>
  );
}

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
      <div className="grid">
        <NetworkCard />
        <IngestCard />
      </div>
      <HostCard />
      <ReplayCard />
      <CachesCard />
      <TpuPathCard />
    </>
  );
}

const PAGES: { page: Page; label: string }[] = [
  { page: "overview", label: "Overview" },
  { page: "slots", label: "Slot details" },
  { page: "schedule", label: "Schedule" },
  { page: "gossip", label: "Gossip" },
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
