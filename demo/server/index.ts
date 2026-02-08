import { startServer } from "./server.js";
import { log } from "./log.js";

const PORT = parseInt(process.env.PORT || "5689", 10);
const server = startServer(PORT);

log.info({ port: server.port }, "Claude Code ACP Demo (backend) started");
