// Who is logged in, and a command waiting for the approval PIN (M0-C).
import { create } from "zustand";
import { fetchAuthState, type AuthState } from "../data/authState";

export interface PinRequest {
  cmd: string;
  args: unknown[];
  /** Why it is asked: first time, a wrong PIN, or locked. */
  reason: "pin-required" | "pin-wrong" | "pin-locked";
}

interface AuthStore {
  state: AuthState | null;
  pin: PinRequest | null;
}

export const useAuth = create<AuthStore>(() => ({ state: null, pin: null }));

export async function refreshAuth(): Promise<void> {
  const state = await fetchAuthState();
  useAuth.setState({ state: state ?? { enrolled: true, session: null } });
}

export const askPin = (pin: PinRequest | null) => useAuth.setState({ pin });

/** True in a session the server treats as remote: no terminal or shells (SR-C-08). */
export const useRemote = () => useAuth((s) => s.state?.session?.remote === true);
