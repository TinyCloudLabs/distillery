// SignIn.tsx — OpenKey front-door for the feed.
//
// <AuthGate> wraps <App/> in main.tsx: it asks /auth/me once on mount; a 401
// renders the sign-in screen instead of the feed. The passkey ceremony runs
// entirely in the browser via @openkey/sdk (WebAuthn — needs a secure
// context); the resulting AuthResult is POSTed to /auth/openkey, which checks
// the address allowlist and sets the session cookie. On success we reload so
// the feed boots with a live session.
//
// Host config copied from pulse-radio (src/lib/auth.ts): https://openkey.so —
// also the SDK default. Styling is minimal-clean on purpose; the Folio
// redesign will restyle this surface.

import { useEffect, useState, type ReactNode } from "react";

const OPENKEY_HOST = "https://openkey.so";

type AuthState = "checking" | "authed" | "signedout";

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");

  useEffect(() => {
    let alive = true;
    fetch("/auth/me")
      .then((res) => {
        if (alive) setState(res.ok ? "authed" : "signedout");
      })
      .catch(() => {
        if (alive) setState("signedout");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state === "checking") {
    return <div className="feed-status">-- CHECKING ACCESS --</div>;
  }
  if (state === "signedout") {
    return <SignIn />;
  }
  return <>{children}</>;
}

export function SignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      // Dynamic import keeps the SDK out of the signed-in bundle path.
      const { OpenKey } = await import("@openkey/sdk");
      const openkey = new OpenKey({ appName: "distillery", host: OPENKEY_HOST });
      const authResult = await openkey.connect();
      const res = await fetch("/auth/openkey", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(authResult),
      });
      if (res.status === 403) {
        throw new Error("this address is not on the allowlist");
      }
      if (!res.ok) {
        throw new Error(`sign-in failed (${res.status})`);
      }
      location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <header className="masthead chassis">
      <div className="screen" style={{ flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div className="masthead-title">DISTILLERY</div>
          <div className="masthead-sub">PRIVATE FEED &middot; SIGN IN REQUIRED</div>
        </div>
        <button
          type="button"
          className="po-btn accent"
          disabled={busy}
          onClick={() => void onSignIn()}
        >
          {busy ? "AUTHENTICATING…" : "▶ SIGN IN WITH OPENKEY"}
        </button>
        {error && <div className="feed-error">! {error}</div>}
      </div>
    </header>
  );
}
