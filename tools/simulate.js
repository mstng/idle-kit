// バランス調整のためのシミュレータ。
//
// 画面を一切通さず、game.js の純粋関数だけで数日ぶんのプレイを早送りし、
// 「初回転生まで何分か」「7日後に何周しているか」を数字で出す。
//
// 放置ゲーの調整がむずかしいのは、結果が出るまで実際に何日もかかるから。
// 定数をいじって再実行すれば、その待ち時間が数秒になる。
//
// この道具が書けるのは、ゲームのルールが DOM も時計も触らない純粋関数に
// 閉じているからで、言い換えると分離の設計投資をここで回収している。
//
// 使い方:
//   node tools/simulate.js
//   node tools/simulate.js --hours=24 --no-leaves

import { gte, gt, lt, div, add, toNumber, ZERO, ONE } from '../src/bignum.js';
import { formatNumber, formatCount, formatDuration } from '../src/format.js';
import {
  UPGRADES,
  MEGUMI_UPGRADES,
  STAGES,
  ACHIEVEMENTS,
  createInitialState,
  advanceTo,
  waterManually,
  buyUpgrade,
  buyMegumiUpgrade,
  currentCost,
  currentMegumiCost,
  isMegumiUpgradeMaxed,
  isUpgradeUnlocked,
  productionPerSecond,
  megumiOnPrestige,
  prestige,
  stageIndex,
  achievementCount,
  isLeafAvailable,
  collectLeaf,
} from '../src/game.js';

/** 開始時刻。固定値にして、実行するたびに同じ結果が出るようにする */
const STARTED_AT = 1_700_000_000_000;

/** 1歩ぶんの時間。はっぱの寿命（12秒）より短くしないと、出現に気づけない */
const DEFAULT_STEP_MS = 10_000;

/** 序盤、生産量がゼロのあいだに手動で水をやる回数 */
const MANUAL_WATERS_PER_STEP = 10;

/** めぐみを使う優先順位。自動化を最優先にするのが定石 */
const MEGUMI_PRIORITY = ['auto', 'sprout', 'sleep', 'palm'];

/**
 * 手が届くアップグレードのうち、最も効率のよいものを買えるだけ買う。
 * オートバイヤーと同じ判断基準（効果÷コスト）を、人が操作している場合として再現する。
 */
function buyBestAffordable(state) {
  let current = state;

  for (let i = 0; i < 200; i++) {
    let best = null;

    for (const upgrade of UPGRADES) {
      if (!isUpgradeUnlocked(current, upgrade.id)) continue;
      const cost = currentCost(current, upgrade.id);
      if (lt(current.light, cost)) continue;

      const value = div(upgrade.effect, cost);
      if (best === null || gt(value, best.value)) best = { id: upgrade.id, value };
    }

    if (best === null) break;
    const result = buyUpgrade(current, best.id);
    if (!result.ok) break;
    current = result.state;
  }

  return current;
}

/** めぐみを優先順位に従って使えるだけ使う */
function spendMegumi(state) {
  let current = state;

  for (let i = 0; i < 100; i++) {
    let bought = false;

    for (const id of MEGUMI_PRIORITY) {
      if (isMegumiUpgradeMaxed(current, id)) continue;
      if (lt(current.megumi, currentMegumiCost(current, id))) continue;

      const result = buyMegumiUpgrade(current, id);
      if (!result.ok) continue;
      current = result.state;
      bought = true;
      break;
    }

    if (!bought) break;
  }

  return current;
}

/**
 * 転生すべきかの判断。
 * 「いま転生すると、これまでに集めためぐみが指定の割合ぶん増えるか」で決める。
 * 早すぎる転生は損、遅すぎる転生は時間の無駄。実際のプレイヤーの感覚に近い基準。
 */
function shouldPrestige(state, growth) {
  const gain = megumiOnPrestige(state);
  if (lt(gain, ONE)) return false;
  if (lt(state.megumiEarned, ONE)) return true; // 初回はもらえるならすぐ

  return gte(gain, div(state.megumiEarned, 1 / growth));
}

/**
 * 指定時間ぶんプレイをシミュレートする。
 *
 * @param {object} options
 * @param {number} options.hours シミュレートする時間
 * @param {number} options.stepMs 1歩ぶんの時間
 * @param {boolean} options.collectLeaves 黄金のはっぱを毎回取るとみなすか
 * @param {number} options.prestigeGrowth 何割増えるなら転生するか
 */
export function simulate({
  hours = 168,
  stepMs = DEFAULT_STEP_MS,
  collectLeaves = true,
  prestigeGrowth = 0.5,
} = {}) {
  let state = createInitialState(STARTED_AT);
  const endAt = STARTED_AT + hours * 60 * 60 * 1000;

  // 段階の到達時刻は「その周のはじめから何分か」で測る。
  // 絶対時刻で記録すると、転生するたびに上書きされて意味のない数字になる
  const milestones = {
    firstRunStages: {}, // 1周目（新規プレイヤーの体験そのもの）
    lastRunStages: {}, // 直近に完了した周（周回が速くなっているかの確認）
    achievements: {},
    firstPrestige: null,
  };
  let currentRunStages = {};
  let runStartedAt = STARTED_AT;
  let leavesSeen = 0;
  let reachedStage = -1;

  for (let now = STARTED_AT + stepMs; now <= endAt; now += stepMs) {
    // 生産量ゼロのあいだは手動で水をやる（実際のプレイヤーの序盤と同じ）
    if (toNumber(productionPerSecond(state)) === 0) {
      for (let i = 0; i < MANUAL_WATERS_PER_STEP; i++) state = waterManually(state);
    }

    const advanced = advanceTo(state, now);
    state = advanced.state;

    if (collectLeaves && isLeafAvailable(state, now)) {
      const collected = collectLeaf(state, now);
      if (collected.ok) {
        state = collected.state;
        leavesSeen += 1;
      }
    }

    state = buyBestAffordable(state);

    // 到達の記録
    const stage = stageIndex(state);
    if (stage > reachedStage) {
      for (let i = reachedStage + 1; i <= stage; i++) {
        const sinceRunStart = now - runStartedAt;
        currentRunStages[STAGES[i].name] = sinceRunStart;
        if (state.prestigeCount === 0) milestones.firstRunStages[STAGES[i].name] = sinceRunStart;
      }
      reachedStage = stage;
    }
    for (const achievement of advanced.newlyEarned) {
      milestones.achievements[achievement.name] = now - STARTED_AT;
    }

    if (shouldPrestige(state, prestigeGrowth)) {
      const result = prestige(state, now);
      if (result.ok) {
        if (milestones.firstPrestige === null) milestones.firstPrestige = now - STARTED_AT;
        state = spendMegumi(result.state);

        // 木は種に戻るので、到達の記録も周ごとに取り直す
        milestones.lastRunStages = currentRunStages;
        currentRunStages = {};
        reachedStage = -1;
        runStartedAt = now;
      }
    }
  }

  return {
    state,
    milestones,
    summary: {
      hours,
      prestigeCount: state.prestigeCount,
      megumiEarned: state.megumiEarned,
      megumiLevels: { ...state.megumiLevels },
      lifetimeEarned: state.lifetimeEarned,
      finalRate: productionPerSecond(state),
      achievements: `${achievementCount(state)} / ${ACHIEVEMENTS.length}`,
      leavesCollected: leavesSeen,
    },
  };
}

// --- コマンドラインから実行されたときの表示 ---

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const [, name, value] = match;
    if (name === 'hours') options.hours = Number(value);
    if (name === 'step') options.stepMs = Number(value) * 1000;
    if (name === 'growth') options.prestigeGrowth = Number(value);
    if (name === 'no-leaves') options.collectLeaves = false;
  }
  return options;
}

function printReport(options) {
  const { milestones, summary } = simulate(options);

  console.log(`\n=== ${summary.hours}時間の シミュレーション ===\n`);

  console.log('■ 育成段階に とどくまで（周のはじめから）');
  console.log('                   1周目      直近の周');
  for (const stage of STAGES) {
    const first = milestones.firstRunStages[stage.name];
    const last = milestones.lastRunStages[stage.name];
    const show = (at) => (at === undefined ? '未到達' : formatDuration(at)).padEnd(10, ' ');
    console.log(`  ${stage.emoji} ${stage.name.padEnd(6, '　')} ${show(first)} ${show(last)}`);
  }

  console.log('\n■ 節目');
  console.log(`  はじめての転生   ${milestones.firstPrestige === null ? '未到達' : formatDuration(milestones.firstPrestige)}`);
  console.log(`  転生した回数     ${summary.prestigeCount} 周`);
  console.log(`  めぐみ（累計）   ${formatCount(summary.megumiEarned)} こ`);
  console.log(`  実績             ${summary.achievements}`);
  console.log(`  取ったはっぱ     ${summary.leavesCollected} 個`);

  console.log('\n■ 最終状態');
  console.log(`  累計ひかり       ${formatNumber(summary.lifetimeEarned)}`);
  console.log(`  生産量           ${formatNumber(summary.finalRate)} / 秒`);
  console.log(
    `  めぐみの使い道   ${MEGUMI_UPGRADES.map((u) => `${u.name} Lv.${summary.megumiLevels[u.id]}`).join(' / ')}`,
  );

  console.log('\n■ 実績を とった 時刻');
  for (const achievement of ACHIEVEMENTS) {
    const at = milestones.achievements[achievement.name];
    if (at !== undefined) console.log(`  ${achievement.emoji} ${achievement.name} … ${formatDuration(at)}`);
  }
  const missing = ACHIEVEMENTS.filter((a) => milestones.achievements[a.name] === undefined);
  if (missing.length > 0) {
    console.log(`  （未達成: ${missing.map((a) => a.name).join('、')}）`);
  }

  console.log('');
}

// このファイルを直接 node で動かしたときだけ実行する（テストからの import では動かさない）
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  printReport(parseArgs(process.argv.slice(2)));
}
