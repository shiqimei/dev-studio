interface Props {
  text: string;
}

export function SystemMessage({ text }: Props) {
  return <div className="msg system">{text}</div>;
}
