interface Props {
  text: string;
}

export function ThoughtMessage({ text }: Props) {
  return <div className="msg thought">{text}</div>;
}
