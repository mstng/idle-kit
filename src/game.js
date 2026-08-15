// 放置育成ゲームのコアロジック。
// DOM も localStorage も時計（Date.now）も内部では触らない「純粋関数」だけを置く。
// → そのままテストできるし、オンライン進行とオフライン進行を同じ計算式で扱える。
//
// 数値はすべて bignum.js の Big（仮数＋指数）で扱う。素の Number だと
// 1e308 を超えた瞬間に Infinity になり、周回を重ねたプレイヤーのゲームが壊れるため。

import {
  ZERO,
  ONE,
  big,
  add,
  sub,
  mul,
  div,
  cmp,
  gt,
  gte,
  lt,
  max,
  pow,
  sqrt,
  floor,
  ceil,
  log10,
  isValid,
} from './bignum.js';

/** セーブデータの形式バージョン。形を変えたら上げて、読み込み側で移行する。 */
export const SCHEMA_VERSION = 6;

// --- チューニング定数（マジックナンバーは全部ここに集約する） ---

/** オフライン進行の上限。これ以上放置しても加算されない（1週間放置で無限に強くならないように） */
export const OFFLINE_CAP_MS = 8 * 60 * 60 * 1000; // 8時間

/** 離席中の生産効率の基本値。100%にしないのは「戻ってくる理由」を残すため */
export const BASE_OFFLINE_EFFICIENCY = 0.5;

/** この秒数より長く間が空いたら「オフラインだった」とみなす。タブを裏に置いた場合もここで拾える */
export const OFFLINE_THRESHOLD_MS = 60 * 1000; // 60秒

/** 「みずをやる」1回で得られるひかりの基本値 */
export const BASE_MANUAL_GAIN = 1;

/** 育成段階が1つ上がるごとに生産量に乗る倍率の増分（+25%）。育成が数値に効くことを体感させる */
export const STAGE_BONUS_PER_LEVEL = 0.25;

// --- 転生（プレステージ）まわり ---
//
// 転生＝これまでの進行を全部捨てて、代わりに永続通貨「めぐみ」を持ち越す仕組み。
// 放置ゲーが数ヶ月遊ばれる理由はほぼこれ一点にある。
// 「せっかく育てたものを自分の意思で手放す」という決断そのものが遊びになっている。

/** めぐみ1個を得るのに必要な累計獲得量の基準値 */
export const MEGUMI_DIVISOR = 100_000;

/** 累計めぐみ1個あたりの生産量ボーナス（+10%） */
export const MEGUMI_BONUS = 0.1;

// --- 実績とアンロック ---

/** 実績1つあたりの生産量ボーナス（+2%）。集める理由をつくるための、ささやかな報酬 */
export const ACHIEVEMENT_BONUS = 0.02;

/**
 * アップグレードが店頭に並ぶ条件。基本コストのこの割合まで稼いだら出現する。
 * 最初から4種類すべて並べると、買えないものばかりで選択肢が多く見えてしまう。
 * 手が届くものだけを見せるほうが、次に何をすればいいかが伝わる。
 */
export const UPGRADE_UNLOCK_RATIO = 0.5;

/** 転生パネルが出現する条件（めぐみ1個ぶんのこの割合まで稼いだら） */
export const PRESTIGE_UNLOCK_RATIO = 0.1;

// --- 黄金のはっぱ（ランダムイベント） ---
//
// たまに現れ、タップすると短時間だけ生産量が跳ね上がる。
// 放置ゲーに「いま画面を見ている理由」を与えるのがこの仕組みの役割。
// 放置中に出たものは見逃す（＝居合わせたことへの報酬）という設計にしている。

export const LEAF_MIN_INTERVAL_MS = 3 * 60 * 1000; // 出現間隔の下限
export const LEAF_MAX_INTERVAL_MS = 8 * 60 * 1000; // 出現間隔の上限
export const LEAF_LIFETIME_MS = 12 * 1000; // 出てから消えるまで
export const BOOST_MULTIPLIER = 7; // ブースト中の生産量の倍率
export const BOOST_DURATION_MS = 30 * 1000; // ブーストの持続時間

/**
 * 1回の advanceTo で処理する出現の上限。
 * 長時間放置ぶんをまとめて進めるとき、際限なくループしないための歯止め。
 */
const LEAF_MAX_SPAWNS_PER_ADVANCE = 500;

/**
 * 育成段階の基準となるしきい値。totalEarned（その周で稼いだ累計）と比べて進化する。
 * 「所持量」ではなく「累計」で判定するのが重要。所持量だと買い物した瞬間に退化してしまう。
 *
 * ただしこの値をそのまま使うのは1周目だけ。2周目以降は前の周の到達量に合わせて
 * 引き伸ばす（stageScale を参照）。固定値のままだと、めぐみ倍率が伸びた終盤で
 * 全段階を数十秒で駆け抜けてしまい、育成そのものが機能しなくなるため。
 */
export const STAGES = [
  { name: 'たね', emoji: '🌰', threshold: 0 },
  { name: 'ふたば', emoji: '🌱', threshold: 100 },
  { name: 'わかぎ', emoji: '🌿', threshold: 1_000 },
  { name: 'こだち', emoji: '🌳', threshold: 10_000 },
  { name: 'たいぼく', emoji: '🌲', threshold: 100_000 },
  { name: 'せかいじゅ', emoji: '🎄', threshold: 1_000_000 },
];

/**
 * ひかりで買うアップグレード。
 * cost は baseCost * growth^level の指数曲線、effect（毎秒の生産量）は線形。
 * 「コストは指数・効果は線形」にすると、レベルを上げるほど1レベルが遠くなり、
 * プレイヤーは常に「あと少しで買える」状態に置かれる。これが放置ゲーの推進力。
 */
export const UPGRADES = [
  { id: 'sun', name: 'おひさま', emoji: '☀️', baseCost: 10, growth: 1.15, effect: 0.1 },
  { id: 'water', name: 'みずやり', emoji: '💧', baseCost: 150, growth: 1.18, effect: 1.2 },
  { id: 'soil', name: 'つちづくり', emoji: '🪱', baseCost: 3_000, growth: 1.22, effect: 14 },
  { id: 'wind', name: 'かぜ', emoji: '🍃', baseCost: 60_000, growth: 1.25, effect: 160 },
];

// --- めぐみで買う永続アップグレード ---
//
// めぐみの使い道が「生産量の倍率」しかないと、転生は
// ただ数字が増えるだけの作業になる。使い道を複数用意して初めて
// 「今回のめぐみを何に使うか」という毎周の判断が生まれる。
//
// 意図的に効き方の種類を変えてある：
//   はじまりのめ = 立ち上がりを速くする（短期）
//   ねむりのちから = 放置中を強くする（生活リズム寄り）
//   てのひら     = 手動を強くする（序盤の体感）

/** 「はじまりのめ」1レベルあたり、転生後に持って始めるおひさまのレベル */
export const SPROUT_SUN_PER_LEVEL = 5;

/** 「ねむりのちから」1レベルあたりのオフライン効率の上昇 */
export const SLEEP_EFFICIENCY_PER_LEVEL = 0.1;

/** 「てのひら」1レベルあたり、手動の獲得量にかかる倍率 */
export const PALM_MULTIPLIER_PER_LEVEL = 10;

/**
 * 自動購入の1回ぶんで買える上限。
 * 8時間放置して戻ると数百回ぶんのひかりが貯まっていることがあり、
 * 無制限に回すと復帰した瞬間に画面が固まる。ここで打ち切っても
 * 残りは次のtick（0.1秒後）に持ち越されるので、プレイヤーの損にはならない。
 */
export const AUTO_BUY_MAX_PER_TICK = 50;

/** 「ねむりのちから」はオフライン効率100%で頭打ちになるので、それ以上は買えないようにする */
const SLEEP_MAX_LEVEL = Math.ceil(
  (1 - BASE_OFFLINE_EFFICIENCY) / SLEEP_EFFICIENCY_PER_LEVEL,
);

export const MEGUMI_UPGRADES = [
  {
    id: 'sprout',
    name: 'はじまりのめ',
    emoji: '🌱',
    baseCost: 1,
    growth: 4,
    describe: (level) =>
      `てんせいのあと おひさま Lv.${SPROUT_SUN_PER_LEVEL * level} から はじまる`,
  },
  {
    id: 'sleep',
    name: 'ねむりのちから',
    emoji: '🌙',
    baseCost: 2,
    growth: 5,
    maxLevel: SLEEP_MAX_LEVEL,
    describe: (level) =>
      `はなれているあいだの はやさ ${Math.round(offlineEfficiencyForLevel(level) * 100)}%`,
  },
  {
    id: 'palm',
    name: 'てのひら',
    emoji: '🤲',
    baseCost: 1,
    growth: 6,
    describe: (level) => `みずやり1かいで ${PALM_MULTIPLIER_PER_LEVEL ** level} もらえる`,
  },
  {
    id: 'auto',
    name: 'じどうのて',
    emoji: '⚙️',
    baseCost: 3,
    growth: 8,
    // 1レベルにつき、UPGRADES の先頭から1種類ずつ自動購入の対象になる
    maxLevel: UPGRADES.length,
    describe: (level) =>
      level <= UPGRADES.length
        ? `${UPGRADES[level - 1].name} を じどうで かう`
        : 'すべて じどうで かう',
  },
];

/**
 * 実績。condition が一度でも真になったら永久に記録される（あとで偽に戻っても外れない）。
 *
 * 放置ゲーの離脱は「次にやることが見えなくなった瞬間」に起きる。
 * 実績はそれを防ぐための、短期の目標を配り続ける装置。
 * だから達成の軸をわざとばらけさせている（累計・育成・周回・自動化・放置）。
 * すべてが「たくさん稼ぐ」だと、結局ひとつの目標しか存在しないのと同じになる。
 */
export const ACHIEVEMENTS = [
  {
    id: 'first-drop',
    name: 'はじめの ひとしずく',
    emoji: '💧',
    describe: () => 'はじめて ひかりを あつめる',
    condition: (state) => gte(state.lifetimeEarned, 1),
  },
  {
    id: 'sprouted',
    name: 'めが でた',
    emoji: '🌱',
    describe: () => 'ふたばまで そだてる',
    condition: (state) => stageIndex(state) >= 1,
  },
  {
    id: 'all-kinds',
    name: 'よんしゅるい そろえた',
    emoji: '🧺',
    describe: () => 'すべての アップグレードを 1つ いじょう もつ',
    condition: (state) => UPGRADES.every((u) => (state.levels[u.id] ?? 0) >= 1),
  },
  {
    id: 'sun-25',
    name: 'たいようの めぐみ',
    emoji: '☀️',
    describe: () => 'おひさまを Lv.25 まで あげる',
    condition: (state) => (state.levels.sun ?? 0) >= 25,
  },
  {
    id: 'world-tree',
    name: 'せかいじゅ',
    emoji: '🎄',
    describe: () => 'さいごの すがたまで そだてる',
    condition: (state) => stageIndex(state) >= STAGES.length - 1,
  },
  {
    id: 'millionaire',
    name: 'ひゃくまんの ひかり',
    emoji: '✨',
    describe: () => 'つうさんで 100万 ひかりを あつめる',
    condition: (state) => gte(state.lifetimeEarned, 1_000_000),
  },
  {
    id: 'first-prestige',
    name: 'はじめての てんせい',
    emoji: '🔄',
    describe: () => '1かい てんせいする',
    condition: (state) => state.prestigeCount >= 1,
  },
  {
    id: 'prestige-5',
    name: 'ごしゅうめ',
    emoji: '🌀',
    describe: () => '5かい てんせいする',
    condition: (state) => state.prestigeCount >= 5,
  },
  {
    id: 'megumi-10',
    name: 'めぐみ あつめ',
    emoji: '🍀',
    describe: () => 'めぐみを つうさん 10こ あつめる',
    condition: (state) => gte(state.megumiEarned, 10),
  },
  {
    id: 'automated',
    name: 'てを はなす',
    emoji: '⚙️',
    describe: () => 'じどうのてを 1つ かう',
    condition: (state) => (state.megumiLevels?.auto ?? 0) >= 1,
  },
  {
    id: 'full-auto',
    name: 'ぜんぶ じどう',
    emoji: '🤖',
    describe: () => 'すべてを じどうで かえるようにする',
    condition: (state) => (state.megumiLevels?.auto ?? 0) >= UPGRADES.length,
  },
  {
    id: 'deep-sleep',
    name: 'ぐっすり',
    emoji: '🌙',
    describe: () => 'オフラインの じょうげんまで はなれる',
    condition: (state) => (state.longestOfflineMs ?? 0) >= OFFLINE_CAP_MS,
  },
  {
    id: 'leaf-catcher',
    name: 'はっぱ とり',
    emoji: '⭐',
    describe: () => 'こがねの はっぱを 10かい とる',
    condition: (state) => (state.leavesCollected ?? 0) >= 10,
  },
  {
    id: 'astronomical',
    name: 'けたちがい',
    emoji: '🌌',
    describe: () => 'つうさんで 1垓（10の20じょう）ひかりを あつめる',
    condition: (state) => state.lifetimeEarned.e >= 20,
  },
];

/** id からアップグレード定義を引く。見つからなければ undefined */
export function findUpgrade(id) {
  return UPGRADES.find((u) => u.id === id);
}

export function findMegumiUpgrade(id) {
  return MEGUMI_UPGRADES.find((u) => u.id === id);
}

/**
 * 決定的な擬似乱数（mulberry32）を1歩進める。
 *
 * Math.random を使わないのは、リロードするたびに結果が変わってしまうから。
 * 種をセーブに含めておけば「良い結果が出るまでリロードし直す」遊びが成立しなくなり、
 * さらにテストで出現タイミングを固定して検証できる。
 *
 * @returns {{value:number, seed:number}} value は 0以上1未満
 */
export function nextRandom(seed) {
  const a = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: a };
}

/** 次にはっぱが出る時刻を決める */
function scheduleLeaf(fromMs, seed) {
  const roll = nextRandom(seed);
  const span = LEAF_MAX_INTERVAL_MS - LEAF_MIN_INTERVAL_MS;
  // 時刻は整数に丸める。小数のままだとセーブして読み戻したときに一致しなくなる
  return {
    at: Math.round(fromMs + LEAF_MIN_INTERVAL_MS + roll.value * span),
    seed: roll.seed,
  };
}

/** ゲーム開始時の状態をつくる。now は呼び出し側から渡す（テストで時刻を固定できるようにするため） */
export function createInitialState(now) {
  // 乱数の種は端末ごとに変わってほしいので開始時刻から作る。
  // now は外から渡されるので、テストでは固定できる
  const firstLeaf = scheduleLeaf(now, now | 0);

  return {
    version: SCHEMA_VERSION,
    light: ZERO, // 現在の所持量
    totalEarned: ZERO, // 今回の周回での累計獲得量（進化の判定と、転生の取得量に使う）
    levels: Object.fromEntries(UPGRADES.map((u) => [u.id, 0])),
    lastSeenAt: now, // 最後に時間を進めた時刻。オフライン進行の起点になる
    megumi: ZERO, // 手持ちのめぐみ。永続アップグレードに使うと減る
    megumiEarned: ZERO, // 累計で得ためぐみ。生産倍率はこちらで決まるので、使っても弱くならない
    megumiLevels: Object.fromEntries(MEGUMI_UPGRADES.map((u) => [u.id, 0])),
    prestigeCount: 0, // 転生した回数
    lifetimeEarned: ZERO, // 全周回を通じた累計。転生しても減らない（実績や統計のため）
    achievements: [], // 達成した実績のID。転生しても消えない
    longestOfflineMs: 0, // いちばん長く離れていた時間。実績の判定に使う
    lastRunTotal: ZERO, // これまでの1周でいちばん稼いだ量。育成段階のしきい値の基準になる
    rngSeed: firstLeaf.seed,
    nextLeafAt: firstLeaf.at, // 次にはっぱが出る時刻
    leafExpiresAt: 0, // いま出ているはっぱが消える時刻（0なら出ていない）
    boostUntil: 0, // ブーストが切れる時刻
    leavesCollected: 0, // これまでに取ったはっぱの数
  };
}

/**
 * 育成段階のしきい値にかける倍率。
 *
 * 前の周でどこまで稼いだかを基準に伸びる。1周目は前の周がないので1倍で、
 * 新規プレイヤーの体験は変わらない。
 *
 * これがないと、めぐみ倍率だけが際限なく伸びて、しきい値が固定のまま取り残される。
 * その結果、終盤は全段階を数十秒で駆け抜けるだけの飾りになってしまう
 * （実際にシミュレータで検出した問題）。
 *
 * 前の周の記録は下げない（max を取る）ので、木の手ごたえは自分の最高記録に追随する。
 */
export function stageScale(state) {
  const finalThreshold = STAGES[STAGES.length - 1].threshold;
  return max(ONE, div(state.lastRunTotal ?? ZERO, finalThreshold));
}

/** いまの周における、指定した段階のしきい値 */
export function stageThreshold(state, index) {
  return mul(STAGES[index].threshold, stageScale(state));
}

/** 現在の育成段階のインデックスを返す */
export function stageIndex(state) {
  const scale = stageScale(state); // 段ごとに計算し直さないよう、先に1回だけ求める
  let index = 0;
  for (let i = 0; i < STAGES.length; i++) {
    if (gte(state.totalEarned, mul(STAGES[i].threshold, scale))) index = i;
  }
  return index;
}

/** 現在の育成段階の定義を返す */
export function currentStage(state) {
  return STAGES[stageIndex(state)];
}

/** 次の段階（最終段階ならnull）。UIの「あとどれくらいで進化するか」表示に使う */
export function nextStage(state) {
  return STAGES[stageIndex(state) + 1] ?? null;
}

/** 指定レベルのときの購入コスト。小数だと表示が汚れるので切り上げる */
export function upgradeCost(id, level) {
  const def = findUpgrade(id);
  if (!def) throw new Error(`未知のアップグレードID: ${id}`);
  return ceil(mul(def.baseCost, pow(def.growth, level)));
}

/** そのアップグレードの現在の購入コスト */
export function currentCost(state, id) {
  return upgradeCost(id, state.levels[id] ?? 0);
}

/**
 * レベル fromLevel から count 個ぶん、まとめて買うときのコスト。
 *
 * 1個ずつの値段を count 回足すループにすると、レベルが数万になった時点で
 * 画面が固まる。等比数列の和の公式で一発で求める：
 *
 *   base × g^from × (g^count − 1) / (g − 1)
 *
 * なお1個ずつ買った場合の合計とは、切り上げの回数の違いでごくわずかにずれる
 * （まとめ買いのほうが最大で count 未満だけ安い）。実用上は無視できる差なので、
 * まとめ買いのささやかな利点として許容している。
 */
export function bulkCost(id, fromLevel, count) {
  const def = findUpgrade(id);
  if (!def) throw new Error(`未知のアップグレードID: ${id}`);
  if (!Number.isFinite(count) || count <= 0) return ZERO;

  const head = mul(def.baseCost, pow(def.growth, fromLevel));
  const factor = div(sub(pow(def.growth, count), ONE), def.growth - 1);
  return ceil(mul(head, factor));
}

/** いまのレベルから count 個ぶん買うときのコスト */
export function currentBulkCost(state, id, count) {
  return bulkCost(id, state.levels[id] ?? 0, count);
}

/**
 * いまの所持量で何レベルぶん買えるか。
 *
 * まとめ買いのコストの式を count について解くと、対数で一発で求まる：
 *
 *   count = log_g( light × (g − 1) / (base × g^from) + 1 )
 *
 * 1個ずつ「買えるか？」を試すループだと、1万レベル買える場面で1万回まわる。
 * 対数なら所持量がどれだけ大きくても一定時間で答えが出る。
 */
export function maxAffordable(state, id) {
  const def = findUpgrade(id);
  if (!def) return 0;

  const head = mul(def.baseCost, pow(def.growth, state.levels[id] ?? 0));
  if (lt(state.light, head)) return 0; // 1個も買えない

  const inner = add(div(mul(state.light, def.growth - 1), head), ONE);
  let count = Math.floor(log10(inner) / Math.log10(def.growth));

  // 対数の丸め誤差で1〜2多く見積もることがあるので、実際に払える数まで下げる。
  // ずれても数回で収まるため、ここのループはコストにならない
  while (count > 0 && lt(state.light, currentBulkCost(state, id, count))) count -= 1;
  return count;
}

/** めぐみアップグレードの購入コスト */
export function megumiUpgradeCost(id, level) {
  const def = findMegumiUpgrade(id);
  if (!def) throw new Error(`未知のめぐみアップグレードID: ${id}`);
  return ceil(mul(def.baseCost, pow(def.growth, level)));
}

export function currentMegumiCost(state, id) {
  return megumiUpgradeCost(id, state.megumiLevels[id] ?? 0);
}

/**
 * これ以上買っても効果が増えないか。
 * 上限に達したものを買えたままにすると、めぐみを無駄づかいさせてしまう。
 * 「無意味な選択肢を消す」のもゲーム設計の仕事。
 */
export function isMegumiUpgradeMaxed(state, id) {
  const def = findMegumiUpgrade(id);
  if (!def || def.maxLevel === undefined) return false;
  return (state.megumiLevels[id] ?? 0) >= def.maxLevel;
}

// --- めぐみアップグレードの効果 ---

/** 「ねむりのちから」を反映したオフライン効率。100%を上限にする（それ以上は放置が有利すぎる） */
export function offlineEfficiencyForLevel(level) {
  return Math.min(1, BASE_OFFLINE_EFFICIENCY + SLEEP_EFFICIENCY_PER_LEVEL * level);
}

export function offlineEfficiency(state) {
  return offlineEfficiencyForLevel(state.megumiLevels?.sleep ?? 0);
}

/** 「てのひら」を反映した手動1回ぶんの獲得量 */
export function manualGain(state) {
  const level = state.megumiLevels?.palm ?? 0;
  return mul(BASE_MANUAL_GAIN, pow(PALM_MULTIPLIER_PER_LEVEL, level));
}

/** 「はじまりのめ」を反映した、転生直後に持っているおひさまのレベル */
export function startingSunLevel(state) {
  return SPROUT_SUN_PER_LEVEL * (state.megumiLevels?.sprout ?? 0);
}

/** 累計めぐみによる永続倍率。使っても減らないので、買い物をためらわなくていい */
export function megumiMultiplier(state) {
  return add(ONE, mul(state.megumiEarned, MEGUMI_BONUS));
}

// --- 実績 ---

export function isAchieved(state, id) {
  return (state.achievements ?? []).includes(id);
}

export function achievementCount(state) {
  return (state.achievements ?? []).length;
}

/** 実績による永続倍率。集めるほど少しずつ速くなる */
export function achievementMultiplier(state) {
  return add(ONE, mul(achievementCount(state), ACHIEVEMENT_BONUS));
}

/**
 * 達成した実績を記録する。
 *
 * 一度達成したものは、条件が偽に戻っても外さない（買い物で所持量が減った、
 * 転生でレベルが戻った、など）。ここを毎回評価し直す作りにすると
 * 「取ったはずの実績が消える」という、いちばんやってはいけない体験になる。
 *
 * @returns {{state:object, newlyEarned:Array}} 何も増えなければ state はそのまま返す
 */
export function checkAchievements(state) {
  const newlyEarned = ACHIEVEMENTS.filter(
    (achievement) => !isAchieved(state, achievement.id) && achievement.condition(state),
  );
  if (newlyEarned.length === 0) return { state, newlyEarned };

  return {
    state: {
      ...state,
      achievements: [...(state.achievements ?? []), ...newlyEarned.map((a) => a.id)],
    },
    newlyEarned,
  };
}

// --- アンロック（段階的な開放） ---

/**
 * このアップグレードを店頭に出すか。
 * 手が届かないものを並べておくより、届きそうなものだけ見せるほうが
 * 「次に何をすればいいか」が伝わる。判定に使うのは全周回の累計なので、
 * 一度開放されたものが閉じることはない。
 */
export function isUpgradeUnlocked(state, id) {
  const index = UPGRADES.findIndex((u) => u.id === id);
  if (index < 0) return false;
  if (index === 0) return true; // 最初の1つは常に見せる（店が空だと何をする画面か分からない）
  return gte(state.lifetimeEarned, UPGRADES[index].baseCost * UPGRADE_UNLOCK_RATIO);
}

export function unlockedUpgrades(state) {
  return UPGRADES.filter((u) => isUpgradeUnlocked(state, u.id));
}

/** 転生パネルを出すか。初回の到達が視野に入ってから見せる */
export function isPrestigeUnlocked(state) {
  if (state.prestigeCount > 0) return true;
  return gte(state.lifetimeEarned, MEGUMI_DIVISOR * PRESTIGE_UNLOCK_RATIO);
}

/** めぐみショップを出すか。めぐみを持っていない段階で見せても意味がない */
export function isMegumiShopUnlocked(state) {
  return state.prestigeCount > 0;
}

/**
 * 毎秒の生産量。
 * アップグレードの合計に、2つの倍率（今回の育成段階 × 永続のめぐみ）を掛ける。
 * 倍率を「足す」のではなく「掛ける」のが重要で、これにより転生後の再成長が
 * 前回より明確に速くなり、周回するほど到達点が伸びていく。
 */
export function productionPerSecond(state) {
  const base = UPGRADES.reduce(
    (sum, u) => add(sum, mul(u.effect, state.levels[u.id] ?? 0)),
    ZERO,
  );
  const stageMultiplier = 1 + stageIndex(state) * STAGE_BONUS_PER_LEVEL;
  return mul(
    mul(mul(base, stageMultiplier), megumiMultiplier(state)),
    achievementMultiplier(state),
  );
}

// --- 黄金のはっぱ ---

/** いま画面にはっぱが出ているか */
export function isLeafAvailable(state, now) {
  return now < (state.leafExpiresAt ?? 0);
}

/** いまブーストが効いているか */
export function isBoosted(state, now) {
  return now < (state.boostUntil ?? 0);
}

/** ブーストの残り時間（ミリ秒） */
export function boostRemainingMs(state, now) {
  return Math.max(0, (state.boostUntil ?? 0) - now);
}

/**
 * 出現の予定を now まで進める。
 * 放置している間に出たはっぱは、消える時刻も過ぎているので受け取れない。
 * これは意図した仕様で、「その場に居合わせたこと」への報酬にしている。
 */
function advanceLeaves(state, now) {
  let seed = state.rngSeed;
  let nextLeafAt = state.nextLeafAt;
  let leafExpiresAt = state.leafExpiresAt ?? 0;

  // 予定が入っていない（移行直後など）ときは、いまを起点に組み直す
  if (!nextLeafAt) {
    const scheduled = scheduleLeaf(now, seed);
    return { ...state, rngSeed: scheduled.seed, nextLeafAt: scheduled.at };
  }

  let spawns = 0;
  while (nextLeafAt <= now && spawns < LEAF_MAX_SPAWNS_PER_ADVANCE) {
    leafExpiresAt = nextLeafAt + LEAF_LIFETIME_MS;
    const scheduled = scheduleLeaf(nextLeafAt, seed);
    nextLeafAt = scheduled.at;
    seed = scheduled.seed;
    spawns += 1;
  }

  // 上限で打ち切った場合は追いつけていないので、いまを起点に組み直す
  if (nextLeafAt <= now) {
    const scheduled = scheduleLeaf(now, seed);
    nextLeafAt = scheduled.at;
    seed = scheduled.seed;
  }

  return { ...state, rngSeed: seed, nextLeafAt, leafExpiresAt };
}

/**
 * はっぱを取る。出ていなければ何も起きない。
 * すでにブースト中でも、単純に「いまから30秒」で上書きする（延長ではない）。
 */
export function collectLeaf(state, now) {
  if (!isLeafAvailable(state, now)) return { state, ok: false };

  return {
    state: {
      ...state,
      leafExpiresAt: 0,
      boostUntil: now + BOOST_DURATION_MS,
      leavesCollected: (state.leavesCollected ?? 0) + 1,
    },
    ok: true,
  };
}

/**
 * 経過した時間のうち、ブーストが効いていた分を重みづけして「実効の時間」にする。
 *
 * ブーストは途中で切れるので、経過時間をひとつの倍率で掛けると必ずずれる。
 * 区間を「ブースト中」と「ブースト外」に分けて、それぞれの重みで足し合わせる。
 */
function weightedElapsedMs(state, windowStart, elapsedMs) {
  const boostEnd = Math.min(state.boostUntil ?? 0, windowStart + elapsedMs);
  const boostedMs = Math.min(elapsedMs, Math.max(0, boostEnd - windowStart));
  return boostedMs * BOOST_MULTIPLIER + (elapsedMs - boostedMs);
}

/**
 * 経過時間ぶんだけ状態を進める（このゲームの心臓部）。
 * ポイントは「フレーム数」ではなく「経過ミリ秒」で計算すること。
 * 画面のリフレッシュレートや処理落ちに関係なく、実時間どおりに進む。
 */
export function tick(state, elapsedMs, efficiency = 1) {
  // 負の経過時間（端末の時計が巻き戻ったなど）は無視する。ここを素通しすると所持量がマイナスになる
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return { state, gained: ZERO };

  const gained = mul(productionPerSecond(state), (elapsedMs / 1000) * efficiency);
  if (cmp(gained, ZERO) <= 0) return { state, gained: ZERO };

  return { state: earn(state, gained), gained };
}

/** 獲得の記録は3か所（所持・今回の累計・全周回の累計）に同時に反映する */
function earn(state, amount) {
  return {
    ...state,
    light: add(state.light, amount),
    totalEarned: add(state.totalEarned, amount),
    lifetimeEarned: add(state.lifetimeEarned, amount),
  };
}

/**
 * 「今」まで時間を進める。オンライン進行もオフライン進行もこの1つの入口を通す。
 * 別々に実装すると必ず計算がズレる（放置ゲーで最も多いバグ）ので、意図的に一本化している。
 *
 * @returns {{state:object, gained:Big, elapsedMs:number, offline:boolean, cappedMs:number}}
 */
export function advanceTo(state, now) {
  const rawElapsed = now - state.lastSeenAt;

  // 時計が巻き戻ったケース。進めずに基準時刻だけ今に合わせる
  if (!Number.isFinite(rawElapsed) || rawElapsed <= 0) {
    return {
      state: { ...state, lastSeenAt: now },
      gained: ZERO,
      elapsedMs: 0,
      offline: false,
      cappedMs: 0,
      purchases: 0,
      newlyEarned: [],
    };
  }

  const offline = rawElapsed > OFFLINE_THRESHOLD_MS;
  // 上限を超えた分は切り捨て。cappedMs は「捨てた時間」で、UIで正直に伝えるために返す
  const elapsedMs = offline ? Math.min(rawElapsed, OFFLINE_CAP_MS) : rawElapsed;
  const efficiency = offline ? offlineEfficiency(state) : 1;

  // ブーストが効いていた時間を重みづけしてから進める
  const windowStart = now - elapsedMs;
  const result = tick(state, weightedElapsedMs(state, windowStart, elapsedMs), efficiency);

  // 自動購入もこの入口の中で行う。別経路にすると
  // 「放置して戻ったらひかりが大量に余っている」状態になってしまう。
  // なお実際に放置中ずっと買い続けた場合より結果は控えめになる
  // （本来は途中で買った分がさらに稼いでいるため）。そこは割り切っている
  const automated = runAutoBuyer(result.state);

  // 実績の判定は最後。自動購入まで済ませた状態で見ないと
  // 「4種類そろえた」のような条件が1tick遅れて達成されてしまう
  const achieved = checkAchievements(
    advanceLeaves(
      {
        ...automated.state,
        longestOfflineMs: offline
          ? Math.max(state.longestOfflineMs ?? 0, elapsedMs)
          : (state.longestOfflineMs ?? 0),
      },
      now,
    ),
  );

  return {
    state: { ...achieved.state, lastSeenAt: now },
    gained: result.gained,
    elapsedMs,
    offline,
    cappedMs: rawElapsed - elapsedMs,
    purchases: automated.purchases,
    newlyEarned: achieved.newlyEarned,
  };
}

/** 手動で水をやる。序盤、生産量ゼロの状態から抜け出すための操作 */
export function waterManually(state) {
  return earn(state, manualGain(state));
}

/**
 * アップグレードを買う。買えないときは状態を変えずに ok:false を返す。
 * 「失敗しても壊れない」ことを呼び出し側が気にしなくて済むようにしている。
 */
export function buyUpgrade(state, id, count = 1) {
  const def = findUpgrade(id);
  if (!def) return { state, ok: false, reason: 'unknown' };

  // 'max' を渡すと、いま買えるだけ買う
  const amount = count === 'max' ? maxAffordable(state, id) : count;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { state, ok: false, reason: count === 'max' ? 'poor' : 'invalid' };
  }

  const cost = currentBulkCost(state, id, amount);
  if (lt(state.light, cost)) return { state, ok: false, reason: 'poor' };

  return {
    state: {
      ...state,
      light: sub(state.light, cost),
      levels: { ...state.levels, [id]: (state.levels[id] ?? 0) + amount },
    },
    ok: true,
    cost,
    count: amount,
  };
}

/** めぐみアップグレードを買う。減るのは手持ちのめぐみだけで、累計（＝倍率）は減らない */
export function buyMegumiUpgrade(state, id) {
  const def = findMegumiUpgrade(id);
  if (!def) return { state, ok: false, reason: 'unknown' };

  if (isMegumiUpgradeMaxed(state, id)) return { state, ok: false, reason: 'maxed' };

  const cost = currentMegumiCost(state, id);
  if (lt(state.megumi, cost)) return { state, ok: false, reason: 'poor' };

  return {
    state: {
      ...state,
      megumi: sub(state.megumi, cost),
      megumiLevels: {
        ...state.megumiLevels,
        [id]: (state.megumiLevels[id] ?? 0) + 1,
      },
    },
    ok: true,
    cost,
  };
}

// --- オートバイヤー ---
//
// 後半になると「買えるようになった瞬間に買う」だけの作業が延々と続く。
// それを肩代わりして、ようやく本当に放置していられるゲームになる。

/** 自動購入の対象になっているアップグレードのID。じどうのて Lv.N で先頭からN種類 */
export function automatedUpgradeIds(state) {
  const level = state.megumiLevels?.auto ?? 0;
  return UPGRADES.slice(0, level).map((u) => u.id);
}

/**
 * いま買えるもののうち、最も「お得」な1つを選ぶ。
 *
 * 指標は 効果 ÷ コスト（1コストあたりの生産量）。
 * 単純に安い順で買うと、効率の悪いものを延々と買い続けて成長が鈍る。
 * 育成段階やめぐみの倍率はどのアップグレードにも等しく掛かるので、
 * 順位を決めるだけならこの比だけ見れば足りる。
 */
export function bestAutoBuy(state) {
  let best = null;

  for (const id of automatedUpgradeIds(state)) {
    const def = findUpgrade(id);
    const cost = currentCost(state, id);
    if (lt(state.light, cost)) continue; // いま買えないものは候補から外す

    const value = div(def.effect, cost);
    if (best === null || gt(value, best.value)) best = { id, cost, value };
  }

  return best;
}

/**
 * 買えなくなるまで自動購入する。
 * 回数に上限を設けているのは、長時間放置から復帰したときに
 * 何百回ぶんの購入が1フレームに集中して画面が止まるのを防ぐため。
 * 打ち切っても残りは次のtickで買われるので、取りこぼしにはならない。
 */
export function runAutoBuyer(state, maxPurchases = AUTO_BUY_MAX_PER_TICK) {
  let current = state;
  let purchases = 0;

  for (let i = 0; i < maxPurchases; i++) {
    const target = bestAutoBuy(current);
    if (target === null) break;

    const result = buyUpgrade(current, target.id);
    if (!result.ok) break; // 念のため。ここに来るのは想定外なので静かに止める

    current = result.state;
    purchases += 1;
  }

  return { state: current, purchases };
}

/**
 * いま転生したら手に入るめぐみの数。
 *
 * 平方根にしているのが肝。累計獲得量は指数的に伸びるので、線形で配ると
 * 転生するたびに報酬が爆発してゲームが即終わる。平方根なら
 * 「めぐみを2倍にするには4倍稼ぐ必要がある」となり、周回の間隔が自然に伸びていく。
 */
export function megumiOnPrestige(state) {
  return floor(sqrt(div(state.totalEarned, MEGUMI_DIVISOR)));
}

/** 転生できるか（めぐみが1個以上もらえるか） */
export function canPrestige(state) {
  return gte(megumiOnPrestige(state), ONE);
}

/** 次の1個までにあと何ひかり必要か。UIで目標を示すために使う */
export function lightUntilPrestige(state) {
  const nextCount = add(megumiOnPrestige(state), ONE);
  const needed = mul(mul(nextCount, nextCount), MEGUMI_DIVISOR);
  return max(ZERO, sub(needed, state.totalEarned));
}

/**
 * 転生する。所持量・アップグレード・育成段階はすべて失われ、めぐみだけが残る。
 * 条件を満たしていなければ何も起きない（ここでも「失敗しても壊れない」を守る）。
 */
export function prestige(state, now) {
  const gained = megumiOnPrestige(state);
  if (lt(gained, ONE)) return { state, ok: false, gained: ZERO };

  const fresh = createInitialState(now);
  return {
    state: {
      ...fresh,
      // 「はじまりのめ」を買っていれば、まっさらではなくおひさまを持って再開する
      levels: { ...fresh.levels, sun: startingSunLevel(state) },
      megumi: add(state.megumi, gained),
      megumiEarned: add(state.megumiEarned, gained),
      megumiLevels: { ...state.megumiLevels },
      prestigeCount: state.prestigeCount + 1,
      lifetimeEarned: state.lifetimeEarned,
      // 実績と記録は周回をまたいで残す。ここを消すと集める意味がなくなる
      achievements: [...(state.achievements ?? [])],
      longestOfflineMs: state.longestOfflineMs ?? 0,
      // 次の周の木は、この周の到達量が基準になる。
      // 記録は下げないので、早めに転生しても手ごたえが緩まない
      lastRunTotal: max(state.lastRunTotal ?? ZERO, state.totalEarned),
      // はっぱは実時間の仕組みなので、周回とは無関係に進み続ける
      rngSeed: state.rngSeed,
      nextLeafAt: state.nextLeafAt,
      leafExpiresAt: state.leafExpiresAt ?? 0,
      boostUntil: state.boostUntil ?? 0,
      leavesCollected: state.leavesCollected ?? 0,
    },
    ok: true,
    gained,
  };
}

// --- セーブとロード ---

/** セーブ用の文字列にする。Big は {m,e} として素直に JSON になる */
export function serialize(state) {
  return JSON.stringify(state);
}

/**
 * 古い形式のセーブを1バージョンずつ新しくする関数の表。
 * バージョンを飛ばさず1段ずつ上げることで、移行のテストが「各段」で書けるようになる。
 */
const MIGRATIONS = {
  // v1 → v2: 転生を追加した。既存プレイヤーはめぐみ0から始めるが、
  // それまでの累計は lifetimeEarned として引き継ぐので記録は失われない
  1: (data) => ({
    ...data,
    version: 2,
    megumi: 0,
    prestigeCount: 0,
    lifetimeEarned: data.totalEarned,
  }),

  // v2 → v3: 数値をすべて Big（仮数＋指数）に変えた。
  // 素の数値で保存されていた値を Big の形に変換する
  2: (data) => ({
    ...data,
    version: 3,
    light: big(data.light),
    totalEarned: big(data.totalEarned),
    lifetimeEarned: big(data.lifetimeEarned),
    megumi: big(data.megumi),
    // 使った記録がないので、持っている数＝これまでに稼いだ数とみなす
    megumiEarned: big(data.megumi),
    megumiLevels: Object.fromEntries(MEGUMI_UPGRADES.map((u) => [u.id, 0])),
  }),

  // v3 → v4: 実績を追加した。
  // 既存プレイヤーの実績は空から始まるが、次のtickで条件を満たすものは
  // まとめて達成扱いになるので、これまでの進行が無視されることはない
  3: (data) => ({
    ...data,
    version: 4,
    achievements: [],
    longestOfflineMs: 0,
  }),

  // v4 → v5: 黄金のはっぱを追加した。
  // nextLeafAt を 0 にしておくと、次に時間を進めるときに「いま」を起点に組み直される。
  // ここで具体的な時刻を入れないのは、移行処理が現在時刻を知らないため
  4: (data) => ({
    ...data,
    version: 5,
    rngSeed: (data.lastSeenAt ?? 0) | 0,
    nextLeafAt: 0,
    leafExpiresAt: 0,
    boostUntil: 0,
    leavesCollected: 0,
  }),

  // v5 → v6: 育成段階のしきい値を、前の周の到達量に合わせて伸ばすようにした。
  // 0 にしておけば倍率1（＝これまでどおり）から始まり、次の転生で基準が入る
  5: (data) => ({
    ...data,
    version: 6,
    lastRunTotal: ZERO,
  }),
};

/**
 * セーブデータを現行バージョンまで引き上げる。
 * 引き上げられない（移行経路がない／未来のバージョン）場合は null を返す。
 */
export function migrate(data) {
  if (typeof data?.version !== 'number') return null;

  let current = data;
  while (current.version < SCHEMA_VERSION) {
    const step = MIGRATIONS[current.version];
    if (!step) return null; // 経路が欠けている＝安全に読めないので諦める
    current = step(current);
  }

  // 新しいビルドで作られたセーブを古いビルドで開いた場合もここで弾く
  return current.version === SCHEMA_VERSION ? current : null;
}

/**
 * セーブ文字列から状態を復元する。
 * 壊れたデータ・古いバージョン・別ゲームのデータが入っていても落ちないことを最優先にする
 * （放置ゲーはセーブが壊れた瞬間に終わるので、ここは必ず防御的に書く）。
 */
export function deserialize(text, now) {
  const fallback = createInitialState(now);
  if (typeof text !== 'string' || text.length === 0) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback; // JSONとして壊れている
  }

  if (typeof parsed !== 'object' || parsed === null) return fallback;

  const migrated = migrate(parsed);
  if (migrated === null) return fallback;

  // 1項目の欠損で全滅させないよう、項目ごとに検証して駄目なものだけ初期値に落とす
  const bigField = (value) => (isValid(value) ? big(value) : ZERO);
  const level = (value) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  return {
    version: SCHEMA_VERSION,
    light: bigField(migrated.light),
    totalEarned: bigField(migrated.totalEarned),
    lifetimeEarned: bigField(migrated.lifetimeEarned),
    levels: Object.fromEntries(
      UPGRADES.map((u) => [u.id, level(migrated.levels?.[u.id])]),
    ),
    lastSeenAt: Number.isFinite(migrated.lastSeenAt) ? migrated.lastSeenAt : now,
    megumi: bigField(migrated.megumi),
    megumiEarned: bigField(migrated.megumiEarned),
    megumiLevels: Object.fromEntries(
      MEGUMI_UPGRADES.map((u) => [u.id, level(migrated.megumiLevels?.[u.id])]),
    ),
    prestigeCount: level(migrated.prestigeCount),
    // 知らないIDが混ざっていても無視する（定義を消したあとのセーブでも落ちないように）
    achievements: ACHIEVEMENTS.map((a) => a.id).filter((id) =>
      Array.isArray(migrated.achievements) ? migrated.achievements.includes(id) : false,
    ),
    longestOfflineMs: level(migrated.longestOfflineMs),
    rngSeed: Number.isFinite(migrated.rngSeed) ? migrated.rngSeed | 0 : now | 0,
    nextLeafAt: level(migrated.nextLeafAt),
    leafExpiresAt: level(migrated.leafExpiresAt),
    boostUntil: level(migrated.boostUntil),
    leavesCollected: level(migrated.leavesCollected),
    lastRunTotal: bigField(migrated.lastRunTotal),
  };
}
