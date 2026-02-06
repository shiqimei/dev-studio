interface Props {
  text: string;
}

export function ThoughtMessage({ text }: Props) {
  if (!text) return null;
  return <div className="msg thought">{text}</div>;
}
