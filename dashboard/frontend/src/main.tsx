import { StrictMode, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./connection";
import { dismissSplashWhenReady } from "./splash";
import { Rewind } from "./rewind";
import { RewindContext, StoreContext } from "./useStore";
import "./styles.css";

// Module scope rather than component state: the splash is removed from outside
// React, and there is exactly one dashboard per page.
const rewind = new Rewind();
const store = rewind.live;

function Root() {
  useEffect(() => connect(store, (envelope, chars) => rewind.deliver(envelope, chars)), []);
  // Only going live or into the past swaps the store; the bar follows the rest itself.
  const live = useSyncExternalStore(rewind.subscribe, () => rewind.getState().live);
  return (
    <RewindContext.Provider value={rewind}>
      <StoreContext.Provider value={live ? store : rewind.view}>
        <App />
      </StoreContext.Provider>
    </RewindContext.Provider>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

dismissSplashWhenReady(store);
