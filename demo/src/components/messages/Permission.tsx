interface Props {
  title: string;
}

export function Permission({ title }: Props) {
  return <div className="permission">Allowed: {title}</div>;
}
