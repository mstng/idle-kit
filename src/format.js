// 数値と時間の表示整形。DOM を触らないので、画面からもコマンドラインの道具からも使える。

import { big, div, pow10, toNumber } from './bignum.js';

/** 日本語の桁の単位。これを超えたら指数表記に切り替える */
const JA_UNITS = [
  { exponent: 20, suffix: '垓' },
  { exponent: 16, suffix: '京' },
  { exponent: 12, suffix: '兆' },
  { exponent: 8, suffix: '億' },
  { exponent: 4, suffix: '万' },
];

/** 垓を超えたら「1.23×10^30」形式にする */
const SCIENTIFIC_FROM_EXPONENT = 24;

/**
 * 巨大数を読みやすい文字列にする。
 * 桁が増えるほど情報を粗くしていく（1.8万 → 3.2京 → 1.23×10^45）。
 * 放置ゲーでは正確な桁より「どのくらいの規模か」が伝わることが大事。
 */
export function formatNumber(value) {
  const amount = big(value);
  if (amount.m === 0) return '0';
  if (amount.m < 0) return `-${formatNumber({ m: -amount.m, e: amount.e })}`;

  if (amount.e >= SCIENTIFIC_FROM_EXPONENT) {
    return `${amount.m.toFixed(2)}×10^${amount.e}`;
  }

  for (const unit of JA_UNITS) {
    if (amount.e >= unit.exponent) {
      const scaled = toNumber(div(amount, pow10(unit.exponent)));
      return `${scaled.toFixed(1)}${unit.suffix}`;
    }
  }

  const plain = toNumber(amount);
  // 小さいうちは小数第1位まで見せて「増えている感」を出す
  return plain < 100 ? plain.toFixed(1) : Math.floor(plain).toLocaleString('ja-JP');
}

/** 個数など、小数にならない値の表記。ひかり（連続値）とは書式を分ける */
export function formatCount(value) {
  const amount = big(value);
  if (amount.m === 0) return '0';
  if (amount.e >= 15) return formatNumber(amount); // 数えられる範囲を超えたら通常表記に任せる
  return Math.floor(toNumber(amount)).toLocaleString('ja-JP');
}

/** ミリ秒を「2時間30分」のような表記にする */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}日${hours}時間`;
  if (hours > 0) return `${hours}時間${minutes}分`;
  if (minutes > 0) return `${minutes}分`;
  return `${Math.floor(ms / 1000)}秒`;
}
