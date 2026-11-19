/**
 * 頁面與靜態資源路由
 *
 * 1. registerWebRoutes — 掛載 /assets/*、登入、註冊、應用頁面殼層
 *
 * 安全不變量：
 * - 註冊頁在 closed 模式下回傳與不存在路徑完全相同的 404（透過共用的 notFoundHandler）
 * - git 傳輸路徑先於頁面路由註冊，不會被 /:owner/:repo 攔截
 * - 殼層不內嵌伺服器端資料
 */
import type { FastifyInstance } from 'fastify';

import type { RegistrationMode } from '../../config/schema.js';
import { notFoundHandler } from '../errors.js';
import { normalizeRepoName } from '../../repos/name.js';
import { normalizeUsername } from '../../users/username.js';
import {
  adminBody,
  issuesBody,
  loginBody,
  loginNav,
  navFor,
  pullsBody,
  registerBody,
  repoBody,
  reposBody,
  tokensBody,
} from '../../web/pages.js';
import { APP_CSS } from '../../web/styles.js';
import { APP_JS } from '../../web/script.js';
import { renderDocument } from '../../web/shell.js';

export interface WebRouteDeps {
  resolveMode: () => Promise<RegistrationMode>;
}

const ASSET_CACHE = 'public, max-age=3600';
const HTML = 'text/html; charset=utf-8';

interface RepoParams {
  owner: string;
  repo: string;
}

/**
 * 兩段路徑形如 /:owner/:repo 的樣式會吃下任何兩段 URL（例如 /assets/secrets.css）。
 * 因此殼層只在兩段都符合實際的命名規則時才渲染，否則交回共用的 404，
 * 使保留字與非法名稱不會得到一個看起來存在的頁面。
 */
function repoShellParams(params: RepoParams): RepoParams | null {
  try {
    return { owner: normalizeUsername(params.owner), repo: normalizeRepoName(params.repo) };
  } catch {
    return null;
  }
}

export function registerWebRoutes(app: FastifyInstance, deps: WebRouteDeps): void {
  app.get('/assets/app.css', async (_request, reply) =>
    reply.header('cache-control', ASSET_CACHE).type('text/css; charset=utf-8').send(APP_CSS),
  );

  app.get('/assets/app.js', async (_request, reply) =>
    reply
      .header('cache-control', ASSET_CACHE)
      .type('text/javascript; charset=utf-8')
      .send(APP_JS),
  );

  app.get('/login', async (_request, reply) => {
    const mode = await deps.resolveMode();
    return reply.type(HTML).send(
      renderDocument({
        body: loginBody(mode),
        nav: loginNav(),
        page: 'login',
        title: '登入 · onedrive-github',
      }),
    );
  });

  app.get('/register', async (request, reply) => {
    const mode = await deps.resolveMode();
    if (mode === 'closed') {
      return notFoundHandler(request, reply);
    }
    return reply.type(HTML).send(
      renderDocument({
        body: registerBody(mode),
        nav: loginNav(),
        page: 'register',
        title: '建立帳號 · onedrive-github',
      }),
    );
  });

  app.get('/', async (_request, reply) =>
    reply.type(HTML).send(
      renderDocument({
        body: reposBody(),
        nav: navFor('repos'),
        page: 'repos',
        title: 'onedrive-github',
      }),
    ),
  );

  app.get('/repos', async (_request, reply) =>
    reply.type(HTML).send(
      renderDocument({
        body: reposBody(),
        nav: navFor('repos'),
        page: 'repos',
        title: '儲存庫 · onedrive-github',
      }),
    ),
  );

  app.get('/settings/tokens', async (_request, reply) =>
    reply.type(HTML).send(
      renderDocument({
        body: tokensBody(),
        nav: navFor('tokens'),
        page: 'tokens',
        title: '存取憑證 · onedrive-github',
      }),
    ),
  );

  app.get('/admin', async (_request, reply) =>
    reply.type(HTML).send(
      renderDocument({
        body: adminBody(),
        nav: navFor('admin'),
        page: 'admin',
        title: '站台管理 · onedrive-github',
      }),
    ),
  );

  app.get<{ Params: RepoParams }>('/:owner/:repo', async (request, reply) => {
    const valid = repoShellParams(request.params);
    if (!valid) {
      return notFoundHandler(request, reply);
    }
    const { owner, repo } = valid;
    return reply.type(HTML).send(
      renderDocument({
        attributes: { owner, repo },
        body: repoBody(owner, repo),
        nav: navFor('repos'),
        page: 'repo',
        title: `${owner}/${repo} · onedrive-github`,
      }),
    );
  });

  app.get<{ Params: RepoParams }>('/:owner/:repo/issues', async (request, reply) => {
    const valid = repoShellParams(request.params);
    if (!valid) {
      return notFoundHandler(request, reply);
    }
    const { owner, repo } = valid;
    return reply.type(HTML).send(
      renderDocument({
        attributes: { owner, repo },
        body: issuesBody(owner, repo),
        nav: navFor('repos'),
        page: 'issues',
        title: `議題 · ${owner}/${repo}`,
      }),
    );
  });

  app.get<{ Params: RepoParams }>('/:owner/:repo/pulls', async (request, reply) => {
    const valid = repoShellParams(request.params);
    if (!valid) {
      return notFoundHandler(request, reply);
    }
    const { owner, repo } = valid;
    return reply.type(HTML).send(
      renderDocument({
        attributes: { owner, repo },
        body: pullsBody(owner, repo),
        nav: navFor('repos'),
        page: 'pulls',
        title: `合併請求 · ${owner}/${repo}`,
      }),
    );
  });
}
