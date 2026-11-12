// HQ's own items on the dashboard (spec M0.7, surface S10; threat model
// SR-C-13; owner decision D3). Their words come from HQ's structured fields;
// anything an agent wrote is passed in as data and drawn only through
// AgentText or AgentMarkdown, so it cannot pose as an approval card or banner.
import type { ReactNode } from "react";
import type { AccessRequest, ActionItem, ActivityEvent } from "../data/types";
import { AgentMarkdown, AgentText } from "./agentText";

/** One line of the activity feed: HQ's sentence, then the agent's words in their own labelled span. */
export function ActivityLine({ event }: { event: ActivityEvent }) {
  return (
    <>
      {event.text}
      {event.quote && (
        <>
          {" "}
          <AgentText inline author={event.quote.author} text={event.quote.text} className="agent-quote" />
        </>
      )}
    </>
  );
}

/** An action item: title and details are the asking agent's, everything around them is HQ's. */
export function ActionItemCard({ item, from, meta, children }: { item: ActionItem; from: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div data-system-item="action">
      <div className="flex items-start gap-2">
        <b className="flex-1 text-[15px]">
          <AgentText inline author={from} text={item.title} />
        </b>
        {item.waiting && (
          <span className="chip shrink-0 text-[11px]" style={{ background: "#fff1d6" }}>
            waiting
          </span>
        )}
      </div>
      {meta}
      {item.details && <AgentMarkdown author={from} source={item.details} className="text-[13px]" />}
      {children}
    </div>
  );
}

/** An agent asks to reach a site: the domain and the reason are the agent's. */
export function AccessRequestRow({ request, agentName }: { request: AccessRequest; agentName: string }) {
  return (
    <span data-system-item="access">
      <b>{agentName}</b> wants to reach <AgentText inline author={agentName} text={request.domain} className="font-term" />
      {request.reason && (
        <>
          {" "}
          <AgentText inline author={agentName} text={request.reason} className="text-muted" />
        </>
      )}
    </span>
  );
}

/** A "Needs you" row: HQ's sentence with the agent's words, when there are any, in their own span. */
export function NeedsYouRow({ before, quote, after }: { before: string; quote?: { author: string; text: string }; after?: string }) {
  return (
    <span data-system-item="needs-you">
      {before}
      {quote && (
        <>
          {" "}
          <AgentText inline author={quote.author} text={quote.text} />
        </>
      )}
      {after ? ` ${after}` : ""}
    </span>
  );
}

/** An agent's status note: HQ's own note as text; one that holds agent words wholly inside AgentText. */
export function StatusNote({ note, flagged, author, className = "" }: { note: string; flagged?: boolean; author: string; className?: string }) {
  return flagged ? <AgentText inline author={author} text={note} className={className} /> : <span className={className}>{note}</span>;
}
