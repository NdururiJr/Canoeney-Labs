import type { Task } from "../../data/types";
import { AgentText, authoredTitle } from "../agentText";

/** The task's title; its tooltip holds the description and files, which the task's author wrote. */
export function TaskCardTitle({ task, authorName }: { task: Task; authorName: string }) {
  const details = [task.description, task.files?.length ? `Files: ${task.files.join(", ")}` : "", task.doneWhen ? `Done when: ${task.doneWhen}` : ""].filter(Boolean).join("\n\n");
  return (
    <div className={`text-[14px] font-semibold leading-tight ${task.status === "done" ? "line-through" : ""}`} title={authoredTitle(authorName, details)}>
      <AgentText inline author={authorName} text={task.title} />
    </div>
  );
}
