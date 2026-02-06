import type { PlanEntryItem } from "../../types";

interface Props {
  entries: PlanEntryItem[];
}

export function Plan({ entries }: Props) {
  return (
    <div className="plan">
      <div className="plan-title">Plan</div>
      {entries.map((e, i) => {
        const icon =
          e.status === "completed"
            ? "\u2713"
            : e.status === "in_progress"
              ? "\u25B6"
              : " ";
        return (
          <div key={i} className="plan-entry">
            <span className={`marker ${e.status}`}>{icon}</span>
            <span>{e.content}</span>
          </div>
        );
      })}
    </div>
  );
}
