#!/usr/bin/env node
/**
 * dsh-sidebar-tidy 的行为自检（离线、零依赖、秒级可重跑）。
 *
 * 为什么单独写一份、而不是只靠技能里的 `selftest.mjs`：
 * 那个自检只回答"两半边契约对不对"（注入成功 / 回收干净 / 可重挂）。
 * 但**这个插件的失败模式不在这里** —— 它真正的风险是：
 *   ① 点了没反应（或只翻文案没真折叠）；
 *   ② 折叠了但刷新后又回来（localStorage 读写错）；
 *   ③ React 把 nav 换成新节点后，折叠状态丢了 / 把手不见了（自愈失效）；
 *   ④ 把手被删掉后没有补回来；
 * 所以这里用一个**能手动 poke 的桩 DOM**，把上面四条逐条跑一遍。
 *
 * 桩的原则：结构按官方侧栏的真实形态造（`root > [新会话, nav.panelList, region.area]`），
 * 不为了"好测"而简化成和真实不一样的形状 —— 那样测出来的绿是假的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'lib', 'client.js');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✅ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), '实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected));
}

/* ────────────────────────── 桩 DOM ────────────────────────── */

function makeDom() {
  const all = [];
  function elem(tag) {
    const e = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: null,
      isConnected: true,
      className: '',
      id: '',
      textContent: '',
      // 桩的 style 要像真的 CSSStyleDeclaration：插件用 removeProperty 撤底色，
      // 只给空对象的话那条路径会抛错、被 catch 吞掉，测试就永远看不出"底色没撤"。
      style: {
        _p: {},
        setProperty(k, v) { this._p[k] = String(v); this[k] = String(v); },
        removeProperty(k) { delete this._p[k]; delete this[k]; return ''; },
        getPropertyValue(k) { return this._p[k] === undefined ? '' : this._p[k]; },
      },
      _attrs: {},
      _listeners: {},
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      removeAttribute(k) { delete this._attrs[k]; },
      hasAttribute(k) { return k in this._attrs; },
      appendChild(k) { k.parentElement = this; this.children.push(k); all.push(k); return k; },
      append(...kids) { for (const k of kids) this.appendChild(k); },
      insertBefore(k, ref) {
        k.parentElement = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
        all.push(k);
        return k;
      },
      removeChild(k) {
        const i = this.children.indexOf(k);
        if (i >= 0) this.children.splice(i, 1);
        k.parentElement = null; k.isConnected = false;
        const j = all.indexOf(k); if (j >= 0) all.splice(j, 1);
        return k;
      },
      remove() {
        if (this.parentElement) this.parentElement.removeChild(this);
        else { this.isConnected = false; const j = all.indexOf(this); if (j >= 0) all.splice(j, 1); }
      },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      removeEventListener() {},
      /**
       * 桩里"点一下"：**沿祖先链冒泡**（真实浏览器就是这个行为）。
       * 为什么要模拟冒泡：插件必须在标记块的 click 里 stopPropagation，
       * 否则点一下色块会连带把工作区分组"展开/收起" —— 不模拟冒泡这条根本测不出来。
       */
      click() {
        const ev = { _stopped: false, preventDefault() {}, stopPropagation() { this._stopped = true; } };
        let el = this;
        while (el) {
          for (const fn of (el._listeners.click || [])) fn(ev);
          if (ev._stopped) break;
          el = el.parentElement;
        }
      },
      querySelector(sel) { return selectFirst(this, sel); },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { width: 180, height: 16, top: 0, left: 0 }; },
      // 让 textContent 覆盖整棵子树（真实 DOM 就是如此），label 文案断言要用到
      get textContentAll() { return this.textContent + this.children.map((c) => c.textContentAll || c.textContent || '').join(''); },
    };
    // 真 DOM 的 textContent 是**整棵子树**的文本拼接 —— 插件的兜底定位就是拿它找入口文字，
    // 桩只返回自身那一段，那条兜底路径就等于永远走不到（实测：⑧ 因此假红）。
    Object.defineProperty(e, 'textContent', {
      get() {
        const own = this._text == null ? '' : this._text;
        return own + this.children.map((c) => (c.textContent == null ? '' : c.textContent)).join('');
      },
      set(v) { this._text = String(v); },
    });
    Object.defineProperty(e, 'firstChild', { get() { return this.children[0] || null; } });
    return e;
  }

  const head = elem('head');
  const body = elem('body');
  const doc = {
    head, body,
    createElement: (t) => elem(t),
    getElementById: (id) => all.find((e) => e.id === id) || null,
    querySelector: (sel) => selectFirst(head, sel) || selectFirst(body, sel) || null,
    // 真 DOM 会真的遍历。插件用它做**兜底定位**（按 `nav` 标签 + 用文字判断），
    // 桩恒返回空数组就等于把那条兜底路径测成了"永远走不到"。
    querySelectorAll: (sel) => selectAll(body, sel),
    addEventListener() {},
    removeEventListener() {},
  };

  /* 真壳形态（取证自 dsh-client-ui-sidebar/lib/client.js）：root 的直接子是
     [topStrip, logoRow, newSession, nav.panelList, regionArea, footArea]。
     桩必须按这个结构造 —— 极简模式"留哪块、藏哪块"完全取决于它们是不是 root 的直接子。 */
  const column = elem('div');
  column.className = 'hHd-Xa_root';
  const logoRow = elem('div');
  logoRow.className = 'hHd-Xa_logoRow';
  const newBtn = elem('button');
  newBtn.className = 'hHd-Xa_newSession';
  const region = elem('div');
  region.className = 'hHd-Xa_regionArea';
  const foot = elem('div');
  foot.className = 'hHd-Xa_footArea';
  const nav = elem('nav');
  nav.className = 'hHd-Xa_panelList';
  nav.setAttribute('aria-label', '面板');
  for (const label of ['插件', '自动化任务', '上下文洞察', '任务看板', '更多']) {
    const row = elem('button');
    row.className = 'hHd-Xa_panelRow';
    row.textContent = label;
    nav.appendChild(row);
  }
  // 工作区行：真壳由 ui-workspace 渲染，身份在 `data-row-key="workspace:<key>"` 上，
  // 名字在 `.title` 里。桩必须照这个形状造 —— 标记块就插在这些行的最前面。
  const mkWorkspaceRow = (key, name) => {
    const row = elem('div');
    row.className = 'YDXeBa_projectRow';
    row.setAttribute('data-row-key', 'workspace:' + key);
    const folder = elem('span');
    folder.className = 'YDXeBa_slot YDXeBa_folder';
    const text = elem('span');
    text.className = 'YDXeBa_projectText';
    const title = elem('span');
    title.className = 'YDXeBa_title';
    title.textContent = name;
    text.appendChild(title);
    row.append(folder, text);
    return row;
  };
  const ws1 = mkWorkspaceRow('/Users/x/smart_radar', 'smart_radar');
  const ws2 = mkWorkspaceRow('/Users/x/qinggui', 'qinggui');
  const ws3 = mkWorkspaceRow('/Users/x/非开发类文档', '非开发类文档');
  // 会话行：也带 data-row-key，但**不该**被标记（前缀不是 workspace:）
  const sess = elem('div');
  sess.className = 'YDXeBa_sessionRow';
  sess.setAttribute('data-row-key', 'session:abc');
  const sessTitle = elem('span');
  sessTitle.className = 'YDXeBa_title';
  sessTitle.textContent = '某个会话';
  sess.appendChild(sessTitle);

  region.append(ws1, sess, ws2, ws3);
  column.append(logoRow, newBtn, nav, region, foot);
  doc.body.appendChild(column);

  return { doc, all, refs: { root: column, logoRow, newBtn, nav, region, foot, elem, ws1, ws2, ws3, sess } };
}

function selectAll(root, selector) {
  const out = [];
  const stack = [...(root.children || [])];
  while (stack.length) {
    const cur = stack.shift();
    if (matches(cur, selector)) out.push(cur);
    if (cur.children) stack.push(...cur.children);
  }
  return out;
}

function matches(el, spec) {
  const s = String(spec).trim();
  // `.class` —— 真实 DOM 里最基本的选择器之一，桩不认就测不出"按 class 找内部节点"这类写法
  if (/^\.[A-Za-z0-9_-]+$/.test(s)) {
    return String(el.className || '').split(/\s+/).includes(s.slice(1));
  }
  const m = /^([a-zA-Z]*)\s*\[([^\]]+)\]$/.exec(s);
  if (!m) {
    // 纯标签（`nav`）也要支持：插件的兜底定位就是按标签遍历
    return /^[a-zA-Z]+$/.test(s) && el.tagName === s.toUpperCase();
  }
  const [, tag, attrExpr] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const a = /^([a-zA-Z-]+)\s*(\*=|=)\s*"?([^"]*)"?$/.exec(attrExpr);
  if (!a) {
    const bare = /^([a-zA-Z-]+)$/.exec(attrExpr.trim());
    return bare ? el.getAttribute(bare[1]) !== null : false;
  }
  const [, attr, op, want] = a;
  const have = attr === 'class' ? String(el.className || '') : el.getAttribute(attr);
  if (have === null || have === undefined) return false;
  return op === '*=' ? String(have).includes(want) : String(have) === want;
}

function selectFirst(root, selector) {
  for (const spec of String(selector).split(',')) {
    const stack = [...(root.children || [])];
    while (stack.length) {
      const cur = stack.shift();
      if (matches(cur, spec)) return cur;
      if (cur.children) stack.push(...cur.children);
    }
    if (root !== undefined && matches(root, spec)) return root;
  }
  return null;
}

/* ────────────────────────── 桩环境 ────────────────────────── */

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

function makeObservers() {
  const list = [];
  class MO {
    constructor(cb) { this.cb = cb; this.connected = false; list.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
    takeRecords() { return []; }
  }
  /** 模拟"DOM 变了"：把还连着的 observer 都触发一次（rAF 桩是同步的，所以立刻结算）。 */
  const poke = () => {
    for (const o of list) if (o.connected) { try { o.cb([]); } catch { /* 插件内部自己有 try/catch */ } }
  };
  return { MO, poke, all: list };
}

/** 加载客户端 bundle，返回它的 exports（每个场景都重新加载，避免模块级状态串场）。 */
function loadClient({ storage = makeStorage(), observers }) {
  const code = fs.readFileSync(CLIENT, 'utf8');
  const dom = makeDom();
  let captured = null;
  const win = {
    __ModuleLoader__: { load: (spec) => { captured = spec; } },
    localStorage: storage,
    setTimeout: (fn) => fn(),
  };
  const raf = (fn) => { fn(); return 0; };           // 同步执行：poke 之后状态立刻可见
  const runner = new Function('window', 'document', 'MutationObserver', 'requestAnimationFrame', 'console', code);
  runner(win, dom.doc, observers.MO, raf, { warn: (...a) => console.error('[plugin:warn]', ...a), error: (...a) => console.error('[plugin:err]', ...a), log() {} });
  if (!captured) throw new Error('客户端没有调用 __ModuleLoader__.load');
  const exports = captured.factory(() => ({}));
  return { exports, dom, win };
}

/** 造一个 ctx 桩（只提供 effect）。 */
function makeCtx() {
  const effects = [];
  return {
    effects,
    ctx: {
      effect(fn) { const d = fn(); effects.push(d); return d; },
    },
    disposeAll() { for (const d of effects) { try { d(); } catch { /* 不阻断 */ } } },
  };
}

const HANDLE = '[data-dsh-tidy-bar]';
const NAV_STATE_ATTR = 'data-dsh-tidy-nav';
const ZEN_HIDE = 'data-dsh-tidy-zen-hide';
const ZEN_ROOT = 'data-dsh-tidy-zen';
const ZEN_EXIT = 'data-dsh-tidy-zen-exit';

/* ────────────────────────── 场景 ────────────────────────── */

console.log('\n=== dsh-sidebar-tidy 行为自检 ===\n');

/* ① 注入：把手在 nav 之前，且不改 nav 的子结构 */
{
  const observers = makeObservers();
  const { exports, dom } = loadClient({ observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  const nav = dom.doc.querySelector('nav[class*="panelList"]');
  const handle = dom.doc.querySelector(HANDLE);
  ok('注入后能找到那组入口', nav !== null);
  ok('① 把手已注入', handle !== null);
  ok('① 把手紧贴在 nav 之前（同一父级、索引小 1）',
    handle && nav && handle.parentElement === nav.parentElement
    && handle.parentElement.children.indexOf(handle) === handle.parentElement.children.indexOf(nav) - 1,
    handle && nav ? `索引 ${handle.parentElement.children.indexOf(handle)} / ${handle.parentElement.children.indexOf(nav)}` : '找不到');
  eq('① 没有动 nav 的子结构（仍 5 个入口）', nav ? nav.children.length : -1, 5);
  eq('① 没存过时**默认收起**（装它就是为了把 188px 让出来，不该还要手动点一下）', nav ? nav.getAttribute(NAV_STATE_ATTR) : null, 'folded');
  {
    const toggle = handle.querySelector('.dsh-tidy-toggle');
    ok('① 是「分组标题」形态：容器 role=group，内部两个真按钮（不嵌套 button）',
      handle.getAttribute('role') === 'group'
      && toggle && toggle.tagName === 'BUTTON'
      && handle.querySelector('.dsh-tidy-zen') !== null,
      'role=' + handle.getAttribute('role'));
    ok('① 折叠按钮可访问（aria-expanded / aria-controls 挂在它上面）',
      toggle.getAttribute('aria-expanded') === 'false' && toggle.getAttribute('aria-controls') === nav.id,
      'aria-expanded=' + toggle.getAttribute('aria-expanded') + '（默认收起，所以是 false）');
  }
  ok('① 带语义标记（皮肤/适配器能识别这是插件加的）',
    handle.getAttribute('data-dsh-plugin') === 'dsh-sidebar-tidy' && handle.getAttribute('data-dsh-part') === 'nav-tidy-bar');
  c.disposeAll();
}

/* ② 点击：真折叠 + 落盘 + 再点恢复 */
{
  const storage = makeStorage();
  const observers = makeObservers();
  const { exports, dom } = loadClient({ storage, observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  const nav = dom.doc.querySelector('nav[class*="panelList"]');
  const handle = dom.doc.querySelector(HANDLE);

  // 初始是收起态（默认）→ 点一下是"展开"
  eq('② 初始是收起态', nav.getAttribute(NAV_STATE_ATTR), 'folded');
  ok('② 收起态标题是"导航 · 5"（收起时也知道里面还有几项）',
    /导航/.test(handle.textContent) && /5/.test(handle.textContent),
    handle.textContent);
  ok('② 右侧是**小字「极简模式」**（不用图标：图标要解释，文字不用）',
    (() => {
      const z = handle.querySelector('.dsh-tidy-zen');
      return z && z.textContent === '极简模式' && !String(z.innerHTML).includes('<svg');
    })(), (() => { const z = handle.querySelector('.dsh-tidy-zen'); return z ? z.textContent : '找不到'; })());

  ok('② 箭头用 SVG 不用字符（`▸` 这类字符缺字会渲染成方块）',
    (() => {
      const a = handle.querySelector('.dsh-tidy-arrow');
      return a && String(a.innerHTML).includes('<svg');
    })());

  handle.querySelector('.dsh-tidy-toggle').click();
  eq('② 点一下 → 展开（nav 去掉 folded，CSS 里就恢复显示）', nav.getAttribute(NAV_STATE_ATTR), 'open');
  eq('② 状态写进 localStorage（0 = 用户明确要展开）', storage._dump()['dsh.sidebarTidy.folded'], '0');
  eq('② aria-expanded 跟着变 true（挂在折叠按钮上）',
    handle.querySelector('.dsh-tidy-toggle').getAttribute('aria-expanded'), 'true');

  handle.querySelector('.dsh-tidy-toggle').click();
  eq('② 再点 → 收起', nav.getAttribute(NAV_STATE_ATTR), 'folded');
  eq('② 状态写回 1', storage._dump()['dsh.sidebarTidy.folded'], '1');
  eq('② aria-expanded 变回 false',
    handle.querySelector('.dsh-tidy-toggle').getAttribute('aria-expanded'), 'false');
  c.disposeAll();
}

/* ③ 刷新后保持：预置 storage，apply 就该是收起的 */
{
  const storage = makeStorage({ 'dsh.sidebarTidy.folded': '1' });
  const observers = makeObservers();
  const { exports, dom } = loadClient({ storage, observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  const nav = dom.doc.querySelector('nav[class*="panelList"]');
  eq('③ 上次收起过 → 这次一上来就是 folded（刷新后不回来）', nav.getAttribute(NAV_STATE_ATTR), 'folded');
  ok('③ 标题文案也是收起态（带条数）', /导航/.test(dom.doc.querySelector(HANDLE).textContent)
    && /5/.test(dom.doc.querySelector(HANDLE).textContent));
  c.disposeAll();
}

/* ③b 「明确展开过」必须被尊重：存了 0 就不能又按默认收起 */
{
  const storage = makeStorage({ 'dsh.sidebarTidy.folded': '0' });
  const observers = makeObservers();
  const { exports, dom } = loadClient({ storage, observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  const nav = dom.doc.querySelector('nav[class*="panelList"]');
  eq('③b 存了 0（用户点开过）→ 这次是展开，不会被默认值又收起来', nav.getAttribute(NAV_STATE_ATTR), 'open');
  c.disposeAll();
}

/* ④ React 把 nav 换成新节点：折叠态要重新套上，把手要跟着过去 */
{
  const storage = makeStorage({ 'dsh.sidebarTidy.folded': '1' });
  const observers = makeObservers();
  const { exports, dom } = loadClient({ storage, observers });
  const c = makeCtx();
  exports.apply(c.ctx);

  const oldNav = dom.doc.querySelector('nav[class*="panelList"]');
  // 模拟 React 重建：造一个**同形态的新 nav**，整体换掉旧的（旧节点连同我们的把手一起被移除）
  const root = dom.refs.root;
  oldNav.remove();
  const newNav = dom.refs.elem('nav');
  newNav.className = 'hHd-Xa_panelList';
  newNav.setAttribute('aria-label', '面板');
  for (const label of ['插件', '自动化任务']) { const r = dom.refs.elem('button'); r.textContent = label; newNav.appendChild(r); }
  root.insertBefore(newNav, dom.refs.region);

  observers.poke();   // 通知"DOM 变了"

  ok('④ nav 被换掉后，把手被补回到新 nav 之前',
    (() => {
      const h = dom.doc.querySelector(HANDLE);
      return h && h.parentElement === root && root.children.indexOf(h) === root.children.indexOf(newNav) - 1;
    })(), '新 nav 索引 ' + root.children.indexOf(newNav));
  eq('④ 新 nav 上重新套上了"收起"状态（不会因为重渲染又冒出来）', newNav.getAttribute(NAV_STATE_ATTR), 'folded');
  eq('④ 旧把手没有残留（只有一个把手）', dom.all.filter((e) => e._attrs && 'data-dsh-tidy-bar' in e._attrs).length, 1);
  c.disposeAll();
}

/* ⑤ 把手被别的代码删掉：observer 触发后要自己补回来 */
{
  const observers = makeObservers();
  const { exports, dom } = loadClient({ observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  dom.doc.querySelector(HANDLE).remove();
  eq('⑤ 先确认把手真的没了', dom.doc.querySelector(HANDLE), null);
  observers.poke();
  ok('⑤ 自愈：把手被删后自动补回', dom.doc.querySelector(HANDLE) !== null);
  c.disposeAll();
}

/* ⑥ 回收：把手 / 样式 / 属性 / id 一样都不留，且能重挂 */
{
  const observers = makeObservers();
  const { exports, dom } = loadClient({ observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  const nav = dom.doc.querySelector('nav[class*="panelList"]');
  const addedId = nav.id;
  c.disposeAll();

  eq('⑥ 回收后把手没了', dom.doc.querySelector(HANDLE), null);
  eq('⑥ 回收后 nav 上的折叠属性没了', nav.getAttribute(NAV_STATE_ATTR), null);
  eq('⑥ 回收后我们自己加的 id 撤掉了', nav.getAttribute('id'), null);
  eq('⑥ 回收后 <style> 没了', dom.doc.querySelector('style[data-plugin="dsh-sidebar-tidy"]'), null);
  ok('⑥ 只撤自己加的 id（原 id 要是别人的就不动）', addedId === 'dsh-tidy-nav-target' || addedId === '', addedId);

  const c2 = makeCtx();
  exports.apply(c2.ctx);
  ok('⑥ 回收后还能再挂一次（热重载不留幽灵、也不会永久失效）', dom.doc.querySelector(HANDLE) !== null);
  c2.disposeAll();
}

/* ⑦ 存储不可用（隐私模式）：不能因此点不动 */
{
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const observers = makeObservers();
  const { exports, dom } = loadClient({ storage: broken, observers });
  const c = makeCtx();
  let threw = null;
  try { exports.apply(c.ctx); } catch (e) { threw = e; }
  ok('⑦ 存储抛错时 apply 也不抛（Client 抛错会拖垮整个壳）', threw === null, threw && threw.message);
  const nav = dom.doc.querySelector('nav[class*="panelList"]');
  const handle = dom.doc.querySelector(HANDLE);
  let clickThrew = null;
  try { handle.querySelector('.dsh-tidy-toggle').click(); } catch (e) { clickThrew = e; }
  ok('⑦ 存储抛错时点击仍然有效（当场展开/收起，只是记不住）',
    clickThrew === null && nav.getAttribute(NAV_STATE_ATTR) === 'open',
    '点了之后是 ' + (nav ? nav.getAttribute(NAV_STATE_ATTR) : '?'));
  c.disposeAll();
}

/* ⑧ 选择器兜底：类名变了（哈希前缀换代）也能按文字找到 */
{
  const observers = makeObservers();
  const { exports, dom } = loadClient({ observers });
  const nav = dom.doc.querySelector('nav[class*="panelList"]');
  nav.className = 'SOMETHING_ELSE_newHash';        // 类名彻底变了
  const c = makeCtx();
  exports.apply(c.ctx);
  ok('⑧ 类名变了仍能按入口文字定位（不依赖会变的哈希）', dom.doc.querySelector(HANDLE) !== null);
  c.disposeAll();
}

/* ⑨ 极简模式：只留工作区 + 最底下退出 */
{
  const storage = makeStorage();
  const observers = makeObservers();
  const { exports, dom } = loadClient({ storage, observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  const { root, logoRow, newBtn, nav, region, foot } = dom.refs;

  eq('⑨ 默认就是极简（装它就是为了只留工作区）', root.getAttribute(ZEN_ROOT), '1');
  eq('⑨ 品牌行被藏', logoRow.getAttribute(ZEN_HIDE), '1');
  eq('⑨ 新会话被藏', newBtn.getAttribute(ZEN_HIDE), '1');
  eq('⑨ 导航入口组被藏', nav.getAttribute(ZEN_HIDE), '1');
  eq('⑨ 底部设置被藏', foot.getAttribute(ZEN_HIDE), '1');
  eq('⑨ **工作区留着**（不带隐藏标记）', region.getAttribute(ZEN_HIDE), null);
  ok('⑨ 退出按钮在 root 最底下（唯一的回路，必须在最底看得见）',
    (() => {
      const btn = dom.doc.querySelector('[' + ZEN_EXIT + ']');
      return btn && btn.parentElement === root && root.children[root.children.length - 1] === btn;
    })(), (() => { const b = dom.doc.querySelector('[' + ZEN_EXIT + ']'); return b ? '索引 ' + root.children.indexOf(b) + ' / 共 ' + root.children.length : '找不到'; })());
  // 退出按钮是「SVG 图标 + 文字」——桩不解析 innerHTML，所以按 innerHTML 判文案在不在。
  // 顺带钉住：**不许再用 `⛶` 这类字符图标**（缺字会渲染成方块，读起来就是 tag）。
  ok('⑨ 退出按钮是 图标 + 文字，且不含字符图标',
    (() => {
      const html = String((dom.doc.querySelector('[' + ZEN_EXIT + ']') || {}).innerHTML || '');
      return html.includes('退出极简') && html.includes('<svg') && !html.includes('⛶');
    })(), String((dom.doc.querySelector('[' + ZEN_EXIT + ']') || {}).innerHTML || '').slice(0, 60));

  // 退出：四块回来，root 标记翻成 0
  dom.doc.querySelector('[' + ZEN_EXIT + ']').click();
  eq('⑨ 点退出 → root 标记翻成 0', root.getAttribute(ZEN_ROOT), '0');
  eq('⑨ 品牌行回来了', logoRow.getAttribute(ZEN_HIDE), null);
  eq('⑨ 新会话回来了', newBtn.getAttribute(ZEN_HIDE), null);
  eq('⑨ 导航入口组回来了', nav.getAttribute(ZEN_HIDE), null);
  eq('⑨ 底部设置回来了', foot.getAttribute(ZEN_HIDE), null);
  eq('⑨ 状态落盘（0 = 不要极简）', storage._dump()['dsh.sidebarTidy.zen'], '0');
  ok('⑨ 退出后把手上的"进入极简"图标还在（能再回去）', dom.doc.querySelector('.dsh-tidy-zen') !== null);

  // 再进去
  dom.doc.querySelector('.dsh-tidy-zen').click();
  eq('⑨ 点把手上的 ⛶ → 又回极简', root.getAttribute(ZEN_ROOT), '1');
  eq('⑨ 且状态落盘 1', storage._dump()['dsh.sidebarTidy.zen'], '1');
  c.disposeAll();
}

/* ⑨b 预置 zen=0：一上来就是完整侧栏（尊重用户选过的） */
{
  const storage = makeStorage({ 'dsh.sidebarTidy.zen': '0' });
  const observers = makeObservers();
  const { exports, dom } = loadClient({ storage, observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  const { root, logoRow, newBtn, nav, region } = dom.refs;
  eq('⑨b 存了 0 → 不极简', root.getAttribute(ZEN_ROOT), '0');
  eq('⑨b 品牌行/新会话/导航组都在', [logoRow, newBtn, nav].map((e) => e.getAttribute('data-dsh-tidy-zen-hide')), [null, null, null]);
  eq('⑨b 工作区当然在', region.getAttribute('data-dsh-tidy-zen-hide'), null);
  ok('⑨b 极简时才会显示的退出按钮此刻也在 DOM 里（只是 CSS 不给显示）',
    dom.doc.querySelector('[data-dsh-tidy-zen-exit]') !== null);
  c.disposeAll();
}

/* ⑨c 回收：极简留下的痕迹一样都不许剩 */
{
  const observers = makeObservers();
  const { exports, dom } = loadClient({ observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  const { root, logoRow, newBtn, nav, foot } = dom.refs;
  c.disposeAll();
  eq('⑨c 回收后 root 的极简标记没了', root.getAttribute('data-dsh-tidy-zen'), null);
  eq('⑨c 回收后被藏过的块都摘干净了',
    [logoRow, newBtn, nav, foot].map((e) => e.getAttribute('data-dsh-tidy-zen-hide')), [null, null, null, null]);
  eq('⑨c 回收后退出按钮也没了（不留幽灵）', dom.doc.querySelector('[data-dsh-tidy-zen-exit]'), null);
}

/* ⑩-0 隔离：只 apply、不点任何东西，两类标记就该已经在了
   （这条是为了钉住"ensure() 里真的调了同步"—— 别的断言可能被后续点击掩盖） */
{
  const storage = makeStorage();
  const observers = makeObservers();
  const { exports, dom } = loadClient({ storage, observers });
  exports.apply(makeCtx().ctx);
  eq('⑩-0 apply 后工作区缩写块立刻在（首次渲染就生效）',
    dom.refs.ws1.querySelector('[data-dsh-tidy-mark]') !== null, true);
  eq('⑩-0 会话行**默认没有底色**（只有手动标过的才上色）',
    dom.refs.sess.getAttribute('data-dsh-tidy-tinted'), null);
}

/* ⑩ 工作区标记：缩写 / 颜色 / 开关 */
{
  const MARK = 'data-dsh-tidy-mark';
  const PICKER = 'data-dsh-tidy-picker';
  const storage = makeStorage();
  const observers = makeObservers();
  const { exports, dom } = loadClient({ storage, observers });
  const c = makeCtx();
  exports.apply(c.ctx);
  const { ws1, ws2, ws3, sess } = dom.refs;
  const markOf = (row) => row.querySelector('[' + MARK + ']');

  ok('⑩ 每个工作区行前都有标记块', Boolean(markOf(ws1) && markOf(ws2) && markOf(ws3)));
  eq('⑩ 标记块插在行首（folder 图标之前）', ws1.children.indexOf(markOf(ws1)), 0);
  eq('⑩ 会话行**不**被标记（只认 workspace: 前缀）', markOf(sess), null);

  eq('⑩ 多词取首尾字母（smart_radar → SR）', markOf(ws1).textContent, 'SR');
  eq('⑩ 单词取首字母（qinggui → Q）', markOf(ws2).textContent, 'Q');
  eq('⑩ 中文取首字（非开发类文档 → 非）', markOf(ws3).textContent, '非');

  const c1 = markOf(ws1).style.background;
  const c2 = markOf(ws2).style.background;
  ok('⑩ 颜色按名字自动分配且稳定', Boolean(c1) && Boolean(c2));

  // 点标记块：弹色板，且**不能**把工作区分组连带展开/收起
  {
    let rowClicks = 0;
    ws1.addEventListener('click', () => { rowClicks += 1; });
    markOf(ws1).click();
    eq('⑩ ★ 点色块不会触发行自身的展开/收起（stopPropagation）', rowClicks, 0);
    ok('⑩ 点色块弹出颜色选择', dom.doc.querySelector('[' + PICKER + ']') !== null);
    eq('⑩ 色板给 12 个可选色', dom.doc.querySelectorAll('[' + PICKER + '] .dsh-tidy-swatch').length
      || (dom.doc.querySelector('[' + PICKER + ']') || { children: [] }).children[0].children.length, 12);

    // 选第二个颜色 → 落到 localStorage，并且色块变过去
    const swatches = dom.doc.querySelector('[' + PICKER + ']').children[0].children;
    swatches[1].click();
    const marks = JSON.parse(storage._dump()['dsh.sidebarTidy.marks'] || '{}');
    eq('⑩ 选中的颜色存进 localStorage（按行 key 存）', marks['workspace:/Users/x/smart_radar'] !== undefined, true);
    eq('⑩ 色板选完自动关闭', dom.doc.querySelector('[' + PICKER + ']'), null);
    ok('⑩ 色块立刻换成新颜色', markOf(ws1).style.background === swatches[1].style.background,
      markOf(ws1).style.background);
  }

  // 开关①「缩写」：关掉 = 缩写块整个撤掉，官方文件夹图标回来
  {
    const swAbbr = dom.doc.querySelector('.dsh-tidy-sw');
    ok('⑩ 标题栏里有开关（缩写 / 标色）', swAbbr !== null,
      swAbbr ? '第一个：' + swAbbr.textContent : '找不到');
    eq('⑩ 默认两个开关都开着', swAbbr.getAttribute('data-on'), '1');
    const folder = ws1.querySelector('[class*="folder"]');
    eq('⑩ 缩写块**顶替**了官方文件夹图标（图标被隐藏，不是两个并排）',
      folder.getAttribute('data-dsh-tidy-hide'), '1');

    swAbbr.click();   // 关缩写
    eq('⑩ 关掉缩写 → 缩写块消失', markOf(ws1), null);
    eq('⑩ 同时把官方文件夹图标放回来', folder.getAttribute('data-dsh-tidy-hide'), null);
    eq('⑩ 开关状态落盘', storage._dump()['dsh.sidebarTidy.abbr'], '0');
    swAbbr.click();   // 再开
    eq('⑩ 再点 → 缩写块回来', Boolean(markOf(ws1)), true);
    eq('⑩ 文件夹图标又被顶替', folder.getAttribute('data-dsh-tidy-hide'), '1');
  }

  // 开关②「标色」+ 菜单入口：给**会话行**铺底色，与工作区缩写互不影响
  {
    const TINTED = 'data-dsh-tidy-tinted';
    const MENU_ITEM = 'data-dsh-tidy-menu-item';
    eq('⑩ 会话行默认无色（用户没标过就不上色）', sess.getAttribute(TINTED), null);
    eq('⑩ 工作区行也不带底色', ws1.getAttribute(TINTED), null);

    // 造一份"官方 ⋯ 菜单"：role=menu + 一个 menuitem，并让会话行带上 menuOpen
    const menu = dom.refs.elem('div');
    menu.setAttribute('role', 'menu');
    const proto = dom.refs.elem('div');
    proto.setAttribute('role', 'menuitem');
    proto.className = 'OFFICIAL_MENU_ITEM_CLS';
    proto.textContent = '归档会话';
    menu.appendChild(proto);
    dom.doc.body.appendChild(menu);
    sess.className = 'YDXeBa_sessionRow YDXeBa_menuOpen';

    observers.poke();   // 通知"DOM 变了" → ensure → syncSessionMenu
    const injected = menu.querySelector('[' + MENU_ITEM + ']');
    ok('⑩ ★ 会话的 ⋯ 菜单里出现「标色…」', injected !== null);
    eq('⑩ 新项复制了官方菜单项的 class（样式不突兀）', injected && injected.className, 'OFFICIAL_MENU_ITEM_CLS');
    eq('⑩ ★ 新项插在菜单**最前面**（菜单贴屏幕下缘时，末尾的项会被裁掉看不到）',
      menu.children.indexOf(injected), 0);

    // 点「标色…」→ 弹色板 → 选一个色 → 行上出底色
    injected.click();
    const picker = dom.doc.querySelector('[data-dsh-tidy-picker]');
    ok('⑩ 点「标色…」弹出色板', picker !== null);
    ok('⑩ ★ 色板弹在锚点**右边**（不盖住菜单本身），且夹在视口内',
      (() => {
        const left = parseInt(String(picker.style.left || '0'), 10);
        return left >= 180 && left <= 1200 - 196;
      })(), 'left=' + picker.style.left);
    const swatches = picker.children[0].children;
    swatches[3].click();
    ok('⑩ ★ 选完色，会话行铺上底色（inset 叠加，不盖官方 hover/选中）',
      /inset 0 0 0 9999px/.test(String(sess.style.boxShadow)), String(sess.style.boxShadow));
    eq('⑩ 底色记在 localStorage 里（按 session key）',
      JSON.parse(storage._dump()['dsh.sidebarTidy.marks'] || '{}')['session:abc'] !== undefined, true);

    // 关掉「标色」开关 → 底色撤掉，但标记仍存在（下次打开还在）
    const sws = [];
    (function collect(el) {
      if (!el || !el.children) return;
      for (const ch of el.children) {
        if (String(ch.className || '').split(/\s+/).includes('dsh-tidy-sw')) sws.push(ch);
        collect(ch);
      }
    })(dom.refs.root);
    const swColor = sws[1];
    ok('⑩ 第二个开关是「标色」', swColor && swColor.textContent === '标色',
      swColor ? swColor.textContent : '找不到');
    swColor.click();
    eq('⑩ 关掉标色 → 底色撤掉', sess.getAttribute(TINTED), null);
    ok('⑩ 但标记没丢（重新打开还在）',
      JSON.parse(storage._dump()['dsh.sidebarTidy.marks'] || '{}')['session:abc'] !== undefined, true);
    swColor.click();
    ok('⑩ 再打开 → 底色回来', /inset 0 0 0 9999px/.test(String(sess.style.boxShadow)));
    eq('⑩ 工作区缩写块全程不受影响', Boolean(markOf(ws1)), true);
    sess.className = 'YDXeBa_sessionRow';
    menu.remove();
  }

  // 回收：标记块与色板都不许留下
  {
    markOf(ws2).click();
    ok('⑩ 回收前色板存在', dom.doc.querySelector('[' + PICKER + ']') !== null);
    c.disposeAll();
    eq('⑩ 回收后工作区标记块全清', dom.doc.querySelector('[' + MARK + ']'), null);
    eq('⑩ 回收后会话行的底色也撤了（不留在官方行上）', dom.doc.querySelector('[data-dsh-tidy-tinted]'), null);
    eq('⑩ 回收后菜单里插的项也清掉', dom.doc.querySelector('[data-dsh-tidy-menu-item]'), null);
    eq('⑩ 回收后官方文件夹图标恢复显示', dom.doc.querySelector('[data-dsh-tidy-hide]'), null);
    eq('⑩ 回收后色板也关掉', dom.doc.querySelector('[' + PICKER + ']'), null);
  }
}

/* ────────────────────────── 收尾 ────────────────────────── */

console.log('\n合计：' + pass + ' 项 ✅ / ' + fails.length + ' 项 ❌');
if (fails.length) {
  for (const f of fails) console.log('  ❌ ' + f);
  process.exitCode = 1;
}
