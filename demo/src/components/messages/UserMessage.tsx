interface Props {
  text: string;
}

export function UserMessage({ text }: Props) {
  return <div className="msg user">{text}</div>;
}
