// シミュレータのテスト。
// 数値そのものはバランス調整で変わるので、ここでは「道具として壊れていないか」を見る。
import test from 'node:test';
import assert from 'node:assert/strict';

import { toNumber, gt } from '../src/bignum.js';
import { simulate } from '../tools/simulate.js';

/** テストが遅くならないよう、短い時間で回す */
const SHORT = { hours: 3 };

test('同じ設定なら必ず同じ結果になる', () => {
  // 乱数を種から作っているので、実行するたびに結果が変わることはない。
  // ここがぶれると、定数をいじった効果なのか運なのか区別できなくなる
  const a = simulate(SHORT);
  const b = simulate(SHORT);

  assert.equal(a.summary.prestigeCount, b.summary.prestigeCount);
  assert.equal(toNumber(a.summary.lifetimeEarned), toNumber(b.summary.lifetimeEarned));
  assert.deepEqual(a.milestones.firstRunStages, b.milestones.firstRunStages);
});

test('プレイが前に進んでいる', () => {
  const { state, summary, milestones } = simulate(SHORT);

  assert.ok(toNumber(summary.lifetimeEarned) > 0, 'ひかりが増えていない');
  assert.ok(toNumber(summary.finalRate) > 0, '生産量がゼロのまま');
  assert.ok(state.levels.sun > 0, 'アップグレードを買っていない');
  assert.ok(milestones.firstPrestige !== null, '3時間あっても転生に届いていない');
});

test('育成段階の到達時刻が順番どおりに並ぶ', () => {
  const { milestones } = simulate(SHORT);
  const times = Object.values(milestones.firstRunStages);

  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1], '後の段階のほうが早く到達している');
  }
});

test('長く回すほど進む', () => {
  const short = simulate({ hours: 2 });
  const long = simulate({ hours: 6 });

  assert.ok(
    gt(long.summary.lifetimeEarned, short.summary.lifetimeEarned),
    '時間を延ばしても進んでいない',
  );
  assert.ok(long.summary.prestigeCount >= short.summary.prestigeCount);
});

test('はっぱを取らない設定にすると進みが遅くなる', () => {
  // 設定を変えた効果が数字に出ることの確認。これが効かないと調整の道具にならない
  const withLeaves = simulate({ ...SHORT, collectLeaves: true });
  const without = simulate({ ...SHORT, collectLeaves: false });

  assert.ok(withLeaves.summary.leavesCollected > 0);
  assert.equal(without.summary.leavesCollected, 0);
  assert.ok(
    gt(withLeaves.summary.lifetimeEarned, without.summary.lifetimeEarned),
    'はっぱの有無が結果に出ていない',
  );
});

test('刻み幅を変えても結果が大きくは変わらない', () => {
  // 刻みが粗すぎると計算が破綻していないか（実時間ベースになっているか）の確認
  const fine = simulate({ hours: 2, stepMs: 5_000 });
  const coarse = simulate({ hours: 2, stepMs: 20_000 });

  const ratio = toNumber(coarse.summary.lifetimeEarned) / toNumber(fine.summary.lifetimeEarned);
  assert.ok(ratio > 0.2 && ratio < 5, `刻み幅で結果が変わりすぎている（${ratio}倍）`);
});
