// 開発用の静的ファイルサーバー。依存パッケージなし（Node標準のみ）。
//
// わざわざ自前で用意しているのは、キャッシュを無効にするため。
// python3 -m http.server などはキャッシュ制御のヘッダを返さないので、
// ブラウザが古い ES モジュールを使い続け、「直したはずなのに変わらない」が起きる。
// ES モジュールは import 先まで個別にキャッシュされ、リロードでは剥がれないので厄介。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8765);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  // クエリ文字列を落とし、`..` で公開範囲の外に出られないようにする
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(ROOT, relative);

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      // これが本題。開発中は常に最新を取りに来させる
      'Cache-Control': 'no-store, must-revalidate',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT} で待機中（キャッシュ無効）`);
});
