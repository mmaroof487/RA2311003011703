const axios = require('axios');
const { Log } = require('../logging_middleware/logger');
const cfg = require('../config');

async function fetchDepots(token) {
  const res = await axios.get(`${cfg.base}/depots`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data.depots;
}

async function fetchVehicles(token) {
  const res = await axios.get(`${cfg.base}/vehicles`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data.vehicles;
}

function knapsack(tasks, budget) {
  const n = tasks.length;
  const dp = Array(n + 1).fill(null).map(() => Array(budget + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    const task = tasks[i - 1];
    const duration = task.Duration;
    const impact = task.Impact;

    // bad data in the API response — skip this task, don't let it corrupt the table
    if (!task.TaskID || typeof duration !== 'number' || duration <= 0
        || typeof impact !== 'number' || impact < 0) {
      Log('backend', 'warn', 'handler', `Task skipped: invalid data (idx ${i - 1})`).catch(() => {});
      for (let w = 0; w <= budget; w++) dp[i][w] = dp[i - 1][w];
      continue;
    }

    if (duration > budget) {
      Log('backend', 'warn', 'handler', `Task ${task.TaskID}: duration>budget`).catch(() => {});
    }

    for (let w = 0; w <= budget; w++) {
      if (duration <= w) {
        dp[i][w] = Math.max(dp[i - 1][w], dp[i - 1][w - duration] + impact);
      } else {
        dp[i][w] = dp[i - 1][w];
      }
    }
  }

  let picked = [];
  let row = n;
  let col = budget;
  while (row > 0) {
    if (col >= 0 && dp[row][col] !== dp[row - 1][col]) {
      const task = tasks[row - 1];
      picked.push(task.TaskID);
      col -= task.Duration;
    }
    row--;
  }

  const totalDuration = picked.reduce((sum, taskID) => {
    const task = tasks.find(t => t.TaskID === taskID);
    return sum + task.Duration;
  }, 0);

  const totalImpact = dp[n][budget];

  return { selected: picked, totalDuration, totalImpact };
}

async function runForAllDepots(token) {
  try {
    await Log('backend', 'info', 'service', 'running knapsack for all depots');

    const depots = await fetchDepots(token);
    const vehicles = await fetchVehicles(token);

    const results = depots.map((depot, depotIndex) => {
      const result = knapsack(vehicles, depot.MechanicHours);
      const outcome = {
        depotIndex,
        budget: depot.MechanicHours,
        selected: result.selected,
        totalDuration: result.totalDuration,
        totalImpact: result.totalImpact
      };
      Log('backend', 'info', 'service', `Depot ${depotIndex}: impact ${result.totalImpact}`).catch(() => {});
      return outcome;
    });

    return results;
  } catch (err) {
    await Log('backend', 'error', 'handler', `knapsack failed: ${err.message.slice(0, 28)}`);
    throw err;
  }
}

module.exports = { fetchDepots, fetchVehicles, knapsack, runForAllDepots };
