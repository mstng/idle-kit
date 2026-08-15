// 巨大数（仮数＋指数）のテスト。
// ここが壊れるとゲーム全体の数字が狂うので、境界と桁あふれを重点的に確認する。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Big,
  ZERO,
  ONE,
  big,
  add,
  sub,
  mul,
  div,
  cmp,
  gte,
  lt,
  log10,
  pow,
  pow10,
  sqrt,
  floor,
  ceil,
  toNumber,
  toJSON,
  isValid,
} from '../src/bignum.js';

/** 浮動小数の誤差を許して比較する（有効数字12桁ぶん一致すればよしとする） */
function assertClose(actual, expected, message) {
  const a = toNumber(actual);
  assert.ok(
    Math.abs(a - expected) <= Math.abs(expected) * 1e-12 + 1e-12,
    message ?? `期待値 ${expected} に対して ${a}`,
  );
}

test('生成すると仮数は 1〜10 の範囲に正規化される', () => {
  assert.deepEqual({ ...big(1234) }, { m: 1.234, e: 3 });
  assert.deepEqual({ ...big(0.05) }, { m: 5, e: -2 });
  assert.deepEqual({ ...big(0) }, { m: 0, e: 0 });
  assert.deepEqual({ ...big(-300) }, { m: -3, e: 2 });
});

test('10のべき乗ちょうどでも桁がずれない', () => {
  // log10 の丸め誤差で 999.99… や 10.0 になりやすい境界
  for (const exponent of [0, 1, 3, 15, 23, 100]) {
    const value = pow10(exponent);
    assert.equal(value.m, 1, `10^${exponent} の仮数がずれた`);
    assert.equal(value.e, exponent, `10^${exponent} の指数がずれた`);
  }
});

test('壊れた値（NaN・Infinity）はゼロとして扱い、伝播させない', () => {
  assert.deepEqual({ ...big(NaN) }, { ...ZERO });
  assert.deepEqual({ ...big(Infinity) }, { ...ZERO });
  assert.deepEqual({ ...big(undefined) }, { ...ZERO });
  assert.deepEqual({ ...big(null) }, { ...ZERO });
});

test('生成した値は書き換えられない', () => {
  const value = big(100);
  assert.throws(() => {
    'use strict';
    value.m = 999;
  });
});

test('足し算・引き算', () => {
  assertClose(add(big(1500), big(500)), 2000);
  assertClose(sub(big(1000), big(250)), 750);
  assertClose(add(big(0.1), big(0.2)), 0.3);
  assertClose(add(ZERO, big(42)), 42);
  assertClose(sub(big(5), big(5)), 0);
});

test('桁が離れすぎている足し算は、大きいほうがそのまま返る', () => {
  // 1e100 に 1 を足しても有効数字16桁には現れない。ここで無理に計算しないのが精度の守り方
  const huge = pow10(100);
  const result = add(huge, ONE);

  assert.equal(result.m, huge.m);
  assert.equal(result.e, huge.e);
});

test('掛け算・割り算', () => {
  assertClose(mul(big(300), big(400)), 120_000);
  assertClose(div(big(1000), big(8)), 125);
  assert.deepEqual({ ...mul(big(12345), ZERO) }, { ...ZERO });
  assert.throws(() => div(big(1), ZERO), /0で割ろう/);
});

test('Number が壊れる領域でも計算が続けられる', () => {
  // ここが今回の対応の本題。Number なら 1e308 を超えた時点で Infinity になる
  assert.equal(1e308 * 100, Infinity, '素の Number は壊れることの確認');

  const huge = mul(pow10(308), big(100)); // 1e310
  assert.equal(huge.e, 310);

  const enormous = pow(2, 5_000); // 2^5000 ≒ 1.4e1505
  assert.ok(enormous.e > 1_500);
  assert.ok(Number.isFinite(enormous.m), '仮数は壊れていない');

  const doubled = mul(enormous, enormous);
  assert.ok(doubled.e > 3_000, '掛け合わせてもまだ伸びる');
});

test('大小比較', () => {
  assert.equal(cmp(big(100), big(200)), -1);
  assert.equal(cmp(big(200), big(100)), 1);
  assert.equal(cmp(big(100), big(100)), 0);
  assert.equal(cmp(pow10(50), pow10(49)), 1, '指数の大きいほうが大きい');
  assert.equal(cmp(ZERO, big(1)), -1);
  assert.equal(cmp(ZERO, big(-1)), 1);
  assert.equal(cmp(big(-5), big(-3)), -1, '負の数は大小が逆転する');
  assert.equal(cmp(ZERO, ZERO), 0);

  assert.ok(gte(big(10), big(10)));
  assert.ok(lt(big(9.99), big(10)));
});

test('べき乗は指数がどれだけ大きくても計算できる', () => {
  assertClose(pow(1.15, 0), 1, '指数0はちょうど1');
  assertClose(pow(2, 10), 1024);
  assertClose(pow(10, 3), 1000);

  // Number で表せる範囲は誤差なしで返す。
  // ここがずれると、切り上げたコストが 50 ではなく 51 になるといった破綻が起きる
  assert.equal(toNumber(pow(5, 2)), 25);
  assert.equal(toNumber(pow(4, 3)), 64);
  assert.equal(toNumber(ceil(mul(big(2), pow(5, 2)))), 50);

  const far = pow(1.15, 10_000); // 素の Number では即 Infinity になる領域
  assert.ok(far.e > 600);
  assert.ok(Number.isFinite(far.m));
});

test('平方根（指数が偶数でも奇数でも合う）', () => {
  assertClose(sqrt(big(10_000)), 100); // e=4（偶数）
  assertClose(sqrt(big(1000)), Math.sqrt(1000)); // e=3（奇数）
  assertClose(sqrt(big(0.01)), 0.1); // e が負
  assert.deepEqual({ ...sqrt(ZERO) }, { ...ZERO });
  assert.throws(() => sqrt(big(-4)), /負の数/);

  const huge = sqrt(pow10(400));
  assert.equal(huge.e, 200, '大きい数でも半分の桁になる');
});

test('切り捨て・切り上げ', () => {
  assertClose(floor(big(12.9)), 12);
  assertClose(ceil(big(12.1)), 13);
  assertClose(ceil(big(11.5)), 12);

  // 整数の精度を超えた大きさは、そのまま整数として扱う（丸めようがない）
  const huge = pow10(30);
  assert.deepEqual({ ...floor(huge) }, { ...huge });
  assert.deepEqual({ ...ceil(huge) }, { ...huge });
});

test('対数で桁数がわかる', () => {
  assert.equal(Math.round(log10(big(1000))), 3);
  assert.equal(Math.round(log10(pow10(250))), 250);
  assert.throws(() => log10(ZERO), /0以下/);
});

test('JSONに保存して読み戻せる', () => {
  const value = pow(1.15, 3_000);
  const restored = big(JSON.parse(JSON.stringify(toJSON(value))));

  assert.equal(restored.m, value.m);
  assert.equal(restored.e, value.e);
});

test('Bigをそのままstringifyしても{m,e}になる', () => {
  const parsed = JSON.parse(JSON.stringify(big(1234)));
  assert.deepEqual(parsed, { m: 1.234, e: 3 });
  assert.ok(big(parsed) instanceof Big);
});

test('セーブデータの検証', () => {
  assert.equal(isValid({ m: 1.5, e: 20 }), true);
  assert.equal(isValid({ m: NaN, e: 20 }), false);
  assert.equal(isValid({ m: 1.5 }), false);
  assert.equal(isValid(42), false);
  assert.equal(isValid(null), false);
});
