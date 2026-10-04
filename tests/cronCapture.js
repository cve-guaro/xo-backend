/** Capture the real ghost-cleanup callback from cron.js for tests. */
const nodeCron = require('node-cron');
const origSchedule = nodeCron.schedule.bind(nodeCron);
let ghostCallback = null;
nodeCron.schedule = (pattern, fn, opts) => {
  if (!ghostCallback && pattern === '*/10 * * * *') ghostCallback = fn;
  return origSchedule(pattern, fn, opts);
};
require('../src/cron').initCron();

module.exports = { getGhostCallback: () => ghostCallback };
