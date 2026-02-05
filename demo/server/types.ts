import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";

export interface AcpConnection {
  connection: ClientSideConnection;
  agentProcess: ChildProcess;
}

export type BroadcastFn = (msg: object) => void;
