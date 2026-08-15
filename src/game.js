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
  isValid,
} from './bignum.js';

/** セーブデータの形式バージョン。形を変えたら上げて、読み込み側で移行する。 */
export const SCHEMA_VERSION = 3;

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

/**
 * 育成段階。totalEarned（累計で稼いだひかり）がしきい値を超えると進化する。
 * 「所持量」ではなく「累計」で判定するのが重要。所持量だと買い物した瞬間に退化してしまう。
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

/** id からアップグレード定義を引く。見つからなければ undefined */
export function findUpgrade(id) {
  return UPGRADES.find((u) => u.id === id);
}

export function findMegumiUpgrade(id) {
  return MEGUMI_UPGRADES.find((u) => u.id === id);
}

/** ゲーム開始時の状態をつくる。now は呼び出し側から渡す（テストで時刻を固定できるようにするため） */
export function createInitialState(now) {
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
  };
}

/** 現在の育成段階のインデックスを返す */
export function stageIndex(state) {
  let index = 0;
  for (let i = 0; i < STAGES.length; i++) {
    if (gte(state.totalEarned, STAGES[i].threshold)) index = i;
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
  return mul(mul(base, stageMultiplier), megumiMultiplier(state));
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
    };
  }

  const offline = rawElapsed > OFFLINE_THRESHOLD_MS;
  // 上限を超えた分は切り捨て。cappedMs は「捨てた時間」で、UIで正直に伝えるために返す
  const elapsedMs = offline ? Math.min(rawElapsed, OFFLINE_CAP_MS) : rawElapsed;
  const efficiency = offline ? offlineEfficiency(state) : 1;

  const result = tick(state, elapsedMs, efficiency);

  // 自動購入もこの入口の中で行う。別経路にすると
  // 「放置して戻ったらひかりが大量に余っている」状態になってしまう。
  // なお実際に放置中ずっと買い続けた場合より結果は控えめになる
  // （本来は途中で買った分がさらに稼いでいるため）。そこは割り切っている
  const automated = runAutoBuyer(result.state);

  return {
    state: { ...automated.state, lastSeenAt: now },
    gained: result.gained,
    elapsedMs,
    offline,
    cappedMs: rawElapsed - elapsedMs,
    purchases: automated.purchases,
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
export function buyUpgrade(state, id) {
  const def = findUpgrade(id);
  if (!def) return { state, ok: false, reason: 'unknown' };

  const cost = currentCost(state, id);
  if (lt(state.light, cost)) return { state, ok: false, reason: 'poor' };

  return {
    state: {
      ...state,
      light: sub(state.light, cost),
      levels: { ...state.levels, [id]: (state.levels[id] ?? 0) + 1 },
    },
    ok: true,
    cost,
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
  };
}
