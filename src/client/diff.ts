export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/**
 * 行级 diff（LCS）。用于保存冲突时对比「对方已保存的版本」和「我未保存的文本」：
 * del 行为对方版本有而我的文本没有，add 行反之。
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const left = a.split('\n');
  const right = b.split('\n');
  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({length: n + 1}, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      out.push({type: 'same', text: left[i]});
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({type: 'del', text: left[i]});
      i++;
    } else {
      out.push({type: 'add', text: right[j]});
      j++;
    }
  }
  while (i < n) out.push({type: 'del', text: left[i++]});
  while (j < m) out.push({type: 'add', text: right[j++]});
  return out;
}
