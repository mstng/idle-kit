// UI層。ここは「ゲームループ・保存・描画」の3つだけを担当し、ゲームのルールは一切書かない。
// ルールはすべて game.js（純粋関数）側にあるので、UIを作り替えてもゲームは壊れない。

import { ONE, add, lt, mul, toNumber } from './bignum.js';
import { formatNumber, formatCount, formatDuration } from './format.js';
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
  isLeafAvailable,
  isBoosted,
  boostRemainingMs,
  collectLeaf,
  BOOST_MULTIPLIER,
  createInitialState,
  currentStage,
  nextStage,
  stageIndex,
  currentCost,
  currentBulkCost,
  maxAffordable,
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

// --- 状態（このモジュールだけが持つ可変の変数） ---
let state = createInitialState(Date.now());
let lastSavedAt = 0;
// 「いくつ買うか」は見た目の設定であってゲームの状態ではないので、セーブには含めない
let bulkAmount = 1;

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
  leaf: document.querySelector('#leaf'),
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
        const result = buyUpgrade(state, upgrade.id, bulkAmount);
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
  const now = Date.now();
  el.light.textContent = formatNumber(state.light);

  // ブースト中は、実際に効いている速さ（倍率をかけた値）を見せる
  const boosted = isBoosted(state, now);
  const rate = productionPerSecond(state);
  el.rate.classList.toggle('boosted', boosted);
  el.rate.textContent = boosted
    ? `${formatNumber(mul(rate, BOOST_MULTIPLIER))} / 秒　×${BOOST_MULTIPLIER} のこり ${Math.ceil(
        boostRemainingMs(state, now) / 1000,
      )}秒`
    : `${formatNumber(rate)} / 秒`;

  el.leaf.hidden = !isLeafAvailable(state, now);
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

    // 「かえるだけ」のときは、いま何個買えるかを毎回計算して見せる
    const count = bulkAmount === 'max' ? maxAffordable(state, upgrade.id) : bulkAmount;
    const cost = count > 0 ? currentBulkCost(state, upgrade.id, count) : currentCost(state, upgrade.id);
    const level = state.levels[upgrade.id];

    button.querySelector('[data-role="level"]').textContent =
      count > 1 ? `Lv.${level} → ${level + count}` : `Lv.${level}`;
    button.querySelector('[data-role="cost"]').textContent = formatNumber(cost);
    button.querySelector('[data-role="badge"]').textContent = automated.has(upgrade.id)
      ? 'じどう'
      : '';
    button.disabled = count <= 0 || lt(state.light, cost);
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

  // かう かずの きりかえ
  for (const button of document.querySelectorAll('#bulk-switch button')) {
    const value = button.dataset.amount;
    button.addEventListener('click', () => {
      bulkAmount = value === 'max' ? 'max' : Number(value);
      for (const other of document.querySelectorAll('#bulk-switch button')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      render();
    });
    button.setAttribute('aria-pressed', String(value === '1'));
  }

  el.waterButton.addEventListener('click', () => {
    state = waterManually(state);
    render();
  });

  el.leaf.addEventListener('click', () => {
    const result = collectLeaf(state, Date.now());
    if (!result.ok) return;
    state = result.state;
    saveState();
    render();
    showToast(`🍀 こがねの はっぱ！ ${BOOST_MULTIPLIER}ばいの はやさが 30びょう つづきます`);
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

  registerServiceWorker();
}

/**
 * オフラインでも起動できるようにする。
 * 登録に失敗してもゲーム自体は動くので、失敗は警告に留めて先へ進む。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker
    .register('./sw.js')
    .catch((error) => console.warn('オフライン対応の登録に失敗しました', error));
}

start();
