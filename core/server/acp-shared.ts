/**
 * Shared ACP connection utilities.
 * Used by both session.ts (Claude Code) and codex-session.ts (Codex).
 */
import { Readable, Writable } from "node:stream";
import { ReadableStream, WritableStream } from "node:stream/web";
import type { AnyMessage } from "@agentclientprotocol/sdk";

export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  });
}

export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

/**
 * Wraps an ndJsonStream with taps on both directions.
 * `onSend` fires for client→agent messages.
 * `onRecv` fires for agent→client messages.
 */
export function instrumentedStream(
  base: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  },
  onSend: (msg: AnyMessage) => void,
  onRecv: (msg: AnyMessage) => void,
) {
  // Tap readable (agent → client)
  const recvTransform = new TransformStream<AnyMessage, AnyMessage>({
    transform(msg, controller) {
      onRecv(msg);
      controller.enqueue(msg);
    },
  });
  const readable = base.readable.pipeThrough(recvTransform);

  // Tap writable (client → agent)
  const sendTransform = new TransformStream<AnyMessage, AnyMessage>({
    transform(msg, controller) {
      onSend(msg);
      controller.enqueue(msg);
    },
  });
  sendTransform.readable.pipeTo(base.writable);
  const writable = sendTransform.writable;

  return { readable, writable };
}
