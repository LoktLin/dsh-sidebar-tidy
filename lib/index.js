/**
 * dsh-sidebar-tidy —— Host 半边（薄）。
 *
 * 这个插件的功能**全在浏览器里**：折叠侧栏那一组导航入口、状态存 localStorage。
 * Host 这边**不注册工具、不加系统提示** —— agent 不需要知道侧栏怎么折叠，
 * 多一个工具只会多一份模型面开销。
 *
 * 留一个 `GET /sidebar-tidy/status` 只为了两件事：
 *   ① 排障：先确认"插件真的被装配了"（curl 一下就知道，不用翻日志、不用猜）；
 *   ② 自检/面板：读版本与选择器约定，少一处手抄（手抄的选择器一定会和客户端漂移）。
 *
 * 契约要点（取证自本机 dsh 0.2.1-rc.3 的官方包）：
 *   · `export const name` / `export const inject` / `export function apply(ctx)`；
 *   · 副作用一律挂 `ctx.effect`，返回 disposer；
 *   · `webServer` 用 `ctx.inject(['webServer'], …)` 惰性挂载 —— 没有它就降级（不打任何日志也照样能跑，
 *     因为这个插件的主功能本来就不依赖 Host）；
 *   · 任何出口都不能抛：Host 半边加载失败会牵连整个 profile。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-sidebar-tidy';

/** 不硬依赖任何服务：没有 webServer 也能装、也能折叠侧栏（功能在客户端）。 */
export const inject = [];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.join(HERE, '..', 'package.json');

/**
 * 版本号从 package.json 读。
 * ⚠️ 读不到就返回 null，**绝不抛** —— 版本号不该有资格让插件加载失败。
 */
export function pluginVersion() {
  try {
    const json = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const v = json && typeof json.version === 'string' ? json.version.trim() : '';
    return v || null;
  } catch {
    return null;
  }
}

/**
 * 客户端用来定位那一组入口的选择器约定 —— **唯一来源**，客户端 bundle 里不另写一份。
 * 为什么不写死类名：`hHd-Xa_panelList` 的哈希前缀随 DSH 版本变化（实测换版本就变），
 * 所以只按**语义子串**匹配；再兜一层「含已知入口文字的 nav」，两个都失手才认输。
 */
export const SELECTORS = Object.freeze({
  /** 首选：`nav` 且 class 里含 `panelList` */
  navByClass: 'nav[class*="panelList"]',
  /** 兜底：按这组入口的文字定位（少一个都不影响，命中任意一个即可） */
  navTextHints: Object.freeze(['任务看板', '上下文洞察', '自动化任务', '插件']),
});

/** 只允许本机访问：GUI 在 127.0.0.1，外部 Host 头一律拒绝。 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function writeJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  } catch {
    /* 连接已经断了就算了，别在响应阶段抛 */
  }
}

/**
 * `/sidebar-tidy` 下的 HTTP handler。
 * 导出成工厂是为了让自检能注入一个假 deps（不必起真实 webServer）。
 */
export function createHandler(deps = {}) {
  const version = deps.version ?? pluginVersion;
  return async (req, res) => {
    if (!isLoopback(req)) {
      writeJson(res, 403, { ok: false, error: '仅允许本机访问' });
      return;
    }
    const url = new URL(req.url ?? '/sidebar-tidy', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/sidebar-tidy';
    try {
      if (route === '/sidebar-tidy' || route === '/sidebar-tidy/status') {
        writeJson(res, 200, {
          ok: true,
          data: {
            name,
            version: version(),
            // 说明「主功能在哪」：看到 200 只代表 Host 半边活着，折叠行为要看浏览器
            what: '纯客户端插件：Host 半边只提供本路由，折叠逻辑与状态都在浏览器（localStorage: dsh.sidebarTidy.folded）',
            selectors: SELECTORS,
            storageKey: 'dsh.sidebarTidy.folded',
          },
        });
        return;
      }
      writeJson(res, 404, { ok: false, error: `未知路由：${route}` });
    } catch (e) {
      // 兜底：绝不让异常冒到 webServer（那会变成 500 + 栈，还可能连带别的路由）
      writeJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };
}

export function apply(ctx) {
  // 惰性挂载：拿不到 webServer 就静默降级（主功能在客户端，不受影响）。
  ctx.inject(['webServer'], (sub) => {
    const server = sub.get('webServer');
    if (!server || typeof server.register !== 'function') return;
    const handler = createHandler();
    sub.effect(
      () => server.register({ kind: 'prefix', path: '/sidebar-tidy', handler }),
      'dsh-sidebar-tidy:route',
    );
  });
}
