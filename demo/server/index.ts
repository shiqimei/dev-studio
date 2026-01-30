import { startServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "5689", 10);
const server = startServer(PORT);

console.log(`\n  Claude Code ACP Demo (backend)`);
console.log(`  http://localhost:${server.port}\n`);
