/** Circular progress ring for todo/plan completion tracking. */
export function TodoProgressRing({
  completed,
  total,
  size = 14,
}: {
  completed: number;
  total: number;
  size?: number;
}) {
  const strokeWidth = 2;
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const progress = total > 0 ? completed / total : 0;
  const offset = circumference * (1 - progress);
  const allDone = completed === total && total > 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`todo-ring${allDone ? " todo-ring-done" : ""}`}
    >
      {/* Background track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        className="todo-ring-track"
        strokeWidth={strokeWidth}
      />
      {/* Progress arc */}
      {progress > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          className="todo-ring-fill"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}
