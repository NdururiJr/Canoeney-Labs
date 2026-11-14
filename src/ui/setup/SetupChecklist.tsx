import { useOffice } from "../../store/office";
import { TerminalView } from "../drawers/TerminalView";
import { SetupChecklistView } from "./SetupChecklistView";

/** "Get JSM HQ ready", fed from the office snapshot; a running fix shows in a terminal. */
export function SetupChecklist() {
  const setup = useOffice((s) => s.snap?.setup);
  if (!setup) return null;
  return <SetupChecklistView setup={setup} terminal={(id) => <TerminalView key={id} agentId={`setup:${id}`} />} />;
}
