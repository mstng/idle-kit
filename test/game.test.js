// コアロジックのテスト。Node標準の node:test を使うので追加インストール不要。
// 実行: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import { ZERO, big, toNumber, gte, lt } from '../src/bignum.js';
import {
  SCHEMA_VERSION,
  OFFLINE_CAP_MS,
  BASE_OFFLINE_EFFICIENCY,
  OFFLINE_THRESHOLD_MS,
  BASE_MANUAL_GAIN,
  STAGE_BONUS_PER_LEVEL,
  MEGUMI_DIVISOR,
  MEGUMI_BONUS,
  SPROUT_SUN_PER_LEVEL,
  PALM_MULTIPLIER_PER_LEVEL,
  AUTO_BUY_MAX_PER_TICK,
  ACHIEVEMENTS,
  ACHIEVEMENT_BONUS,
  UPGRADE_UNLOCK_RATIO,
  isAchieved,
  achievementCount,
  achievementMultiplier,
  checkAchievements,
  isUpgradeUnlocked,
  unlockedUpgrades,
  isPrestigeUnlocked,
  isMegumiShopUnlocked,
  UPGRADES,
  MEGUMI_UPGRADES,
  automatedUpgradeIds,
  bestAutoBuy,
  runAutoBuyer,
  isMegumiUpgradeMaxed,
  megumiMultiplier,
  megumiOnPrestige,
  canPrestige,
  lightUntilPrestige,
  prestige,
  migrate,
  createInitialState,
  stageIndex,
  currentStage,
  upgradeCost,
  currentCost,
  megumiUpgradeCost,
  currentMegumiCost,
  buyMegumiUpgrade,
  offlineEfficiency,
  manualGain,
  startingSunLevel,
  productionPerSecond,
  tick,
  advanceTo,
  waterManually,
  buyUpgrade,
  serialize,
  deserialize,
} from '../src/game.js';

/** テスト用の基準時刻（固定値にして、実行するたびに結果が変わらないようにする） */
const T0 = 1_700_000_000_000;

/** Big を数値に戻して比較する（小さい値の検証用） */
const num = (value) => toNumber(value);

/** Big を扱う項目は自動で変換しつつ、指定レベルのアップグレードを持った状態をつくる */
function stateWith(levels, extra = {}) {
  const base = createInitialState(T0);
  const bigFields = ['light', 'totalEarned', 'lifetimeEarned', 'megumi', 'megumiEarned'];
  const converted = Object.fromEntries(
    Object.entries(extra).map(([key, value]) => [
      key,
      bigFields.includes(key) ? big(value) : value,
    ]),
  );
  return { ...base, levels: { ...base.levels, ...levels }, ...converted };
}

test('初期状態は所持量も累計もゼロ', () => {
  const s = createInitialState(T0);
  assert.equal(num(s.light), 0);
  assert.equal(num(s.totalEarned), 0);
  assert.equal(s.lastSeenAt, T0);
  assert.equal(num(productionPerSecond(s)), 0);
});

test('生産量はアップグレードの効果を合計したもの', () => {
  // おひさま(0.1/s)×10 = 1.0/s。段階は「たね」なので倍率は1倍のまま
  const s = stateWith({ sun: 10 });
  assert.equal(num(productionPerSecond(s)), 1);
});

test('育成段階が上がると生産量に倍率がかかる', () => {
  const seed = stateWith({ sun: 10 }); // たね(段階0)
  const sprout = stateWith({ sun: 10 }, { totalEarned: 100 }); // ふたば(段階1)

  assert.equal(stageIndex(sprout), 1);
  assert.equal(
    num(productionPerSecond(sprout)),
    num(productionPerSecond(seed)) * (1 + STAGE_BONUS_PER_LEVEL),
  );
});

test('進化の判定は所持量ではなく累計で行う（買い物しても退化しない）', () => {
  // 累計1000まで稼いだあと、全部使い切って所持量0になった状態
  const s = stateWith({}, { light: 0, totalEarned: 1_000 });
  assert.equal(currentStage(s).name, 'わかぎ');
});

test('tickは経過時間に比例して増える（フレーム数ではなく実時間）', () => {
  const s = stateWith({ sun: 10 }); // 1.0/s
  const { state, gained } = tick(s, 3_000);

  assert.equal(num(gained), 3);
  assert.equal(num(state.light), 3);
  assert.equal(num(state.totalEarned), 3);
});

test('tickは元の状態を書き換えない（純粋関数）', () => {
  const s = stateWith({ sun: 10 });
  tick(s, 5_000);
  assert.equal(num(s.light), 0, '呼び出し元の状態が変化してしまっている');
});

test('経過時間が0や負なら何も起きない', () => {
  const s = stateWith({ sun: 10 });
  assert.equal(num(tick(s, 0).gained), 0);
  assert.equal(num(tick(s, -5_000).gained), 0);
  assert.equal(num(tick(s, NaN).gained), 0);
});

test('短い間隔ならオンライン扱いで効率100%', () => {
  const s = stateWith({ sun: 10 }); // 1.0/s
  const result = advanceTo(s, T0 + 10_000);

  assert.equal(result.offline, false);
  assert.equal(num(result.gained), 10);
  assert.equal(result.state.lastSeenAt, T0 + 10_000);
});

test('しきい値を超えるとオフライン扱いになり効率が落ちる', () => {
  const s = stateWith({ sun: 10 }); // 1.0/s
  const elapsed = OFFLINE_THRESHOLD_MS + 60_000; // 2分ぶん
  const result = advanceTo(s, T0 + elapsed);

  assert.equal(result.offline, true);
  assert.equal(num(result.gained), (elapsed / 1000) * BASE_OFFLINE_EFFICIENCY);
});

test('オフライン進行には上限があり、超過分は捨てられる', () => {
  const s = stateWith({ sun: 10 }); // 1.0/s
  const elapsed = OFFLINE_CAP_MS + 3 * 60 * 60 * 1000; // 上限+3時間放置
  const result = advanceTo(s, T0 + elapsed);

  assert.equal(result.elapsedMs, OFFLINE_CAP_MS);
  assert.equal(result.cappedMs, 3 * 60 * 60 * 1000);
  assert.equal(num(result.gained), (OFFLINE_CAP_MS / 1000) * BASE_OFFLINE_EFFICIENCY);
});

test('端末の時計が巻き戻っても所持量が減らない', () => {
  const s = stateWith({ sun: 10 }, { light: 50, totalEarned: 50 });
  const result = advanceTo(s, T0 - 60_000); // 1分前に巻き戻った

  assert.equal(num(result.gained), 0);
  assert.equal(num(result.state.light), 50);
  assert.equal(result.state.lastSeenAt, T0 - 60_000, '基準時刻は今に合わせ直す');
});

test('購入コストは指数的に増える', () => {
  assert.equal(num(upgradeCost('sun', 0)), 10); // 10 * 1.15^0
  assert.equal(num(upgradeCost('sun', 1)), 12); // 10 * 1.15^1 = 11.5 → 切り上げ
  assert.ok(
    num(upgradeCost('sun', 20)) > num(upgradeCost('sun', 10)) * 2,
    '伸びが線形になっている',
  );
});

test('所持量が足りていればアップグレードを買える', () => {
  const s = stateWith({}, { light: 100 });
  const { state, ok, cost } = buyUpgrade(s, 'sun');

  assert.equal(ok, true);
  assert.equal(num(cost), 10);
  assert.equal(num(state.light), 90);
  assert.equal(state.levels.sun, 1);
  assert.equal(num(currentCost(state, 'sun')), 12, '次の購入コストが上がっている');
});

test('所持量が足りなければ状態は一切変わらない', () => {
  const s = stateWith({}, { light: 5 });
  const { state, ok, reason } = buyUpgrade(s, 'sun');

  assert.equal(ok, false);
  assert.equal(reason, 'poor');
  assert.equal(state, s, '買えなかったのに新しい状態が返っている');
});

test('未知のIDを買おうとしても落ちない', () => {
  const s = stateWith({}, { light: 999_999 });
  assert.equal(buyUpgrade(s, 'nonexistent').ok, false);
});

test('手動の水やりで所持量と累計が増える', () => {
  const s = createInitialState(T0);
  const next = waterManually(s);

  assert.equal(num(next.light), BASE_MANUAL_GAIN);
  assert.equal(num(next.totalEarned), BASE_MANUAL_GAIN);
});

// --- 転生（プレステージ） ---

test('もらえるめぐみは平方根で伸びる（線形ではない）', () => {
  const at = (total) => num(megumiOnPrestige(stateWith({}, { totalEarned: total })));

  assert.equal(at(MEGUMI_DIVISOR - 1), 0, '基準に届かなければ0個');
  assert.equal(at(MEGUMI_DIVISOR), 1);
  assert.equal(at(MEGUMI_DIVISOR * 4), 2, '4倍稼いで、やっと2倍');
  assert.equal(at(MEGUMI_DIVISOR * 9), 3);
  assert.equal(at(MEGUMI_DIVISOR * 100), 10);
});

test('めぐみが1個ももらえないうちは転生できない', () => {
  const s = stateWith({ sun: 5 }, { totalEarned: MEGUMI_DIVISOR - 1, light: 999 });
  assert.equal(canPrestige(s), false);

  const result = prestige(s, T0 + 1_000);
  assert.equal(result.ok, false);
  assert.equal(result.state, s, '転生できないのに状態が変わっている');
});

test('転生の目標額は次の1個ぶんを指す', () => {
  const s = stateWith({}, { totalEarned: MEGUMI_DIVISOR }); // いま1個もらえる
  // 次の2個目に必要なのは 2^2 = 4倍の地点
  assert.equal(num(lightUntilPrestige(s)), MEGUMI_DIVISOR * 4 - MEGUMI_DIVISOR);
});

test('転生すると今回の進行は失われ、めぐみだけが残る', () => {
  const s = stateWith(
    { sun: 30, water: 5 },
    {
      light: 50_000,
      totalEarned: MEGUMI_DIVISOR * 9,
      megumi: 2,
      megumiEarned: 2,
      prestigeCount: 1,
      lifetimeEarned: MEGUMI_DIVISOR * 20,
    },
  );
  const { state, ok, gained } = prestige(s, T0 + 5_000);

  assert.equal(ok, true);
  assert.equal(num(gained), 3);

  // 失われるもの
  assert.equal(num(state.light), 0);
  assert.equal(num(state.totalEarned), 0);
  assert.equal(state.levels.sun, 0);
  assert.equal(state.levels.water, 0);
  assert.equal(currentStage(state).name, 'たね', '木は種に戻る');

  // 残るもの
  assert.equal(num(state.megumi), 5, '2 + 3');
  assert.equal(num(state.megumiEarned), 5);
  assert.equal(state.prestigeCount, 2);
  assert.equal(num(state.lifetimeEarned), MEGUMI_DIVISOR * 20, '全周回の累計は減らない');
  assert.equal(state.lastSeenAt, T0 + 5_000, '時間の基準は転生した瞬間に合わせる');
});

test('めぐみは生産量に永続の倍率をかける', () => {
  const withoutMegumi = stateWith({ sun: 10 }); // 1.0/s
  const withMegumi = stateWith({ sun: 10 }, { megumiEarned: 5 });

  assert.equal(num(megumiMultiplier(withMegumi)), 1 + 5 * MEGUMI_BONUS);
  assert.equal(num(productionPerSecond(withMegumi)), 1 * (1 + 5 * MEGUMI_BONUS));
  assert.ok(
    num(productionPerSecond(withMegumi)) > num(productionPerSecond(withoutMegumi)),
  );
});

test('育成段階の倍率とめぐみの倍率は掛け合わさる', () => {
  // わかぎ(段階2) × めぐみ10
  const s = stateWith({ sun: 10 }, { totalEarned: 1_000, megumiEarned: 10 });
  const expected = 1 * (1 + 2 * STAGE_BONUS_PER_LEVEL) * (1 + 10 * MEGUMI_BONUS);

  assert.equal(num(productionPerSecond(s)), expected);
});

test('転生後は同じ時間でも前より速く育つ', () => {
  const firstRun = stateWith({ sun: 20 });
  const afterPrestige = stateWith({ sun: 20 }, { megumiEarned: 5 });

  const before = num(advanceTo(firstRun, T0 + 10_000).gained);
  const after = num(advanceTo(afterPrestige, T0 + 10_000).gained);

  assert.equal(after, before * 1.5, 'めぐみ5個で1.5倍');
});

test('lifetimeEarnedは転生をまたいで積み上がる', () => {
  let s = stateWith({ sun: 100 }); // 10/s

  s = advanceTo(s, T0 + 20 * 60 * 60 * 1000).state; // オフライン上限まで放置
  const earnedFirstRun = num(s.lifetimeEarned);
  assert.ok(earnedFirstRun > 0);

  const after = prestige(s, T0 + 20 * 60 * 60 * 1000);
  assert.equal(after.ok, true);
  assert.equal(num(after.state.lifetimeEarned), earnedFirstRun, '転生では減らない');

  const later = advanceTo(
    { ...after.state, levels: { ...after.state.levels, sun: 1 } },
    T0 + 21 * 60 * 60 * 1000,
  );
  assert.ok(num(later.state.lifetimeEarned) > earnedFirstRun, '2周目のぶんが上に積まれる');
});

// --- めぐみの使い道（永続アップグレード） ---

test('めぐみアップグレードのコストも指数的に増える', () => {
  assert.equal(num(megumiUpgradeCost('sprout', 0)), 1);
  assert.equal(num(megumiUpgradeCost('sprout', 1)), 4);
  assert.equal(num(megumiUpgradeCost('sprout', 2)), 16);
});

test('めぐみが足りなければ買えず、状態も変わらない', () => {
  const s = stateWith({}, { megumi: 0, megumiEarned: 0 });
  const result = buyMegumiUpgrade(s, 'sleep');

  assert.equal(result.ok, false);
  assert.equal(result.state, s);
});

test('めぐみを使っても生産倍率は下がらない（手持ちと累計を分けているため）', () => {
  const s = stateWith({ sun: 10 }, { megumi: 5, megumiEarned: 5 });
  const before = num(productionPerSecond(s));

  const { state, ok, cost } = buyMegumiUpgrade(s, 'sprout');

  assert.equal(ok, true);
  assert.equal(num(cost), 1);
  assert.equal(num(state.megumi), 4, '手持ちは減る');
  assert.equal(num(state.megumiEarned), 5, '累計は減らない');
  assert.equal(num(productionPerSecond(state)), before, '倍率は据え置き');
});

test('ねむりのちからでオフライン効率が上がる（100%が上限）', () => {
  const base = stateWith({});
  assert.equal(offlineEfficiency(base), BASE_OFFLINE_EFFICIENCY);

  const rested = stateWith({}, { megumiLevels: { sprout: 0, sleep: 3, palm: 0 } });
  assert.equal(offlineEfficiency(rested), 0.8); // 0.5 + 0.1×3

  const maxed = stateWith({}, { megumiLevels: { sprout: 0, sleep: 99, palm: 0 } });
  assert.equal(offlineEfficiency(maxed), 1, '100%を超えない');
});

test('ねむりのちからは実際のオフライン獲得量に効く', () => {
  const elapsed = 60 * 60 * 1000; // 1時間
  const plain = stateWith({ sun: 10 });
  const rested = stateWith({ sun: 10 }, { megumiLevels: { sprout: 0, sleep: 5, palm: 0 } });

  assert.equal(num(advanceTo(plain, T0 + elapsed).gained), 3_600 * 0.5);
  assert.equal(num(advanceTo(rested, T0 + elapsed).gained), 3_600 * 1.0);
});

test('てのひらで手動の獲得量が増える', () => {
  const s = stateWith({}, { megumiLevels: { sprout: 0, sleep: 0, palm: 2 } });

  assert.equal(num(manualGain(s)), BASE_MANUAL_GAIN * PALM_MULTIPLIER_PER_LEVEL ** 2);
  assert.equal(num(waterManually(s).light), 100);
});

test('はじまりのめを買うと、転生後におひさまを持って再開する', () => {
  const s = stateWith(
    {},
    {
      totalEarned: MEGUMI_DIVISOR,
      megumi: 5,
      megumiEarned: 5,
      megumiLevels: { sprout: 2, sleep: 0, palm: 0 },
    },
  );
  assert.equal(startingSunLevel(s), SPROUT_SUN_PER_LEVEL * 2);

  const { state, ok } = prestige(s, T0 + 1_000);

  assert.equal(ok, true);
  assert.equal(state.levels.sun, SPROUT_SUN_PER_LEVEL * 2, 'まっさらではなく途中から始まる');
  assert.ok(num(productionPerSecond(state)) > 0, '転生直後から自動で増える');
});

test('めぐみアップグレードは転生をまたいで残る', () => {
  const s = stateWith(
    {},
    {
      totalEarned: MEGUMI_DIVISOR * 4,
      megumi: 3,
      megumiEarned: 3,
      megumiLevels: { sprout: 1, sleep: 2, palm: 1 },
    },
  );
  const { state } = prestige(s, T0 + 1_000);

  assert.deepEqual(state.megumiLevels, { sprout: 1, sleep: 2, palm: 1 });
  assert.equal(num(currentMegumiCost(state, 'sleep')), 50, '続きのコストから始まる');
});

// --- オートバイヤー ---

/** じどうのて を指定レベル持ち、ひかりを持った状態 */
function autoState(autoLevel, light, levels = {}) {
  return stateWith(levels, {
    light,
    megumiLevels: { sprout: 0, sleep: 0, palm: 0, auto: autoLevel },
  });
}

test('じどうのてを持っていなければ何も買わない', () => {
  const s = autoState(0, 1_000_000);
  const result = runAutoBuyer(s);

  assert.equal(result.purchases, 0);
  assert.equal(result.state, s, '買っていないのに新しい状態が返っている');
  assert.deepEqual(automatedUpgradeIds(s), []);
});

test('レベルのぶんだけ先頭から自動購入の対象になる', () => {
  assert.deepEqual(automatedUpgradeIds(autoState(1, 0)), ['sun']);
  assert.deepEqual(automatedUpgradeIds(autoState(2, 0)), ['sun', 'water']);
  assert.deepEqual(automatedUpgradeIds(autoState(4, 0)), ['sun', 'water', 'soil', 'wind']);
});

test('対象外のアップグレードは、買えるお金があっても買わない', () => {
  const s = autoState(1, 1_000_000); // おひさまだけ自動
  const { state } = runAutoBuyer(s);

  assert.ok(state.levels.sun > 0);
  assert.equal(state.levels.water, 0, '対象外まで買ってしまっている');
  assert.equal(state.levels.soil, 0);
});

test('安い順ではなく、効率のよいほうを選ぶ', () => {
  // おひさま: Lv.0 でコスト10・効果0.1 → 効率 0.01
  // みずやり: Lv.0 でコスト150・効果1.2 → 効率 0.008
  // 一番安いのはおひさまだが、たくさん買ったあとは効率が逆転する
  const early = autoState(2, 200);
  assert.equal(bestAutoBuy(early).id, 'sun', '序盤はおひさまのほうが効率がよい');

  // おひさまを50レベルまで上げると、1レベルあたりの効率がみずやりを下回る
  const late = autoState(2, 1_000_000, { sun: 50 });
  assert.equal(bestAutoBuy(late).id, 'water', '効率が逆転したら乗り換える');
});

test('買えるものがなければ選ばない', () => {
  const broke = autoState(4, 5); // どれも買えない
  assert.equal(bestAutoBuy(broke), null);
  assert.equal(runAutoBuyer(broke).purchases, 0);
});

test('買えなくなるまで買い、所持量は足りている範囲に収まる', () => {
  const s = autoState(1, 1_000);
  const { state, purchases } = runAutoBuyer(s);

  assert.ok(purchases > 0);
  assert.ok(gte(state.light, ZERO), '所持量がマイナスになっている');
  assert.ok(
    lt(state.light, currentCost(state, 'sun')),
    'まだ買えるのに止まっている',
  );
});

test('1回の呼び出しで買う数には上限がある', () => {
  // 上限を超える回数を買えるだけのひかりを持たせる
  const rich = autoState(1, big({ m: 1, e: 12 }));
  const { purchases } = runAutoBuyer(rich);

  assert.equal(purchases, AUTO_BUY_MAX_PER_TICK, '上限で打ち切られていない');

  // 打ち切られた分は次の呼び出しで買われる（取りこぼしにはならない）
  const second = runAutoBuyer(runAutoBuyer(rich).state);
  assert.ok(second.purchases > 0);
});

test('自動購入は元の状態を書き換えない', () => {
  const s = autoState(1, 1_000);
  runAutoBuyer(s);

  assert.equal(num(s.light), 1_000);
  assert.equal(s.levels.sun, 0);
});

test('オフラインから戻ったときも自動購入が働く', () => {
  // 放置でひかりが貯まり、戻った時点で自動購入まで済んでいる状態を期待する
  const s = autoState(1, 0, { sun: 10 });
  const result = advanceTo(s, T0 + 60 * 60 * 1000); // 1時間放置

  assert.equal(result.offline, true);
  assert.ok(result.purchases > 0, '放置中に貯まったひかりが使われていない');
  assert.ok(result.state.levels.sun > 10, 'レベルが上がっている');
});

test('自動購入があっても累計獲得量は減らない（転生の報酬に影響しない）', () => {
  const s = autoState(1, 0, { sun: 10 });
  const result = advanceTo(s, T0 + 60 * 60 * 1000);

  // 買い物で減るのは所持量だけ。累計は稼いだぶんがそのまま残る
  assert.equal(num(result.state.totalEarned), num(result.gained));
  assert.ok(lt(result.state.light, result.state.totalEarned), '買い物で所持量は減っている');
});

// --- 上限のあるめぐみアップグレード ---

test('効果が頭打ちになるものは、それ以上買えない', () => {
  const sleepDef = MEGUMI_UPGRADES.find((u) => u.id === 'sleep');
  const maxed = stateWith(
    {},
    {
      megumi: 1_000_000,
      megumiEarned: 1_000_000,
      megumiLevels: { sprout: 0, sleep: sleepDef.maxLevel, palm: 0, auto: 0 },
    },
  );

  assert.equal(offlineEfficiency(maxed), 1, '上限レベルで効率100%に達している');
  assert.equal(isMegumiUpgradeMaxed(maxed, 'sleep'), true);

  const result = buyMegumiUpgrade(maxed, 'sleep');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'maxed');
  assert.equal(result.state, maxed, 'めぐみを無駄づかいさせてしまっている');
});

test('じどうのては全種類ぶんまでしか買えない', () => {
  const maxed = stateWith(
    {},
    {
      megumi: 1_000_000,
      megumiEarned: 1_000_000,
      megumiLevels: { sprout: 0, sleep: 0, palm: 0, auto: UPGRADES.length },
    },
  );

  assert.equal(isMegumiUpgradeMaxed(maxed, 'auto'), true);
  assert.equal(buyMegumiUpgrade(maxed, 'auto').ok, false);
});

test('上限のないものは買い続けられる', () => {
  const s = stateWith(
    {},
    { megumi: 1_000, megumiEarned: 1_000, megumiLevels: { sprout: 9, sleep: 0, palm: 9, auto: 0 } },
  );

  assert.equal(isMegumiUpgradeMaxed(s, 'sprout'), false);
  assert.equal(isMegumiUpgradeMaxed(s, 'palm'), false);
});

// --- 実績 ---

test('実績のIDは重複していない', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('条件を満たした実績が記録される', () => {
  const s = stateWith({}, { lifetimeEarned: 1 });
  const { state, newlyEarned } = checkAchievements(s);

  assert.ok(newlyEarned.some((a) => a.id === 'first-drop'));
  assert.equal(isAchieved(state, 'first-drop'), true);
});

test('何も達成していなければ状態は変わらない', () => {
  const s = createInitialState(T0);
  const { state, newlyEarned } = checkAchievements(s);

  assert.deepEqual(newlyEarned, []);
  assert.equal(state, s, '達成していないのに新しい状態が返っている');
});

test('同じ実績は二重に記録されない', () => {
  const s = stateWith({}, { lifetimeEarned: 1 });
  const once = checkAchievements(s).state;
  const twice = checkAchievements(once);

  assert.deepEqual(twice.newlyEarned, []);
  assert.equal(twice.state, once);
  assert.equal(achievementCount(once), 1);
});

test('条件が偽に戻っても実績は外れない', () => {
  // 「おひさま Lv.25」を達成したあと、転生でレベルが0に戻るケース
  const s = stateWith(
    { sun: 25 },
    { totalEarned: MEGUMI_DIVISOR, lifetimeEarned: MEGUMI_DIVISOR },
  );
  const achieved = checkAchievements(s).state;
  assert.equal(isAchieved(achieved, 'sun-25'), true);

  const after = prestige(achieved, T0 + 1_000).state;

  assert.equal(after.levels.sun, 0, '条件はもう満たしていない');
  assert.equal(isAchieved(after, 'sun-25'), true, '取ったはずの実績が消えている');
});

test('実績は生産量に倍率をかける', () => {
  const none = stateWith({ sun: 10 });
  const three = stateWith({ sun: 10 }, { achievements: ['first-drop', 'sprouted', 'all-kinds'] });

  assert.equal(num(achievementMultiplier(none)), 1);
  assert.equal(num(achievementMultiplier(three)), 1 + 3 * ACHIEVEMENT_BONUS);
  assert.equal(num(productionPerSecond(three)), 1 * (1 + 3 * ACHIEVEMENT_BONUS));
});

test('advanceTo のなかで実績が判定される', () => {
  const s = stateWith({ sun: 10 }); // 1.0/s
  const result = advanceTo(s, T0 + 300_000); // 5分ぶん（効率0.5で150ひかり）

  // ひかりを集めた結果、「はじめの ひとしずく」と「めが でた」が同時に達成される
  const ids = result.newlyEarned.map((a) => a.id);
  assert.ok(ids.includes('first-drop'));
  assert.ok(ids.includes('sprouted'));
  assert.equal(isAchieved(result.state, 'first-drop'), true);
});

test('自動購入の結果も同じtickで実績に反映される', () => {
  // 4種類そろえる実績は、自動購入で最後の1種類を買った瞬間に達成されてほしい
  const s = stateWith(
    { sun: 1, water: 1, soil: 1 },
    {
      light: 100_000,
      lifetimeEarned: 100_000,
      megumiLevels: { sprout: 0, sleep: 0, palm: 0, auto: 4 },
    },
  );
  const result = advanceTo(s, T0 + 1_000);

  assert.ok(result.state.levels.wind >= 1, '自動購入でかぜを買っている');
  assert.equal(isAchieved(result.state, 'all-kinds'), true, '1tick遅れて達成されている');
});

test('長く放置した記録が残り、実績になる', () => {
  const s = stateWith({ sun: 10 });
  const result = advanceTo(s, T0 + OFFLINE_CAP_MS + 60_000); // 上限を超えて放置

  assert.equal(result.state.longestOfflineMs, OFFLINE_CAP_MS);
  assert.equal(isAchieved(result.state, 'deep-sleep'), true);
});

test('短い離席では放置の記録が上書きされない', () => {
  const s = stateWith({ sun: 10 }, { longestOfflineMs: OFFLINE_CAP_MS });
  const result = advanceTo(s, T0 + 5_000); // オンライン扱い

  assert.equal(result.state.longestOfflineMs, OFFLINE_CAP_MS, '記録が縮んでいる');
});

test('桁が爆発したときの実績も判定できる', () => {
  const s = stateWith({}, { lifetimeEarned: big({ m: 1, e: 25 }) });
  const { state } = checkAchievements(s);

  assert.equal(isAchieved(state, 'astronomical'), true);
  assert.equal(isAchieved(state, 'millionaire'), true, '下位の実績もまとめて達成される');
});

// --- アンロック（段階的な開放） ---

test('最初のアップグレードは常に見える', () => {
  const fresh = createInitialState(T0);

  assert.equal(isUpgradeUnlocked(fresh, 'sun'), true, '店が空だと何をする画面か分からない');
  assert.deepEqual(unlockedUpgrades(fresh).map((u) => u.id), ['sun']);
});

test('累計が基本コストの半分に届くと店頭に並ぶ', () => {
  const waterDef = UPGRADES.find((u) => u.id === 'water');
  const threshold = waterDef.baseCost * UPGRADE_UNLOCK_RATIO;

  const before = stateWith({}, { lifetimeEarned: threshold - 1 });
  const after = stateWith({}, { lifetimeEarned: threshold });

  assert.equal(isUpgradeUnlocked(before, 'water'), false);
  assert.equal(isUpgradeUnlocked(after, 'water'), true);
});

test('一度開いたものは、使い切っても閉じない', () => {
  // 判定に使うのは全周回の累計なので、所持量が0でも並んだまま
  const spent = stateWith({}, { light: 0, totalEarned: 0, lifetimeEarned: 1_000_000 });

  assert.equal(unlockedUpgrades(spent).length, UPGRADES.length);
});

test('転生パネルは到達が近づいてから出る', () => {
  const early = stateWith({}, { lifetimeEarned: 100 });
  const close = stateWith({}, { lifetimeEarned: MEGUMI_DIVISOR * 0.1 });

  assert.equal(isPrestigeUnlocked(early), false);
  assert.equal(isPrestigeUnlocked(close), true);
});

test('転生したあとは、たとえ累計が少なくても転生パネルが出たまま', () => {
  const veteran = stateWith({}, { lifetimeEarned: 0, prestigeCount: 1 });
  assert.equal(isPrestigeUnlocked(veteran), true);
});

test('めぐみショップは初回の転生後に出る', () => {
  assert.equal(isMegumiShopUnlocked(createInitialState(T0)), false);
  assert.equal(isMegumiShopUnlocked(stateWith({}, { prestigeCount: 1 })), true);
});

// --- 数値のインフレ耐性 ---

test('周回を重ねて桁が爆発しても計算が壊れない', () => {
  // 素の Number なら Infinity になる領域。ゲームが続けられることを確かめる
  const s = stateWith(
    { sun: 500, water: 500, soil: 500, wind: 500 },
    { totalEarned: big({ m: 1, e: 400 }), megumiEarned: big({ m: 1, e: 200 }) },
  );

  const rate = productionPerSecond(s);
  assert.ok(rate.e > 200, '生産量が桁あふれせずに保たれている');
  assert.ok(Number.isFinite(rate.m));

  const gained = advanceTo(s, T0 + 60_000).gained;
  assert.ok(gained.e > 200);

  const reward = megumiOnPrestige(s);
  assert.ok(reward.e > 190, '転生の報酬も計算できる');
});

test('レベルが高くなってもコストが Infinity にならない', () => {
  const cost = upgradeCost('sun', 20_000);
  assert.ok(cost.e > 1_000, '天文学的な値でも桁として扱える');
  assert.ok(Number.isFinite(cost.m));

  // 素の Number だとこうなる、という対比
  assert.equal(10 * 1.15 ** 20_000, Infinity);
});

test('桁の大きい所持量でも購入判定が正しく効く', () => {
  const rich = stateWith({ sun: 500 }, { light: big({ m: 1, e: 300 }) });
  assert.equal(buyUpgrade(rich, 'sun').ok, true, '十分な所持量なら買える');

  const poor = stateWith({ sun: 5_000 }, { light: big({ m: 1, e: 300 }) });
  assert.equal(buyUpgrade(poor, 'sun').ok, false, 'コストのほうが桁違いに大きい');
});

// --- セーブとロード ---

test('セーブして読み込むと同じ状態に戻る', () => {
  const s = stateWith(
    { sun: 3, water: 1 },
    {
      light: 42.5,
      totalEarned: 1_234,
      lifetimeEarned: 5_000,
      megumi: 2,
      megumiEarned: 7,
      megumiLevels: { sprout: 1, sleep: 0, palm: 3, auto: 0 },
      prestigeCount: 4,
    },
  );
  const restored = deserialize(serialize(s), T0);

  assert.deepEqual(restored, s);
});

test('桁の大きい値もセーブして読み戻せる', () => {
  const s = stateWith({}, { light: big({ m: 3.14, e: 1_234 }) });
  const restored = deserialize(serialize(s), T0);

  assert.equal(restored.light.m, 3.14);
  assert.equal(restored.light.e, 1_234);
});

test('壊れたセーブデータでも初期状態にフォールバックする', () => {
  const fresh = createInitialState(T0);

  assert.deepEqual(deserialize('これはJSONではない', T0), fresh);
  assert.deepEqual(deserialize('', T0), fresh);
  assert.deepEqual(deserialize(null, T0), fresh);
  assert.deepEqual(deserialize('{"version":999}', T0), fresh, 'バージョン違いは読まない');
});

test('セーブデータの一部が欠けても読める範囲は生かす', () => {
  const broken = JSON.stringify({
    version: 3,
    light: 'こわれた値',
    totalEarned: { m: 5, e: 2 },
    levels: { sun: 4 },
    lastSeenAt: T0,
  });
  const restored = deserialize(broken, T0);

  assert.equal(num(restored.light), 0, '壊れた項目だけ初期値に落とす');
  assert.equal(num(restored.totalEarned), 500, '無事な項目は残す');
  assert.equal(restored.levels.sun, 4);
  assert.equal(restored.levels.water, 0, '欠けている項目は0で埋める');
  assert.equal(num(restored.megumi), 0);
});

test('v1のセーブは最新まで一気に移行され、進行が失われない', () => {
  const v1Save = JSON.stringify({
    version: 1,
    light: 500,
    totalEarned: 12_345,
    levels: { sun: 7, water: 2, soil: 0, wind: 0 },
    lastSeenAt: T0,
  });
  const restored = deserialize(v1Save, T0);

  assert.equal(restored.version, SCHEMA_VERSION);
  assert.equal(num(restored.light), 500, '所持量が消えていない');
  assert.equal(restored.levels.sun, 7, 'アップグレードが消えていない');
  assert.equal(num(restored.megumi), 0, '転生はまだ0回');
  assert.equal(num(restored.lifetimeEarned), 12_345, 'これまでの累計を引き継ぐ');
  assert.deepEqual(restored.megumiLevels, { sprout: 0, sleep: 0, palm: 0, auto: 0 });
});

test('v3のセーブは実績が空の状態で移行され、次のtickでまとめて達成される', () => {
  const v3Save = JSON.stringify({
    version: 3,
    light: { m: 5, e: 5 },
    totalEarned: { m: 5, e: 5 },
    lifetimeEarned: { m: 5, e: 5 },
    levels: { sun: 30, water: 3, soil: 1, wind: 1 },
    lastSeenAt: T0,
    megumi: { m: 3, e: 0 },
    megumiEarned: { m: 3, e: 0 },
    megumiLevels: { sprout: 0, sleep: 0, palm: 0, auto: 0 },
    prestigeCount: 2,
  });
  const restored = deserialize(v3Save, T0);

  assert.equal(restored.version, 4);
  assert.deepEqual(restored.achievements, [], '移行の時点では空');
  assert.equal(restored.longestOfflineMs, 0);

  // これまでの進行が無視されないことの確認
  const { state } = checkAchievements(restored);
  assert.equal(isAchieved(state, 'sun-25'), true);
  assert.equal(isAchieved(state, 'first-prestige'), true);
  assert.equal(isAchieved(state, 'all-kinds'), true);
});

test('知らない実績IDが混ざっていても無視する', () => {
  const save = JSON.stringify({
    ...JSON.parse(serialize(createInitialState(T0))),
    achievements: ['first-drop', 'この実績はもう存在しない'],
  });
  const restored = deserialize(save, T0);

  assert.deepEqual(restored.achievements, ['first-drop']);
});

test('v2のセーブは数値がBigに変換される', () => {
  const v2Save = JSON.stringify({
    version: 2,
    light: 1_500,
    totalEarned: 900_000,
    lifetimeEarned: 900_000,
    levels: { sun: 12, water: 3, soil: 0, wind: 0 },
    lastSeenAt: T0,
    megumi: 3,
    prestigeCount: 1,
  });
  const restored = deserialize(v2Save, T0);

  assert.equal(restored.version, SCHEMA_VERSION);
  assert.equal(num(restored.light), 1_500);
  assert.equal(num(restored.megumi), 3);
  assert.equal(num(restored.megumiEarned), 3, '使った記録がないので持っている数を累計とみなす');
  assert.equal(restored.prestigeCount, 1);
  assert.equal(num(megumiMultiplier(restored)), 1.3, '移行後も倍率が保たれる');
});

test('未来のバージョンのセーブは読まない', () => {
  assert.equal(migrate({ version: 999 }), null);
  assert.deepEqual(deserialize('{"version":999,"light":10}', T0), createInitialState(T0));
});

test('バージョンが数値でないセーブも弾く', () => {
  assert.equal(migrate({ version: 'そこそこ新しい' }), null);
  assert.equal(migrate(null), null);
});

test('放置してから買う、という一連の流れが成立する', () => {
  // 手動で10回水をやる → おひさまを1つ買う → 1時間放置 → 増えている
  let s = createInitialState(T0);
  for (let i = 0; i < 10; i++) s = waterManually(s);

  const bought = buyUpgrade(s, 'sun');
  assert.equal(bought.ok, true);

  const after = advanceTo(bought.state, T0 + 60 * 60 * 1000);
  // 0.1/s × 3600秒 × 効率0.5 = 180
  assert.equal(num(after.gained), 180);
  assert.equal(num(after.state.light), 180);
});
