// What the page shows before the office (M0-C): "can't reach HQ", first-run
// enrollment, or the login. The demo office runs only under `pnpm dev`.
import { useEffect } from "react";
import { App } from "./App";
import type { SourceChoice } from "./data/authState";
import { refreshAuth, useAuth } from "./store/auth";
import { useOffice } from "./store/office";
import { EnrollScreen, LoginScreen, PinDialog, UnreachableScreen } from "./ui/auth/AuthScreens";

export function Root({ choice }: { choice: SourceChoice }) {
  if (choice === "unreachable") return <UnreachableScreen />;
  if (choice === "mock") return <App />;
  return <AuthGate />;
}

function AuthGate() {
  const state = useAuth((s) => s.state);
  const connection = useOffice((s) => s.connection);
  useEffect(() => {
    void refreshAuth();
  }, []);
  // The socket was refused or its session ended: check again, which shows the login.
  useEffect(() => {
    if (connection === "unauthorized") void refreshAuth();
  }, [connection]);
  if (!state) return <div className="p-4 text-[14px]">Connecting to HQ…</div>;
  if (!state.enrolled) return <EnrollScreen />;
  if (!state.session || connection === "unauthorized") return <LoginScreen />;
  return (
    <>
      <App />
      <PinDialog />
    </>
  );
}
