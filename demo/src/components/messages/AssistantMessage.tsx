import { Streamdown } from "streamdown";

interface Props {
  text: string;
  done: boolean;
}

export function AssistantMessage({ text, done }: Props) {
  return (
    <div className="msg assistant">
      <Streamdown mode="streaming" isAnimating={!done}>
        {text}
      </Streamdown>
    </div>
  );
}
