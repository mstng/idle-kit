// 放置ゲーで避けて通れない「数値のインフレ」への対処。
//
// JavaScript の Number は約 1e308 を超えた瞬間 Infinity になり、そこから先は
// 足しても掛けても Infinity のまま。放置ゲーは指数的に伸びるので、転生を重ねると
// 必ずここに到達してゲームが壊れる。
//
// そこで「m × 10^e」の形（仮数と指数）で数を持つ。指数側は Number なので、
// 実質 10^(1.7e308) まで扱えて上限を気にしなくてよくなる。
// 代わりに精度は有効数字16桁ぶんしか保たれないが、放置ゲーでは十分
// （1兆の山に1を足した結果が正確である必要はない）。

/** 仮数の有効桁数。これ以上ちいさい値を足しても結果は変わらない */
const PRECISION_DIGITS = 16;

/** 整数として正確に扱える桁数の上限（Number.MAX_SAFE_INTEGER は約9e15） */
const SAFE_INTEGER_DIGITS = 15;

/** 丸める前に信用する有効桁数。これより下の桁は浮動小数の誤差とみなして落とす */
const TRUSTED_DIGITS = 15;

/**
 * m × 10^e を表す。m は 1 <= |m| < 10 に正規化される（0 のときだけ m=0, e=0）。
 * 生成後は変更しない（イミュータブル）。計算はすべて新しい Big を返す。
 */
export class Big {
  constructor(m, e) {
    this.m = m;
    this.e = e;
    Object.freeze(this); // うっかり書き換えるバグを型レベルで防ぐ
  }
}

export const ZERO = new Big(0, 0);
export const ONE = new Big(1, 0);

/**
 * 仮数を 1 <= |m| < 10 の範囲に収め直す。すべての演算の出口でこれを通す。
 * 桁ずらしを while ループでやると桁が大きいとき遅くなるので、log10 で一発で求める。
 */
function normalize(m, e) {
  // 壊れた値（NaN / Infinity）が入ってきたら 0 として扱い、伝播させない
  if (!Number.isFinite(m) || !Number.isFinite(e)) return ZERO;
  if (m === 0) return ZERO;

  const shift = Math.floor(Math.log10(Math.abs(m)));
  let nextM = m / 10 ** shift;
  let nextE = e + shift;

  // log10 の丸め誤差で境界をまたぐことがあるので1段だけ補正する
  if (Math.abs(nextM) >= 10) {
    nextM /= 10;
    nextE += 1;
  } else if (Math.abs(nextM) < 1) {
    nextM *= 10;
    nextE -= 1;
  }

  return new Big(nextM, nextE);
}

/** number / セーブから読んだ {m,e} / Big のいずれからでも Big をつくる */
export function big(value) {
  if (value instanceof Big) return value;
  if (typeof value === 'number') return normalize(value, 0);
  if (value !== null && typeof value === 'object' && 'm' in value && 'e' in value) {
    return normalize(Number(value.m), Number(value.e));
  }
  return ZERO;
}

/** 10^exponent。exponent は小数でもよい */
export function pow10(exponent) {
  if (!Number.isFinite(exponent)) return ZERO;
  const whole = Math.floor(exponent);
  return normalize(10 ** (exponent - whole), whole);
}

export function neg(a) {
  const x = big(a);
  return x.m === 0 ? ZERO : new Big(-x.m, x.e);
}

export function add(a, b) {
  const x = big(a);
  const y = big(b);
  if (x.m === 0) return y;
  if (y.m === 0) return x;

  // 指数の大きいほうに合わせる
  const [large, small] = x.e >= y.e ? [x, y] : [y, x];
  const gap = large.e - small.e;

  // 桁が離れすぎている＝足しても仮数の精度に現れないので、大きいほうをそのまま返す
  if (gap > PRECISION_DIGITS) return large;

  return normalize(large.m + small.m / 10 ** gap, large.e);
}

export function sub(a, b) {
  return add(a, neg(b));
}

export function mul(a, b) {
  const x = big(a);
  const y = big(b);
  if (x.m === 0 || y.m === 0) return ZERO;
  return normalize(x.m * y.m, x.e + y.e);
}

export function div(a, b) {
  const x = big(a);
  const y = big(b);
  if (y.m === 0) throw new Error('0で割ろうとしました');
  if (x.m === 0) return ZERO;
  return normalize(x.m / y.m, x.e - y.e);
}

/** a < b なら -1、a > b なら 1、等しければ 0 */
export function cmp(a, b) {
  const x = big(a);
  const y = big(b);

  const signX = Math.sign(x.m);
  const signY = Math.sign(y.m);
  if (signX !== signY) return signX < signY ? -1 : 1;
  if (signX === 0) return 0; // 両方ゼロ

  // 同符号なら指数の大小で決まる。ただし負の数どうしは大小が逆になる
  if (x.e !== y.e) return (x.e < y.e ? -1 : 1) * signX;
  if (x.m !== y.m) return x.m < y.m ? -1 : 1;
  return 0;
}

export const gte = (a, b) => cmp(a, b) >= 0;
export const gt = (a, b) => cmp(a, b) > 0;
export const lt = (a, b) => cmp(a, b) < 0;
export const eq = (a, b) => cmp(a, b) === 0;
export const max = (a, b) => (gte(a, b) ? big(a) : big(b));
export const min = (a, b) => (lt(a, b) ? big(a) : big(b));

/** 常用対数。桁数を知りたいときに使う（表示や成長曲線の計算で便利） */
export function log10(a) {
  const x = big(a);
  if (x.m <= 0) throw new Error('0以下の対数は求められません');
  return x.e + Math.log10(x.m);
}

/** base^exponent。base と exponent はふつうの number */
export function pow(base, exponent) {
  if (exponent === 0) return ONE;
  if (base === 0) return ZERO;

  // Number で正確に扱える範囲なら、そのまま計算する。
  // log10 を経由すると 5^2 が 25.000000000000004 のようにわずかにずれ、
  // 切り上げたコストが 50 ではなく 51 になる、といった見た目の破綻を招くため。
  const direct = base ** exponent;
  if (Number.isFinite(direct) && Math.abs(direct) < Number.MAX_SAFE_INTEGER) {
    return big(direct);
  }

  // ここから先は Number では表せない領域。10^(log10(base) × exponent) に置き換える
  return pow10(Math.log10(base) * exponent);
}

export function sqrt(a) {
  const x = big(a);
  if (x.m === 0) return ZERO;
  if (x.m < 0) throw new Error('負の数の平方根は求められません');

  // 指数が奇数だと半分にできないので、仮数側に1桁借りてから割る
  const even = x.e % 2 === 0;
  return even
    ? normalize(Math.sqrt(x.m), x.e / 2)
    : normalize(Math.sqrt(x.m * 10), (x.e - 1) / 2);
}

/** Number に戻す。大きすぎる場合は Infinity になるので、表示や小さい値の比較にだけ使う */
export function toNumber(a) {
  const x = big(a);
  return x.m * 10 ** x.e;
}

/** 整数の粒度を超えている（=すでに整数とみなせる）大きさかどうか */
function beyondIntegerPrecision(x) {
  return x.e >= SAFE_INTEGER_DIGITS;
}

/**
 * Number に戻すときに復活する誤差を落とす。
 * 例えば 1.92×10^2 は Number にすると 192.00000000000003 になり、
 * そのまま切り上げると 193 になってしまう（コスト表示が1ずれる）。
 * 信用できる桁の外側を先に丸めてから整数化する。
 */
function toRoundedNumber(x) {
  const value = toNumber(x);
  if (!Number.isFinite(value)) return value;
  return Number(value.toPrecision(TRUSTED_DIGITS));
}

export function floor(a) {
  const x = big(a);
  if (beyondIntegerPrecision(x)) return x;
  return big(Math.floor(toRoundedNumber(x)));
}

export function ceil(a) {
  const x = big(a);
  if (beyondIntegerPrecision(x)) return x;
  return big(Math.ceil(toRoundedNumber(x)));
}

/** セーブ用の素のオブジェクト。JSON.stringify は Big をそのまま {m,e} にしてくれる */
export function toJSON(a) {
  const x = big(a);
  return { m: x.m, e: x.e };
}

/** 有限で、期待どおり {m,e} の形をしているか（セーブデータの検証用） */
export function isValid(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isFinite(Number(value.m)) &&
    Number.isFinite(Number(value.e))
  );
}
