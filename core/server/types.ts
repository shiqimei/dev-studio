import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import type { WebClient } from "./client.js";

export interface AcpConnection {
  connection: ClientSideConnection;
  agentProcess: ChildProcess;
  webClient: WebClient;
  agentName?: string;
  agentVersion?: string;
}

export type BroadcastFn = (msg: object) => void;
