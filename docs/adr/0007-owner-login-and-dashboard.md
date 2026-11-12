# ADR 0007: Owner login and a safe dashboard

- **Status:** accepted (M0-C)
- **Spec:** M0.7, M0.14 (per-command human-role check), surfaces S5 and S10, §2b owner-side risks, §9 items 2 and 6
- **Requirements:** `docs/security/threat-model-m0.md` §3.2, SR-C-01 to SR-C-19
- **Owner decisions:** D3 and SR-C-19 (2026-11-12)

## Context

Until M0-C, anyone holding the per-start browser token could drive the dashboard. The token was printed on the console and carried in the URL. The dashboard is also the device the owner approves things on, often from a phone, and it shows text that agents wrote.

## Decisions

### Credentials at rest (SR-C-19)

- **Password and PIN:** stored as `scrypt` hashes (N = 2^15, r = 8, p = 1, 16-byte salt) in `human_credentials` (migration 005).
- **TOTP seed:** encrypted with AES-256-GCM. The key is 32 random bytes in `<company home>/owner.key` (mode 0600), never in the database. A copy of `company.db` alone opens nothing.
- **Backups:** the off-host backup (M0-G) must carry `company.db` and never `owner.key`. The overview's carry-forward table records this.
- **Replay:** a TOTP code works once. The last step used is stored, and a trigger stops it going back.
- **Timing:** an unknown or disabled account still runs one `scrypt`, so the time a login takes does not reveal which accounts exist.

### Enrollment and recovery

- **First run:** while no owner is enrolled, HQ writes a one-time setup code to `<company home>/owner-setup.txt` (0600) and only prints the file's path. Enrolling needs the code, so it needs someone who can read files on the host.
- **Second factor:** enrollment shows the TOTP secret once (base32 and an `otpauth:` link) and finishes when the authenticator's first code is right.
- **Recovery:** `jsm-hq reset-owner`, run on the host with HQ stopped, forgets the owner's credentials and writes a new setup code.
- **PIN rotation:** in M0-C this is how the PIN is rotated too, renewing every credential at once. A `changePin` command (current PIN plus the new one) is carried to M1.

### Sessions

- **Where they live:** in memory, under the SHA-256 of a 32-byte cookie value. The value itself is never kept, and an HQ restart logs everyone out.
- **The cookie:** `hq_session`, with `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` when the request came over HTTPS.
- **Lifetimes:** idle 30 minutes, absolute 12 hours. Logout ends the session on the server, and every socket of an ended session is closed with code 4401.
- **What counts as activity:** an HTTP request with the cookie, and a message from the browser. Frames HQ pushes do not, so an open tab nobody uses goes idle.
- **The WebSocket upgrade:** needs a live session and an `Origin` on the allow list. An upgrade with no `Origin` is refused. `HQ_DASHBOARD_ORIGINS` adds origins, such as the Tailscale name.

### Remote sessions

HQ listens on 127.0.0.1, so a phone arrives through a local proxy (`tailscale serve`). A session is **local** only when all three hold:
- the socket address is loopback;
- there is no `X-Forwarded-For`, `Forwarded` or `Tailscale-*` header;
- `Host` is `127.0.0.1`, `localhost` or `[::1]`.

Anything else is **remote**, and a remote session may not use the host shell, the terminal or the sandbox shell. Separate listeners (SR-G-01, M0-G) make this exact.

### Lockouts (SR-C-18)

- **Login:** five failed logins or setup codes from one source within 15 minutes lock that source for 15 minutes.
- **The source:** the socket address, or for a loopback socket, the **last** `X-Forwarded-For` address (the one the proxy on this host added) when `net.isIP` accepts it. The client's own addresses are never used, and the header text is never written.
- **Audit:** failures are audited once per source and minute, with a count. The password and code are never recorded.
- **PIN:** five wrong PINs lock the PIN step for that human for 15 minutes.

### The PIN travels with its command (SR-C-05)

The browser sends the PIN inside the command message it confirms. The server checks it for that message only and keeps nothing a second command could reuse.

### The browser (SR-C-10 to SR-C-15)

- **Headers:** every response carries a CSP with `default-src 'self'`, `script-src 'self'` and `frame-ancestors 'none'`, plus `nosniff` and `no-referrer`.
  - `style-src` allows `'unsafe-inline'` for the `<style>` elements xterm.js adds; this allows no script.
  - PixiJS is loaded through `pixi.js/unsafe-eval`, its build that needs no `eval`.
  - Violations are blocked, not reported. A report endpoint would be an unauthenticated write path into the audit trail.
- **Agent text** is shown only through components that label its author and never parse it as HTML. The Owner Briefing's markdown (M1) and action-item details go through an allow-list renderer.
- **Terminal output** from agents loses OSC 52 (clipboard) and OSC 8 (hyperlink) sequences before it reaches the browser.
- **The sandbox opener (SR-C-15, partial):** HQ no longer sets `BROWSER` for agent sessions, but the opener sbx installs inside the sandbox (`/usr/local/bin/xdg-open`) can still be called by name, and HQ cannot remove it. M0-G checks on the Linux host whether `sbx` can turn it off.

## Consequences

- The per-start token and the dev token file are gone. The first start after upgrading shows enrollment.
- Under `pnpm dev:hq`, Vite serves the page and needs inline scripts for hot reload, so the CSP applies only where HQ serves the UI.
- One stolen, unlocked phone still holds the session, TOTP and the PIN together. §2b accepts this for M1; short sessions limit it.
