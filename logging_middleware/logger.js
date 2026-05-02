const axios = require('axios');
const { getToken } = require('./tokenStore');
const cfg = require('../config');

const VALID_STACKS = ['backend', 'frontend'];
const VALID_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'];
const VALID_BACKEND_PKGS = [
  'cache', 'controller', 'cron_job', 'db', 'domain', 'handler',
  'repository', 'route', 'service', 'auth', 'config', 'middleware', 'utils'
];
const VALID_FRONTEND_PKGS = [
  'api', 'component', 'hook', 'page', 'state', 'style',
  'cache', 'controller', 'cron_job', 'db', 'domain', 'handler',
  'repository', 'route', 'service', 'auth', 'config', 'middleware', 'utils'
];

async function Log(stack, level, pkg, message) {
  if (!VALID_STACKS.includes(stack)) {
    throw new Error(`invalid log param: stack="${stack}", expected one of ${VALID_STACKS.join(', ')}`);
  }
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`invalid log param: level="${level}", expected one of ${VALID_LEVELS.join(', ')}`);
  }

  const validPkgs = stack === 'backend' ? VALID_BACKEND_PKGS : VALID_FRONTEND_PKGS;
  if (!validPkgs.includes(pkg)) {
    throw new Error(`invalid log param: package="${pkg}" not valid for stack="${stack}"`);
  }

  if (typeof message !== 'string' || message.length === 0) {
    throw new Error(`invalid log param: message must be a non-empty string`);
  }

  const token = await getToken();

  const logRes = await axios.post(
    `${cfg.base}/logs`,
    {
      stack,
      level,
      package: pkg,
      message
    },
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  return logRes.data.logID;
}

module.exports = { Log };
