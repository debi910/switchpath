// Optimal scan trees for single-switch access.
//
// With timed scanning, the highlight steps through a list of choices and the
// user presses the switch when the one they want lights up; picking the t-th
// choice costs t steps. A choice can be a group, which opens its own list.
// Given how likely each element is to be the one the user wants, this finds
// the grouping that minimizes the expected number of steps (a Huffman-style
// code with unequal letter costs, solved exactly by dynamic programming over
// contiguous runs of an ordering).
//
//   order: 'fast'     elements sorted by probability: fewest steps
//          'coherent' elements kept in reading order, so every group is one
//                     contiguous region of the page: easier to follow
//
// Works in the browser (global `SwitchPath`) and in Node (module.exports).

(function (root) {
  const MAX_ITEMS = 400;

  function buildTree(probs, { order = 'fast', readingOrder = null, maxItems = MAX_ITEMS } = {}) {
    const n0 = probs.length;
    if (!n0) return null;
    let idx = readingOrder ? [...readingOrder] : [...Array(n0).keys()];
    if (order === 'fast') idx.sort((a, b) => probs[b] - probs[a]);
    if (idx.length > maxItems) idx = idx.slice(0, maxItems);
    const n = idx.length;
    const total = idx.reduce((s, i) => s + probs[i], 0) || 1;
    // Floor keeps zero-probability items reachable in a sensible place.
    const p = idx.map((i) => Math.max(probs[i] / total, 1e-6));
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + p[i];

    // G[i][j]: expected cost of scanning items i..j as one list.
    // K[i][j]: end of the first child (a leaf if K == i, else a group i..K).
    const G = new Float64Array(n * n);
    const K = new Int32Array(n * n);
    for (let len = 1; len <= n; len++) {
      for (let i = 0; i + len - 1 < n; i++) {
        const j = i + len - 1;
        const P = cum[j + 1] - cum[i];
        if (len === 1) {
          G[i * n + j] = P;
          K[i * n + j] = i;
          continue;
        }
        let best = Infinity;
        let bestK = i;
        for (let k = i; k < j; k++) {
          const v = P + (k > i ? G[i * n + k] : 0) + G[(k + 1) * n + j];
          if (v < best) {
            best = v;
            bestK = k;
          }
        }
        G[i * n + j] = best;
        K[i * n + j] = bestK;
      }
    }

    function listOf(i, j) {
      const out = [];
      while (i <= j) {
        const k = i === j ? i : K[i * n + j];
        out.push(k === i ? { item: idx[i] } : { children: listOf(i, k) });
        i = k + 1;
      }
      return out;
    }
    return { children: listOf(0, n - 1), expected: G[n - 1], items: idx };
  }

  // Steps the user needs to reach `item`: the sum of its positions on the
  // path down the tree. Infinity if the item is not in the tree.
  function stepsTo(tree, item) {
    function walk(node) {
      for (let t = 0; t < node.children.length; t++) {
        const c = node.children[t];
        if (c.item === item) return t + 1;
        if (c.children) {
          const s = walk(c);
          if (s !== null) return t + 1 + s;
        }
      }
      return null;
    }
    const s = tree ? walk(tree) : null;
    return s === null ? Infinity : s;
  }

  function leaves(node, out = []) {
    for (const c of node.children) c.children ? leaves(c, out) : out.push(c.item);
    return out;
  }

  // Baselines used by today's switch tools.
  // Linear item scanning in reading order (iOS/macOS item mode).
  function linearSteps(readingOrder, item) {
    const t = readingOrder.indexOf(item);
    return t < 0 ? Infinity : t + 1;
  }

  // Row-column scanning: rows of elements that share a line on screen, then
  // the elements within the row.
  function rowsOf(boxes, readingOrder) {
    const rows = [];
    for (const i of readingOrder) {
      const b = boxes[i];
      const row = b && rows.find((r) => r.box && overlapY(r.box, b) > 0.5 * Math.min(r.box[3], b[3]));
      if (row) {
        row.items.push(i);
        row.box = union(row.box, b);
      } else rows.push({ items: [i], box: b ? [...b] : null });
    }
    for (const r of rows) r.items.sort((a, b) => (boxes[a] ? boxes[a][0] : 0) - (boxes[b] ? boxes[b][0] : 0));
    return rows.map((r) => r.items);
  }

  function rowColumnSteps(rows, item) {
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].indexOf(item);
      if (c >= 0) return rows[r].length === 1 ? r + 1 : r + 1 + c + 1;
    }
    return Infinity;
  }

  function overlapY(a, b) {
    return Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  }

  function union(a, b) {
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
  }

  // Reading order: top to bottom, then left to right, by box.
  function readingOrderOf(boxes) {
    return [...boxes.keys()].sort((a, b) => {
      const A = boxes[a];
      const B = boxes[b];
      if (!A || !B) return (A ? 0 : 1) - (B ? 0 : 1) || a - b;
      if (Math.abs(A[1] - B[1]) > Math.min(A[3], B[3]) / 2) return A[1] - B[1];
      return A[0] - B[0];
    });
  }

  const api = { buildTree, stepsTo, leaves, linearSteps, rowsOf, rowColumnSteps, readingOrderOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SwitchPath = Object.assign(root.SwitchPath || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
