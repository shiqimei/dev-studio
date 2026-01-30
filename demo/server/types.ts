import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";

export interface AcpSession {
  connection: ClientSideConnection;
  sessionId: string;
  agentProcess: ChildProcess;
}

export type BroadcastFn = (msg: object) => void;
