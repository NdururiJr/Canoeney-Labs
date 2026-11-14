// The real data source: a WebSocket to the local HQ server.
// Server → browser: OfficeEvent JSON. Browser → server: { cmd, args, id, pin? }.
// The socket rides on the owner's session cookie (M0-C): no token in the URL.
// A command that needs the approval PIN is answered "pin-required", and the
// PIN dialog sends it again with the PIN.

import { askPin } from "../../store/auth";
import type { ConnectionStatus, OfficeDataSource, OfficeEvent } from "../source";

/** What a closed socket means. HQ closes a socket whose session ended with 4401; a refused upgrade never opens. */
export function statusAfterClose(o: { code: number; opened: boolean; retry: number }): ConnectionStatus {
  if (o.code === 4401) return "unauthorized";
  return !o.opened && o.retry > 2 ? "unauthorized" : "reconnecting";
}

const PIN_ERRORS = new Set(["pin-required", "pin-wrong", "pin-locked"]);

export function createWsSource(): OfficeDataSource {
  let ws: WebSocket | null = null;
  const queue: string[] = [];
  const pending = new Map<string, { cmd: string; args: unknown[] }>();
  let seq = 0;
  /** The project this tab views; sent again after a reconnect, which starts on HQ's default. */
  let viewing: string | null = null;

  const transmit = (cmd: string, args: unknown[], pin?: string) => {
    const id = `c${++seq}`;
    if (pending.size > 500) pending.clear();
    pending.set(id, { cmd, args });
    const msg = JSON.stringify({ cmd, args, id, ...(pin ? { pin } : {}) });
    if (ws?.readyState === WebSocket.OPEN) ws.send(msg);
    // A PIN is never queued: it goes with a live connection or not at all.
    else if (!pin && queue.length < 200) queue.push(msg);
  };
  const send = (cmd: string, ...args: unknown[]) => transmit(cmd, args);
  /** HQ's answer to one command: ask for the PIN when it needs one. */
  const onResult = (e: { id: string; ok: boolean; error?: string }) => {
    const sent = pending.get(e.id);
    pending.delete(e.id);
    if (sent && !e.ok && e.error && PIN_ERRORS.has(e.error)) askPin({ ...sent, reason: e.error as "pin-required" });
  };

  const source: OfficeDataSource = {
    connect(onEvent, onStatus) {
      // Each connect() owns its socket and retry loop, so a stale one can't reconnect.
      let active = true;
      let retry = 0;
      let timer: number | null = null;
      let socket: WebSocket | null = null;

      const open = () => {
        if (!active) return;
        onStatus?.(retry ? "reconnecting" : "connecting");
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const sock = new WebSocket(`${proto}://${location.host}/ws`);
        socket = sock;
        let opened = false;
        sock.onopen = () => {
          if (!active) return sock.close();
          opened = true;
          retry = 0;
          ws = sock;
          onStatus?.("open");
          if (viewing) sock.send(JSON.stringify({ type: "select", projectId: viewing }));
          while (queue.length) sock.send(queue.shift() as string);
        };
        sock.onmessage = (m) => {
          if (!active) return;
          try {
            const e = JSON.parse(String(m.data)) as OfficeEvent;
            if (e.type === "command.result") onResult(e);
            onEvent(e);
          } catch {
            /* ignore malformed frames */
          }
        };
        sock.onclose = (ev) => {
          if (ws === sock) ws = null;
          if (!active) return;
          const status = statusAfterClose({ code: ev.code, opened, retry });
          onStatus?.(status);
          // The session ended: the login screen takes over, no retry loop. Nothing typed or
          // asked before is sent on a later session.
          if (status === "unauthorized") {
            queue.length = 0;
            pending.clear();
            return;
          }
          retry += 1;
          timer = window.setTimeout(open, Math.min(5000, 400 * retry));
        };
      };
      open();

      return () => {
        active = false;
        if (timer) window.clearTimeout(timer);
        // Closing mid-handshake logs a browser warning; onopen closes it instead.
        if (socket && socket.readyState !== WebSocket.CONNECTING) socket.close();
        if (ws === socket) ws = null;
      };
    },
    sendWithPin: (cmd, args, pin) => transmit(cmd, args, pin),
    selectProject: (id) => {
      viewing = id;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "select", projectId: id }));
    },
    addProject: (path) => send("addProject", path),
    sendTerminalInput: (id, data) => send("sendTerminalInput", id, data),
    resizeTerminal: (id, cols, rows) => send("resizeTerminal", id, cols, rows),
    assignTask: (taskId, agentId) => send("assignTask", taskId, agentId),
    sendMessage: (toId, text) => send("sendMessage", toId, text),
    startAgent: (id) => send("startAgent", id),
    stopAgent: (id) => send("stopAgent", id),
    openWorkspace: (id) => send("openWorkspace", id),
    recreateSandbox: (id) => send("recreateSandbox", id),
    recheckSetup: () => send("recheckSetup"),
    runSetupFix: (id) => send("runSetupFix", id),
    addAgent: (input) => send("addAgent", input),
    updateAgent: (id, patch) => send("updateAgent", id, patch),
    removeAgent: (id, opts) => send("removeAgent", id, opts),
    inspectWorkspace: (id) => send("inspectWorkspace", id),
    updateSandbox: (id, patch) => send("updateSandbox", id, patch),
    setSecret: (id, name, value) => send("setSecret", id, name, value),
    removeSecret: (id, name) => send("removeSecret", id, name),
    setProxy: (url) => send("setProxy", url),
    openEnvFile: (id) => send("openEnvFile", id),
    refreshSbx: () => send("refreshSbx"),
    updateWorkflow: (patch) => send("updateWorkflow", patch),
    updateProject: (patch) => send("updateProject", patch),
    createBoard: (title) => send("createBoard", title),
    updateBoard: (id, patch) => send("updateBoard", id, patch),
    completeWelcome: (input) => send("completeWelcome", input),
    previewRepoImport: () => send("previewRepoImport"),
    importRepoConfig: (sha256) => send("importRepoConfig", { sha256 }),
    approveProjectNotes: (sha256) => send("approveProjectNotes", sha256),
    openShell: (id) => send("openShell", id),
    closeShell: (id) => send("closeShell", id),
    openHostShell: (dir, fresh) => send("openHostShell", dir, fresh === true),
    closeHostShell: () => send("closeHostShell"),
    forwardPort: (agentId, port) => send("forwardPort", agentId, port),
    unforwardPort: (agentId, port) => send("unforwardPort", agentId, port),
    updateStack: (stack) => send("updateStack", stack),
    resolveActionItem: (id, decision, note) => send("resolveActionItem", id, decision, note),
    refreshMcp: () => send("refreshMcp"),
    addMcp: (input) => send("addMcp", input),
    authMcp: (name) => send("authMcp", name),
    removeMcp: (name) => send("removeMcp", name),
    setAgentMcp: (agentId, names) => send("setAgentMcp", agentId, names),
    answerApproval: (agentId, approvalId, decision) => send("answerApproval", agentId, approvalId, decision),
    resolveAccess: (requestId, decision) => send("resolveAccess", requestId, decision),
  };
  return source;
}
