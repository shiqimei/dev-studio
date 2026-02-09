import { memo } from "react";
import { useWsActions } from "../../context/WebSocketContext";
import type { PermissionOption } from "../../types";

interface Props {
  title: string;
  requestId: string;
  options: PermissionOption[];
  status: "pending" | "resolved";
  selectedOptionId?: string;
  selectedOptionName?: string;
}

export const Permission = memo(function Permission({
  title,
  requestId,
  options,
  status,
  selectedOptionId,
  selectedOptionName,
}: Props) {
  const { respondToPermission } = useWsActions();

  if (status === "resolved") {
    const isCancelled = selectedOptionId === "cancelled";
    const isRejected =
      !isCancelled &&
      options.some(
        (o) => o.optionId === selectedOptionId && o.kind.startsWith("reject"),
      );
    const decisionClass = isCancelled
      ? "permission-decision-cancelled"
      : isRejected
        ? "permission-decision-rejected"
        : "permission-decision-approved";
    return (
      <div className="permission permission-resolved">
        <span className="permission-title">{title}</span>
        <span className={`permission-decision ${decisionClass}`}>
          {selectedOptionName || selectedOptionId}
        </span>
      </div>
    );
  }

  return (
    <div className="permission permission-pending">
      <div className="permission-title">{title}</div>
      <div className="permission-actions">
        {options.map((opt) => (
          <button
            key={opt.optionId}
            className={`permission-btn permission-btn-${opt.kind}`}
            onClick={() => respondToPermission(requestId, opt.optionId, opt.name)}
          >
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  );
});
