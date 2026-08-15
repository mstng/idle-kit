// UI層。ここは「ゲームループ・保存・描画」の3つだけを担当し、ゲームのルールは一切書かない。
// ルールはすべて game.js（純粋関数）側にあるので、UIを作り替えてもゲームは壊れない。

import { ONE, add, big, div, lt, pow10, toNumber } from './bignum.js';
import {
  UPGRADES,
  MEGUMI_UPGRADES,
  ACHIEVEMENTS,
  STAGES,
  isAchieved,
  achievementCount,
  achievementMultiplier,
  isUpgradeUnlocked,
  isPrestigeUnlocked,
  isMegumiShopUnlocked,
  createInitialState,
  currentStage,
  nextStage,
  stageIndex,
  currentCost,
  currentMegumiCost,
  isMegumiUpgradeMaxed,
  automatedUpgradeIds,
  productionPerSecond,
  advanceTo,
  waterManually,
  buyUpgrade,
  buyMegumiUpgrade,
  manualGain,
  offlineEfficiency,
  megumiMultiplier,
  megumiOnPrestige,
  canPrestige,
  lightUntilPrestige,
  prestige,
  serialize,
  deserialize,
} from './game.js';

// --- 定数 ---
// 保存キーにはバージョンを含めない。形式の変更は game.js の移行処理で吸収するので、
// キーを変えてしまうと「古いセーブが見つからない＝進行が消えた」ことになる
const SAVE_KEY = 'idle-kit:save';
const LEGACY_SAVE_KEYS = ['idle-kit:save:v1']; // 昔のキーで保存されたデータも拾う
const TICK_INTERVAL_MS = 100; // 画面更新の間隔。計算は実時間ベースなので、この値を変えても進行速度は変わらない
const AUTOSAVE_INTERVAL_MS = 5_000;

/** 日本語の桁の単位。これを超えたら指数表記に切り替える */
const JA_UNITS = [
  { exponent: 20, suffix: '垓' },
  { exponent: 16, suffix: '京' },
  { exponent: 12, suffix: '兆' },
  { exponent: 8, suffix: '億' },
  { exponent: 4, suffix: '万' },
];
const SCIENTIFIC_FROM_EXPONENT = 24; // 垓を超えたら「1.23×10^30」形式にする

// --- 状態（このモジュールだけが持つ可変の変数） ---
let state = createInitialState(Date.now());
let lastSavedAt = 0;

// --- 保存と読み込み ---

/** localStorage が使えない環境（プライベートブラウズ等）でも落ちないように包む */
function loadState() {
  try {
    // 現行キー → 昔のキーの順に探す。見つかった時点で読む
    for (const key of [SAVE_KEY, ...LEGACY_SAVE_KEYS]) {
      const raw = localStorage.getItem(key);
      if (raw) return deserialize(raw, Date.now());
    }
    return createInitialState(Date.now());
  } catch (error) {
    console.warn('セーブデータの読み込みに失敗したので新規で始めます', error);
    return createInitialState(Date.now());
  }
}

function saveState() {
  try {
    localStorage.setItem(SAVE_KEY, serialize(state));
    lastSavedAt = Date.now();
  } catch (error) {
    console.warn('セーブに失敗しました', error);
  }
}

// --- 表示のための整形 ---

/**
 * 巨大数を読みやすい文字列にする。
 * 桁が増えるほど情報を粗くしていく（1.8万 → 3.2京 → 1.23×10^45）。
 * 放置ゲーでは正確な桁より「どのくらいの規模か」が伝わることが大事。
 */
function formatNumber(value) {
  const amount = big(value);
  if (amount.m === 0) return '0';
  if (amount.m < 0) return `-${formatNumber({ m: -amount.m, e: amount.e })}`;

  // 垓を超えたら指数表記。ここまで来ると単位を足しても読めない
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
function formatCount(value) {
  const amount = big(value);
  if (amount.m === 0) return '0';
  if (amount.e >= 15) return formatNumber(amount); // 数えられる範囲を超えたら通常表記に任せる
  return Math.floor(toNumber(amount)).toLocaleString('ja-JP');
}

/** ミリ秒を「2時間30分」のような表記にする */
function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}時間${minutes}分`;
  if (minutes > 0) return `${minutes}分`;
  return `${Math.floor(ms / 1000)}秒`;
}

// --- DOM の組み立て ---

const el = {
  stageEmoji: document.querySelector('#stage-emoji'),
  stageName: document.querySelector('#stage-name'),
  light: document.querySelector('#light'),
  rate: document.querySelector('#rate'),
  progressBar: document.querySelector('#progress-bar'),
  progressLabel: document.querySelector('#progress-label'),
  waterButton: document.querySelector('#water-button'),
  shop: document.querySelector('#shop'),
  megumi: document.querySelector('#megumi'),
  megumiMultiplier: document.querySelector('#megumi-multiplier'),
  megumiShop: document.querySelector('#megumi-shop'),
  runCount: document.querySelector('#run-count'),
  prestigePanel: document.querySelector('#prestige-panel'),
  megumiShopLabel: document.querySelector('#megumi-shop-label'),
  achievementCount: document.querySelector('#achievement-count'),
  achievementList: document.querySelector('#achievement-list'),
  prestigeButton: document.querySelector('#prestige-button'),
  prestigeNote: document.querySelector('#prestige-note'),
  resetButton: document.querySelector('#reset-button'),
  offlineNote: document.querySelector('#offline-note'),
  toast: document.querySelector('#toast'),
};

/** 買い物ボタンは起動時に1度だけ作り、以降は中身のテキストだけ書き換える */
const shopButtons = new Map();
const megumiButtons = new Map();
const achievementRows = new Map();

/** 共通の買い物ボタンをつくる。ひかりショップとめぐみショップで見た目の骨格は同じ */
function createShopButton({ emoji, name, className, onClick }) {
  const button = document.createElement('button');
  button.className = className;
  button.innerHTML = `
    <span class="shop-emoji">${emoji}</span>
    <span class="shop-body">
      <span class="shop-name">${name} <span class="shop-level" data-role="level"></span><span class="shop-badge" data-role="badge"></span></span>
      <span class="shop-effect" data-role="effect"></span>
    </span>
    <span class="shop-cost" data-role="cost"></span>
  `;
  button.addEventListener('click', onClick);
  return button;
}

function buildShops() {
  for (const upgrade of UPGRADES) {
    const button = createShopButton({
      emoji: upgrade.emoji,
      name: upgrade.name,
      className: 'shop-item',
      onClick: () => {
        const result = buyUpgrade(state, upgrade.id);
        if (!result.ok) return; // 買えないときは何も起きない（ルール判定はgame.js側の責務）
        state = result.state;
        saveState();
        render();
      },
    });
    button.querySelector('[data-role="effect"]').textContent = `+${upgrade.effect}/秒`;
    shopButtons.set(upgrade.id, button);
    el.shop.append(button);
  }

  for (const upgrade of MEGUMI_UPGRADES) {
    const button = createShopButton({
      emoji: upgrade.emoji,
      name: upgrade.name,
      className: 'shop-item megumi-item',
      onClick: () => {
        const result = buyMegumiUpgrade(state, upgrade.id);
        if (!result.ok) return;
        state = result.state;
        saveState();
        render();
      },
    });
    megumiButtons.set(upgrade.id, button);
    el.megumiShop.append(button);
  }

  for (const achievement of ACHIEVEMENTS) {
    const row = document.createElement('div');
    row.className = 'achievement';
    row.innerHTML = `
      <span class="achievement-emoji">${achievement.emoji}</span>
      <span class="achievement-body">
        <span class="achievement-name">${achievement.name}</span>
        <span class="achievement-desc">${achievement.describe()}</span>
      </span>
    `;
    achievementRows.set(achievement.id, row);
    el.achievementList.append(row);
  }
}

/** 画面全体を現在の状態から描き直す */
function render() {
  const stage = currentStage(state);
  const next = nextStage(state);

  el.stageEmoji.textContent = stage.emoji;
  el.stageName.textContent = stage.name;
  el.light.textContent = formatNumber(state.light);
  el.rate.textContent = `${formatNumber(productionPerSecond(state))} / 秒`;
  el.waterButton.textContent = `みずをやる (+${formatCount(manualGain(state))})`;

  // 次の進化までの進捗。最終段階に達していたら満タン表示にする
  if (next) {
    const from = STAGES[stageIndex(state)].threshold;
    const span = next.threshold - from;
    const ratio = (toNumber(state.totalEarned) - from) / span;
    el.progressBar.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    el.progressLabel.textContent = `${next.emoji} ${next.name} まで あと ${formatNumber(
      Math.max(0, next.threshold - toNumber(state.totalEarned)),
    )}`;
  } else {
    el.progressBar.style.width = '100%';
    el.progressLabel.textContent = 'さいだいまで そだちました';
  }

  // 自動購入されている項目には印をつける。押さなくていいものが一目でわかるように
  const automated = new Set(automatedUpgradeIds(state));

  for (const upgrade of UPGRADES) {
    const button = shopButtons.get(upgrade.id);

    // まだ手の届かないものは並べない。選択肢が多いほど迷うだけで、次の一手は伝わらない
    button.hidden = !isUpgradeUnlocked(state, upgrade.id);
    if (button.hidden) continue;

    const cost = currentCost(state, upgrade.id);
    button.querySelector('[data-role="level"]').textContent = `Lv.${state.levels[upgrade.id]}`;
    button.querySelector('[data-role="cost"]').textContent = formatNumber(cost);
    button.querySelector('[data-role="badge"]').textContent = automated.has(upgrade.id)
      ? 'じどう'
      : '';
    button.disabled = lt(state.light, cost);
  }

  renderPrestige();
  renderAchievements();
}

/** 実績パネル。未達成のものも条件つきで見せることで、次の目標として機能させる */
function renderAchievements() {
  el.achievementCount.textContent = `${achievementCount(state)} / ${ACHIEVEMENTS.length}`;

  for (const achievement of ACHIEVEMENTS) {
    const row = achievementRows.get(achievement.id);
    row.classList.toggle('locked', !isAchieved(state, achievement.id));
  }
}

/** 転生パネルの描画。到達していなくても「あといくら」を常に見せて目標にする */
function renderPrestige() {
  // 転生もめぐみショップも、意味を持つ段階になってから見せる
  el.prestigePanel.hidden = !isPrestigeUnlocked(state);
  if (el.prestigePanel.hidden) return;

  const megumiShopVisible = isMegumiShopUnlocked(state);
  el.megumiShopLabel.hidden = !megumiShopVisible;

  const gain = megumiOnPrestige(state);
  const ready = canPrestige(state);

  el.megumi.textContent = formatCount(state.megumi);
  el.megumiMultiplier.textContent = `×${toNumber(megumiMultiplier(state)).toFixed(2)}`;
  el.runCount.textContent = `${state.prestigeCount + 1} しゅうめ`;

  el.prestigeButton.disabled = !ready;
  el.prestigeButton.textContent = ready
    ? `めぐみを ${formatCount(gain)} こ うけとって さいしょから`
    : 'まだ てんせいできません';
  el.prestigeNote.textContent = ready
    ? 'ひかり・アップグレード・そだちぐあいは すべて なくなります'
    : `あと ${formatNumber(lightUntilPrestige(state))} ためると めぐみを ${formatCount(
        add(gain, ONE),
      )} こ うけとれます`;

  for (const upgrade of MEGUMI_UPGRADES) {
    const button = megumiButtons.get(upgrade.id);
    button.hidden = !megumiShopVisible;
    if (button.hidden) continue;

    const level = state.megumiLevels[upgrade.id];
    const maxed = isMegumiUpgradeMaxed(state, upgrade.id);
    const cost = currentMegumiCost(state, upgrade.id);

    button.querySelector('[data-role="level"]').textContent = `Lv.${level}`;
    button.querySelector('[data-role="badge"]').textContent = maxed ? 'MAX' : '';
    // 現在の効果ではなく「買ったらどうなるか」を見せる。買う判断に必要なのはそちら
    button.querySelector('[data-role="effect"]').textContent = maxed
      ? upgrade.describe(level)
      : upgrade.describe(level + 1);
    button.querySelector('[data-role="cost"]').textContent = maxed ? '—' : formatCount(cost);
    button.disabled = maxed || lt(state.megumi, cost);
  }

  el.offlineNote.textContent = `はなれているあいだも ${Math.round(
    offlineEfficiency(state) * 100,
  )}% のはやさで そだちます`;
}

/** 画面上部にメッセージを数秒だけ出す */
let toastTimer = null;
function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('visible'), 6_000);
}

// --- ゲームループ ---

/**
 * 一定間隔で「今」まで時間を進める。
 * 進める量は経過ミリ秒から計算するので、この関数が呼ばれる頻度がぶれても結果は変わらない。
 */
function loop() {
  const result = advanceTo(state, Date.now());
  state = result.state;

  // 離席から戻ってきたときだけ、何が起きたかを伝える
  if (result.offline && result.gained.m > 0) {
    const capped = result.cappedMs > 0 ? '（上限に達しました）' : '';
    const bought = result.purchases > 0 ? `。じどうで ${result.purchases} かい かいました` : '';
    showToast(
      `おかえりなさい。${formatDuration(result.elapsedMs)}のあいだに ${formatNumber(
        result.gained,
      )} ひかり がたまりました${capped}${bought}`,
    );
  }

  // 実績の通知はオフライン復帰の通知より後に出す。
  // 復帰直後はまとめて達成されることがあるので、件数だけ伝えて画面を埋めない
  if (result.newlyEarned.length === 1) {
    const [earned] = result.newlyEarned;
    showToast(`${earned.emoji} 「${earned.name}」を たっせい！ せいさんりょうが ふえました`);
  } else if (result.newlyEarned.length > 1) {
    showToast(
      `${result.newlyEarned.map((a) => a.emoji).join('')} ${result.newlyEarned.length}つ たっせい！ せいさんりょうが ふえました`,
    );
  }

  if (Date.now() - lastSavedAt > AUTOSAVE_INTERVAL_MS) saveState();
  render();
}

// --- 起動 ---

function start() {
  state = loadState();
  buildShops();

  el.waterButton.addEventListener('click', () => {
    state = waterManually(state);
    render();
  });

  el.prestigeButton.addEventListener('click', () => {
    const gain = megumiOnPrestige(state);
    // 取り返しがつかない操作なので、何を失って何を得るのかを明示してから確認する
    if (!confirm(`いまの そだちぐあいを すべて てばなして、めぐみを ${formatCount(gain)} こ うけとりますか？`)) {
      return;
    }

    const result = prestige(state, Date.now());
    if (!result.ok) return;

    state = result.state;
    saveState();
    render();
    showToast(
      `めぐみを ${formatCount(result.gained)} こ うけとりました。つぎは ×${toNumber(
        megumiMultiplier(state),
      ).toFixed(2)} のはやさで そだちます`,
    );
  });

  el.resetButton.addEventListener('click', () => {
    if (!confirm('めぐみもふくめて すべて けして さいしょから やりなおしますか？')) return;
    state = createInitialState(Date.now());
    saveState();
    render();
  });

  // タブを離れる／戻るタイミングは確実に拾う。ここを忘れると進行が消える
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveState();
    else loop();
  });
  window.addEventListener('pagehide', saveState);

  loop(); // 起動直後に1回走らせて、オフライン進行を反映する
  setInterval(loop, TICK_INTERVAL_MS);
}

start();
