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

/** True when the permission is an AskUserQuestion (option IDs match q{N}_opt{M}). */
function isAskUserQuestion(options: PermissionOption[]): boolean {
  return options.length > 0 && options.every((o) => /^q\d+_opt\d+$/.test(o.optionId));
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
  const isQuestion = isAskUserQuestion(options);

  // ── AskUserQuestion: rich question UI ──
  if (isQuestion) {
    if (status === "resolved") {
      return (
        <div className="permission-question permission-question-resolved">
          <div className="permission-question-title">{title}</div>
          <div className="permission-question-answer">
            {selectedOptionName || selectedOptionId}
          </div>
        </div>
      );
    }

    return (
      <div className="permission-question">
        <div className="permission-question-title">{title}</div>
        <div className="permission-question-options">
          {options.map((opt, i) => (
            <button
              key={opt.optionId}
              className="permission-question-option"
              onClick={() => respondToPermission(requestId, opt.optionId, opt.name)}
            >
              <span className="permission-question-option-num">{i + 1}</span>
              <span className="permission-question-option-body">
                <span className="permission-question-option-label">{opt.name}</span>
                {opt.description && (
                  <span className="permission-question-option-desc">{opt.description}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Standard permission UI ──
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
