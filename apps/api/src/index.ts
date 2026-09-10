import { createApp } from './app';
import { env } from './env';
import { log } from './log';

createApp().listen(env.port);

log('api.started', { port: env.port, seatHoldMinutes: env.seatHoldMinutes });
