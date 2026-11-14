import type { ImportPreview as Preview } from "../../data/types";
import { AgentText } from "../agentText";

const SOURCE = ".jsmhq/config.json";

/**
 * What importing the repo's old config would write that loosens a control, shown
 * before the PIN (M0-D1, D3). Every value from the file is agent text: an agent
 * may have written it in a pull request.
 */
export function ImportPreview({ preview, onImport, sending = false }: { preview: Preview; onImport: () => void; sending?: boolean }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-[16px] font-bold">Review the import</h3>
      <p className="m-0 text-[13px] text-muted">
        These settings come from a file in the repo, which an agent could have changed. Each one loosens a control. Import only if every line is what you expect.
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {preview.lines.map((line, i) => (
          <li key={i} className="flex flex-col gap-1">
            <span className="text-[14px] font-bold">{line.text}</span>
            {line.fromFile.map((value, j) => (
              <AgentText key={j} author={SOURCE} text={value} />
            ))}
          </li>
        ))}
      </ul>
      {!!preview.dropped && (
        <p className="m-0 text-[13px] text-muted">
          {preview.dropped === 1 ? "1 site or MCP server name" : `${preview.dropped} site or MCP server names`} in the file {preview.dropped === 1 ? "is" : "are"} not valid, so {preview.dropped === 1 ? "it is" : "they are"} not imported.
        </p>
      )}
      {preview.boards.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[14px] font-bold">Tasks from .jsmhq/plan.json ({preview.tasks})</span>
          {preview.boards.map((b, i) => (
            <div key={i} className="flex flex-col gap-1">
              <AgentText inline author=".jsmhq/plan.json" text={b.title} />
              {b.tasks.map((title, j) => (
                <AgentText key={j} author=".jsmhq/plan.json" text={title} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div>
        <button type="button" className="btn" disabled={sending} onClick={onImport}>
          Import with PIN
        </button>
      </div>
    </section>
  );
}
