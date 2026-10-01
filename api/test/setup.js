// setup.js: runs inside every test file, before it.
//
// Emails are sent in the background (services/mail.js), so a test can finish while an order
// email is still being recorded. Each test file ends with pool.end(); make that wait for
// those jobs first, or they would hit a closed pool and log errors that look like bugs.
import { pool } from '../src/db/client.js';
import { mailSettled } from '../src/services/mail.js';

const end = pool.end.bind(pool);
pool.end = async () => { await mailSettled(); return end(); };
