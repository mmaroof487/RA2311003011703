const { Log } = require('../logging_middleware/logger');

const typeWeight = { Placement: 3, Result: 2, Event: 1 };

class MinHeap {
  constructor() { this.heap = []; }
  push(item) { this.heap.push(item); this._bubbleUp(this.heap.length - 1); }
  pop() {
    if (this.heap.length === 0) return null;
    if (this.heap.length === 1) return this.heap.pop();
    const min = this.heap[0];
    this.heap[0] = this.heap.pop();
    this._sinkDown(0);
    return min;
  }
  peek() { return this.heap[0] || null; }
  size() { return this.heap.length; }
  _bubbleUp(idx) {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this.heap[idx].score < this.heap[parent].score) {
        [this.heap[idx], this.heap[parent]] = [this.heap[parent], this.heap[idx]];
        idx = parent;
      } else break;
    }
  }
  _sinkDown(idx) {
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < this.heap.length && this.heap[left].score < this.heap[smallest].score) smallest = left;
      if (right < this.heap.length && this.heap[right].score < this.heap[smallest].score) smallest = right;
      if (smallest !== idx) {
        [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
        idx = smallest;
      } else break;
    }
  }
}

// Scoring: score = typeWeight + recencyBonus
// typeWeight gap between tiers is 1 (Placement=3, Result=2, Event=1).
// recencyBonus is capped at 0.99 (never >= 1), so a lower-priority type
// can NEVER outscore a higher-priority type regardless of recency.
function scoreNotification(notif) {
  const base = typeWeight[notif.Type] || 1;
  const ts = notif.Timestamp.replace(' ', 'T');
  const hoursElapsed = (Date.now() - new Date(ts).getTime()) / 3600000;
  const recencyBonus = 1 / (1 + hoursElapsed + 0.01); // range: (0, ~0.99]
  return base + recencyBonus;
}

async function getTopN(notifications, n) {
  const heap = new MinHeap();
  for (const notif of notifications) {
    heap.push({ ...notif, score: scoreNotification(notif) });
    if (heap.size() > n) heap.pop();
  }
  const result = [];
  while (heap.size() > 0) result.unshift(heap.pop());
  await Log('backend', 'debug', 'service', `getTopN: ${notifications.length} scored`);
  return result.sort((a, b) => b.score - a.score);
}

module.exports = { MinHeap, getTopN };
