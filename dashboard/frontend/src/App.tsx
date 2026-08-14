import {
  EpochCard,
  StatusCard,
  TransactionsCard,
  ValidatorsCard,
} from "./components/cards";
import { Header } from "./components/Header";
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
        <NetworkCard />
      </main>
    </div>
  );
}
