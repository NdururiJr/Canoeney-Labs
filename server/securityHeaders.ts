// Headers on every response HQ sends (spec M0.7, surface S10; threat model
// SR-C-12; docs/adr/0007-owner-login-and-dashboard.md).
//
// The Content Security Policy allows only HQ's own files: no inline script, no
// eval, no framing. style-src keeps 'unsafe-inline' for the <style> elements
// xterm.js adds; that allows no script. PixiJS is loaded through its build that
// needs no eval (pixi.js/unsafe-eval). Violations are blocked, not reported: a
// report endpoint would be an unauthenticated write path into the audit trail.

/** A Host header that can go into the policy as it is. Anything else is left out. */
const PLAIN_HOST = /^[A-Za-z0-9.\-[\]:]+$/;

export function securityHeaders(host: string | undefined): Record<string, string> {
  const ws = host && PLAIN_HOST.test(host) ? ` ws://${host} wss://${host}` : "";
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${ws}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
}
