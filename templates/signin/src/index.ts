import { createApp } from './app.ts';
import { mailerFromEnv } from './mail.ts';

/** The Worker entry. Everything testable lives in createApp. */
export default createApp({ mailer: mailerFromEnv });
