import { useEffect, useState } from "react";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./layout";
import {
  EpochCard,
  StatusCard,
  TransactionsCard,
  ValidatorsCard,
} from "./components/cards";
import { Header } from "./components/Header";
import { IngestCard } from "./components/IngestCard";
import { NetworkCard } from "./components/NetworkCard";
import { ProducedBlocksCard } from "./components/ProducedBlocksCard";
import { Sidebar } from "./components/Sidebar";
import { VersionsCard } from "./components/VersionsCard";
import { SlotStrip } from "./components/SlotStrip";
import { useStore } from "./useStore";

/** Base title, kept in step with index.html so the tab reads the same before
 *  the first snapshot arrives as it does after. */
const TITLE = "Agave Dashboard";

export function App() {
  const store = useStore();
  const connection = store.getConnection();
  const name = store.get<string | null>("summary", "identity_name");
  const identity = store.get<string>("summary", "identity_key");
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);

  // Named after the validator so that an operator watching several at once can
  // tell the tabs apart. `Private` matches what the header shows for a node
  // with no on-chain name, and the plain title stands until a node answers.
  useEffect(() => {
    const label = name ?? (identity ? "Private" : null);
    document.title = label ? `${TITLE} | ${label}` : TITLE;
  }, [name, identity]);

  return (
    <div className={`app${collapsed ? " is-collapsed" : ""}`}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => {
          const next = !collapsed;
          setCollapsed(next);
          writeSidebarCollapsed(next);
        }}
      />
      <main className="main">
        <Header />
        {connection === "closed" && (
          <div className="banner">
            Disconnected from the validator. Retrying…
          </div>
        )}
        <SlotStrip />
        <div className="grid">
          <EpochCard />
          <StatusCard />
          <ValidatorsCard />
          <VersionsCard />
        </div>
        <TransactionsCard />
        {/* Both read the same traffic from opposite ends: bytes on the wire,
            and what the sockets failed to take off it. */}
        <div className="grid">
          <NetworkCard />
          <IngestCard />
        </div>
        <ProducedBlocksCard />
      </main>
    </div>
  );
}
