import { mailerFromEnv } from '../../../templates/signin/src/mail.ts';
import { createLiveApp } from './live-app.ts';

/** The Worker entry wrangler deploys (deploy.ts writes the config). */
export default createLiveApp({ mailer: (env) => mailerFromEnv(env) });
