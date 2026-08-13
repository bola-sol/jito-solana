import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./connection";
import { Store } from "./store";
import { StoreContext } from "./useStore";
import "./styles.css";

function Root() {
  const [store] = useState(() => new Store());
  useEffect(() => connect(store), [store]);
  return (
    <StoreContext.Provider value={store}>
      <App />
    </StoreContext.Provider>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
