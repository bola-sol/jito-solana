import {
  EpochCard,
  ProgramCacheCard,
  StatusCard,
  TransactionsCard,
  ValidatorsCard,
} from "./components/cards";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
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
          <ProgramCacheCard />
        </div>
        <TransactionsCard />
      </main>
    </div>
  );
}
