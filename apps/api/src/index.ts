import { config } from 'dotenv';
import { buildApp } from './server.js';

config({ quiet: true });

const port = Number(process.env.PORT || '3001');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const app = buildApp();
try {
  await app.listen({ host: '127.0.0.1', port });
  console.log('HackAlem API listening on port ' + port);
} catch {
  console.error('HackAlem API could not start');
  process.exitCode = 1;
}
