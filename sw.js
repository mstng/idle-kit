// オフラインでも起動できるようにするための Service Worker。
//
// 方針は「ネットワーク優先、失敗したらキャッシュ」。
// キャッシュ優先にすると、更新したのに古い画面が出続ける問題が起きる
// （ES モジュールのキャッシュで実際にはまったので、同じ轍は踏まない）。
// このアプリは数十KBしかないので、毎回取りに行っても体感は変わらない。

const CACHE_NAME = 'idle-kit-v1';

/** オフラインでも起動するために持っておくファイル */
const APP_SHELL = [
  './',
  './index.html',
  './src/ui.js',
  './src/game.js',
  './src/bignum.js',
  './src/format.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      // 1つでも取得に失敗したらインストールごと失敗するので、失敗しても進めるようにする
      .catch((error) => console.warn('事前キャッシュに失敗しました', error))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 自分のオリジンの GET だけを扱う。それ以外は素通しする
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // 取れたものは次のオフラインに備えて控えておく
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? caches.match('./index.html'))),
  );
});
