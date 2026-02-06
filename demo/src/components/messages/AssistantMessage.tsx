import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

const plugins = { code };

interface Props {
  text: string;
  done: boolean;
}

export function AssistantMessage({ text, done }: Props) {
  if (!text) return null;
  return (
    <div className="msg assistant">
      <Streamdown mode="streaming" isAnimating={!done} plugins={plugins}>
        {text}
      </Streamdown>
    </div>
  );
}
