import { startServer } from "./server.js";
import { log } from "./log.js";

const PORT = parseInt(process.env.PORT || "5689", 10);
const server = startServer(PORT);

log.info({ port: server.port }, "Dev Studio (backend) started");
