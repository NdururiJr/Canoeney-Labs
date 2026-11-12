import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { HOST_TERMINAL } from "../../data/types";
import { officeActions } from "../../store/office";
import { readTerminal, subscribeTerminal } from "../../store/terminal";
import { FONT_EVENT, savedFont, terminalFont, type FontStyle } from "../../theme/fonts";

const theme = {
  background: "#16213f",
  foreground: "#dfe6ff",
  cursor: "#dfe6ff",
  cursorAccent: "#16213f",
  selectionBackground: "#2c3b6b",
  black: "#241a2e",
  red: "#ff5c86",
  green: "#6cf08a",
  yellow: "#ffc14d",
  blue: "#29adff",
  magenta: "#ff77a8",
  cyan: "#3ee0d0",
  white: "#dfe6ff",
};

/** Opens a link from a terminal in a new tab. Only web links: a terminal's output is untrusted. */
function openLink(uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  window.open(url.href, "_blank", "noopener,noreferrer");
}

/** A real xterm.js terminal fed by the agent's (mock) output stream. */
export function TerminalView({ agentId, autoFocus = true }: { agentId: string; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const font = terminalFont(savedFont());
    const term = new Terminal({
      theme,
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: font.lineHeight,
      cursorBlink: true,
      scrollback: 3000,
      convertEol: false,
      allowProposedApi: false,
      // Links a program marks as links (OSC 8), e.g. with FORCE_HYPERLINK set: the full URL, however it wraps.
      linkHandler: { activate: (_e, uri) => openLink(uri), allowNonHttpProtocols: false },
    });
    // A second layer under the server's filter (SR-C-14): xterm itself drops clipboard writes (OSC 52) and
    // links with a hidden target (OSC 8) in every terminal but your own host shell.
    if (agentId !== HOST_TERMINAL) {
      term.parser.registerOscHandler(8, () => true);
      term.parser.registerOscHandler(52, () => true);
    }
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Plain URLs in the output, including ones the terminal wrapped onto the next line.
    term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)));
    let unsub = () => {};
    let ro: ResizeObserver | null = null;

    // Font style changed in Settings: switch once the new font is loaded, then re-measure.
    const onFont = (e: Event) => {
      const f = terminalFont((e as CustomEvent<FontStyle>).detail);
      void document.fonts.load(f.load).finally(() => {
        if (disposed) return;
        term.options.fontFamily = f.family;
        term.options.fontSize = f.size;
        term.options.lineHeight = f.lineHeight;
        try {
          fit.fit();
        } catch {
          /* not open yet */
        }
      });
    };
    window.addEventListener(FONT_EVENT, onFont);

    // Measure with the font loaded, or columns come out wrong.
    void document.fonts.load(font.load).finally(() => {
      if (disposed) return;
      term.open(el);
      fit.fit();
      // The server sizes the agent's tmux window to this terminal and redraws it.
      officeActions.resizeTerminal(agentId, term.cols, term.rows);
      term.onResize(({ cols, rows }) => officeActions.resizeTerminal(agentId, cols, rows));
      term.write(readTerminal(agentId));
      unsub = subscribeTerminal(agentId, (data) => term.write(data));
      term.onData((data) => officeActions.sendTerminalInput(agentId, data));
      // Shift+Enter: xterm.js sends a plain Enter (\r), which submits. Send Alt+Enter (ESC \r)
      // instead, which Claude Code and Codex read as "new line".
      term.attachCustomKeyEventHandler((e) => {
        if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return true;
        if (e.type === "keydown") officeActions.sendTerminalInput(agentId, "\x1b\r");
        e.preventDefault();
        return false;
      });
      ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* element hidden mid-animation */
        }
      });
      ro.observe(el);
      if (autoFocus) term.focus();
    });

    return () => {
      disposed = true;
      window.removeEventListener(FONT_EVENT, onFont);
      unsub();
      ro?.disconnect();
      term.dispose();
    };
  }, [agentId, autoFocus]);

  return <div ref={host} className="h-full min-h-0 w-full bg-navy-2" />;
}
