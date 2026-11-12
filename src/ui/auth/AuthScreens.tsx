// Login, first-run enrollment, the approval PIN, and "can't reach HQ" (M0-C;
// docs/adr/0007-owner-login-and-dashboard.md).
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { authPost } from "../../data/authState";
import { askPin, refreshAuth, useAuth } from "../../store/auth";
import { officeActions, useOffice } from "../../store/office";

const ACCOUNT_KEY = "hq-account";

/** The enrollment link for an authenticator app, and nothing else. */
const otpauthHref = (u: string) => (u.startsWith("otpauth://totp/") ? u : undefined);

function Panel({ screen, title, children }: { screen: string; title: string; children: ReactNode }) {
  return (
    <div data-screen={screen} className="flex min-h-screen items-center justify-center bg-cream-2 p-4">
      <div className="panel w-full max-w-[420px] px-5 py-4">
        <h1 className="mb-3 text-[20px] font-bold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block text-[14px]">
      <span className="mb-1 block font-semibold">{label}</span>
      {children}
    </label>
  );
}

const savedAccount = () => {
  try {
    return localStorage.getItem(ACCOUNT_KEY) || "owner";
  } catch {
    return "owner";
  }
};

export function LoginScreen() {
  const [account, setAccount] = useState(savedAccount);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await authPost("/auth/login", { account: account.trim(), password, code: code.trim() });
    setBusy(false);
    setPassword("");
    setCode("");
    if (r.status !== 200) return setError(String(r.json.error ?? "Couldn't log in."));
    try {
      localStorage.setItem(ACCOUNT_KEY, account.trim());
    } catch {
      /* private mode */
    }
    setError(null);
    // A new session: the office connects again.
    useOffice.setState({ connection: "connecting" });
    await refreshAuth();
  };
  return (
    <Panel screen="login" title="Log in to HQ">
      <form onSubmit={submit}>
        <Field label="Account">
          <input className="field w-full" value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="username" />
        </Field>
        <Field label="Password">
          <input className="field w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
        </Field>
        <Field label="Code from your authenticator app">
          <input className="field w-full" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
        </Field>
        {error && <p className="mb-2 text-[13px] text-red">{error}</p>}
        <button className="btn btn-primary w-full" disabled={busy || !password || code.trim().length !== 6}>
          {busy ? "Checking…" : "Log in"}
        </button>
      </form>
    </Panel>
  );
}

export function EnrollScreen() {
  const [step, setStep] = useState<"details" | "secret">("details");
  const [setupCode, setSetupCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [secret, setSecret] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    const r = await authPost("/auth/enroll", { setupCode: setupCode.trim(), displayName, password, pin });
    if (r.status !== 200) return setError(String(r.json.error ?? "Couldn't start."));
    setPassword("");
    setPin("");
    setError(null);
    setSecret({ secret: String(r.json.secret), otpauth: String(r.json.otpauth) });
    setStep("secret");
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    const r = await authPost("/auth/enroll/confirm", { code: code.trim() });
    if (r.status !== 200) return setError("That code didn't match. Check the app shows HQ, and try the next code.");
    setSecret(null);
    await refreshAuth();
  };

  if (step === "secret" && secret) {
    return (
      <Panel screen="enroll" title="Add HQ to your authenticator app">
        <p className="mb-2 text-[14px]">In your authenticator app, add an account with this key. It is shown once.</p>
        <p className="mb-2 select-all break-all bg-cream-2 p-2 font-term text-[18px]">{secret.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
        <p className="mb-3 text-[13px]">
          On this phone? <a className="underline" href={otpauthHref(secret.otpauth)}>Open it in the app</a>.
        </p>
        <form onSubmit={confirm}>
          <Field label="The 6-digit code the app shows now">
            <input className="field w-full" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus />
          </Field>
          {error && <p className="mb-2 text-[13px] text-red">{error}</p>}
          <button className="btn btn-primary w-full" disabled={code.trim().length !== 6}>
            Finish
          </button>
        </form>
      </Panel>
    );
  }
  return (
    <Panel screen="enroll" title="Set up the owner">
      <p className="mb-3 text-[14px]">HQ wrote a one-time setup code to a file on the machine it runs on. Its startup message says where.</p>
      <form onSubmit={start}>
        <Field label="Setup code">
          <input className="field w-full" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoComplete="off" autoFocus />
        </Field>
        <Field label="Your name">
          <input className="field w-full" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Password (12 characters or more)">
          <input className="field w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Approval PIN (6 to 12 digits; asked again before HQ grants anything)">
          <input className="field w-full" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" />
        </Field>
        {error && <p className="mb-2 text-[13px] text-red">{error}</p>}
        <button className="btn btn-primary w-full" disabled={!setupCode || password.length < 12 || !/^\d{6,12}$/.test(pin)}>
          Next
        </button>
      </form>
    </Panel>
  );
}

const PIN_TEXT = {
  "pin-required": "This change grants or loosens something. Enter your approval PIN to confirm it.",
  "pin-wrong": "That PIN was wrong. Try again.",
  "pin-locked": "Too many wrong PINs. The PIN step is locked for 15 minutes.",
} as const;

export function PinDialog() {
  const pending = useAuth((s) => s.pin);
  const [pin, setPin] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setPin("");
    input.current?.focus();
  }, [pending]);
  if (!pending) return null;
  const close = () => {
    setPin("");
    askPin(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    officeActions.sendWithPin(pending.cmd, pending.args, pin);
    close();
  };
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(36,26,46,0.5)] p-4">
      <form className="panel w-full max-w-[360px] px-4 py-3" onSubmit={submit}>
        <b className="mb-2 block text-[16px]">Approval PIN</b>
        <p className="mb-2 text-[13px]">{PIN_TEXT[pending.reason]}</p>
        {pending.reason !== "pin-locked" && (
          <input ref={input} className="field mb-3 w-full" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          {pending.reason !== "pin-locked" && (
            <button className="btn btn-primary" disabled={!/^\d{6,12}$/.test(pin)}>
              Confirm
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export function UnreachableScreen() {
  return (
    <Panel screen="unreachable" title="Can't reach HQ">
      <p className="mb-3 text-[14px]">HQ isn't answering. It may be restarting, or this device lost its connection.</p>
      <button className="btn btn-primary w-full" onClick={() => location.reload()}>
        Retry
      </button>
    </Panel>
  );
}
