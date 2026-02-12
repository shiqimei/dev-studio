import { memo } from "react";
import type { PlanEntryItem } from "../../types";

export function PlanIcon({ status }: { status: "pending" | "in_progress" | "completed" }) {
  if (status === "completed") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344" />
        <path d="m9 11 3 3L22 4" />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </svg>
  );
}

interface Props {
  entries: PlanEntryItem[];
}

export const Plan = memo(function Plan({ entries }: Props) {
  return (
    <div className="plan">
      <div className="plan-title">Plan</div>
      {entries.map((e, i) => (
        <div key={i} className="plan-entry">
          <span className={`marker ${e.status}`}>
            <PlanIcon status={e.status} />
          </span>
          <span>{e.content}</span>
        </div>
      ))}
    </div>
  );
});
