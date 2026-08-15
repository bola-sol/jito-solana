import {
  EpochCard,
  StatusCard,
  TransactionsCard,
  ValidatorsCard,
} from "./components/cards";
import { Header } from "./components/Header";
import { IngestCard } from "./components/IngestCard";
import { NetworkCard } from "./components/NetworkCard";
import { Sidebar } from "./components/Sidebar";
import { VersionsCard } from "./components/VersionsCard";
import { SlotStrip } from "./components/SlotStrip";
import { useStore } from "./useStore";

export function App() {
  const store = useStore();
  const connection = store.getConnection();

  return (
    <div className="app">
      <Sidebar />
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
      </main>
    </div>
  );
}
