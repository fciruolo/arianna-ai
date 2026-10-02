// The fake server as a process, for the watchdog tests: node fake-server-main.ts <port>
import { startFakeServer } from './fake-server.ts';

await startFakeServer(Number(process.argv[2]));
