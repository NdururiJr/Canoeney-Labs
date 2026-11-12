import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { chooseSource, setChosenSource } from "./data/authState";
import "./index.css";
import { applyFont, savedFont } from "./theme/fonts";

applyFont(savedFont());

// The data source is chosen before the office store loads (M0-C): the real HQ
// when /auth/state answers, the demo only under `pnpm dev` with no HQ.
void (async () => {
  const choice = await chooseSource(() => fetch("/auth/state", { credentials: "same-origin", cache: "no-store" }), import.meta.env.DEV);
  setChosenSource(choice);
  const { Root } = await import("./Root");
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <Root choice={choice} />
    </StrictMode>,
  );
})();
