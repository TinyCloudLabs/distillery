// auth.ts — client-side session plumbing shared across the feed.
//
// Two recoverability problems this solves:
//   1. A stale/orphaned session: API calls start 401ing, but the AuthGate only
//      checked /auth/me once on mount, so the feed stayed rendered with no way
//      back. Fix: `apiFetch` wraps every /api call and, on any 401, dispatches
//      a window event the AuthGate listens for — which re-shows <SignIn/>.
//   2. No sign-out: `signOut` POSTs /auth/signout (kills the session + clears
//      the cookie) then fires the same event so the UI drops to the sign-in
//      screen immediately.
//
// A window event (rather than threaded callbacks) keeps the wrapper a drop-in
// replacement for `fetch` anywhere in the tree without prop-drilling auth state.

/** Fired whenever the session is known to be dead (a 401, or an explicit
 *  sign-out). The AuthGate listens and re-shows the sign-in screen. */
export const UNAUTHORIZED_EVENT = "distillery:unauthorized";

function emitUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

/**
 * Drop-in `fetch` for same-origin /api calls. Identical to `fetch`, except a
 * 401 response surfaces the sign-in screen (via UNAUTHORIZED_EVENT) before the
 * response is returned to the caller — so a stale session can never strand the
 * user on a dead feed. The caller still gets the Response and can handle the
 * 401 however it likes (the AuthGate swap happens regardless).
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) emitUnauthorized();
  return res;
}

/** Kill the session server-side, then flip the UI back to the sign-in screen.
 *  Idempotent and best-effort: even if the network call fails we still emit the
 *  event so the user isn't trapped. */
export async function signOut(): Promise<void> {
  try {
    await fetch("/auth/signout", { method: "POST" });
  } catch {
    // best-effort — surface sign-in regardless
  }
  emitUnauthorized();
}
