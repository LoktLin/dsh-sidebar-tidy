/**
 * dsh-sidebar-tidy —— Client 半边：把左侧栏收拾成"只留工作区"，再加工作区缩写与会话标色。
 *
 * ── 为什么要改 DOM（而不是注册槽位）────────────────────────────────────────────
 * 取证自本机 dsh 0.2.1-rc.3 的 `dsh-client-ui-sidebar` 契约：
 *   · `sidebar.panellist` 是**全局面板图标列表**，注释写明 "the sidebar owns the button" ——
 *     注册方只能提供 id/order/label，塞不进任意节点；
 *   · 官方只有**整体** `collapsed`，没有区块级折叠，也没有"隐藏品牌行 / 底部设置"的口子。
 * 所以只能从外面动手：**注入一条标题栏 + 给目标打属性**。
 *
 * ── 这条路的代价，以及怎么压到可接受 ──────────────────────────────────────────
 * DOM 是 React 的地盘，会被重渲染挤掉。这里的处理：
 *   1. **不改结构、不改官方样式表**：只插一条标题栏；折叠/隐藏靠给目标打 `data-*` 属性
 *      （属性而不是 inline style —— React 重渲染会覆盖 style/className，但不碰未知属性）；
 *   2. **双层自愈**：`body` 上等侧栏出现，找到后再盯它的父级；都走 rAF 节流；
 *   3. **每次 ensure 都重新套状态**：nav 是 React 新建的节点时没有我们的属性，必须重打；
 *   4. **幂等键**：重复加载不会插出第二条标题栏；
 *   5. 绝不动父级高度与定位 —— 碰了会把整列或工作区带塌。
 *
 * ── 契约要点 ─────────────────────────────────────────────────────────────────
 *   · 客户端模块是**懒加载 CJS 表**：只向 `__ModuleLoader__.load` 注册 factory，id 必须等于包名；
 *   · **绝不 throw**：apply 抛错会让整个 Web 壳启动失败 —— 全部包 try/catch；
 *   · 副作用可回收：`ctx.effect(() => cleanup, label)`；
 *   · 颜色走 `--dsw-alias-*` 令牌并带 fallback（令牌名已在本机官方包里逐个核过）；
 *   · 存储可能不可用（隐私模式）：localStorage 全部 try-catch，读失败按默认值。
 *
 * ── 四个功能各自的落点 ───────────────────────────────────────────────────────
 *   · 极简模式：隐藏侧栏里除"工作区"以外的块（白名单保留 regionArea / topStrip）；
 *   · 分组折叠：给 `nav[class*="panelList"]` 打 folded 属性；
 *   · 工作区缩写：`[data-row-key^="workspace:"]` 行首插彩色缩写块，**顶替**官方文件夹图标；
 *   · 会话标色：给 `[data-row-key^="session:"]` 行铺底色，入口在会话行的 `...` 菜单里。
 */
window.__ModuleLoader__.load({
	id: 'dsh-sidebar-tidy',
	factory: () => {
		const module = { exports: {} };
		const exports = module.exports;

		const PLUGIN = 'dsh-sidebar-tidy';

		/* ── 与 Host 半边同一份约定（改这里要同步 lib/index.js 的 SELECTORS） ───────── */
		const NAV_BY_CLASS = 'nav[class*="panelList"]';
		const NAV_TEXT_HINTS = ['任务看板', '上下文洞察', '自动化任务', '插件'];

		/* ── 存储键 ─────────────────────────────────────────────────────────────── */
		const STORAGE_KEY = 'dsh.sidebarTidy.folded';
		const ZEN_KEY = 'dsh.sidebarTidy.zen';
		const ABBR_KEY = 'dsh.sidebarTidy.abbr';
		const COLOR_KEY = 'dsh.sidebarTidy.color';
		const MARKS_KEY = 'dsh.sidebarTidy.marks';

		/* ── 注入物上的标记（全带插件前缀，避免和别家撞） ─────────────────────────── */
		const BAR_ATTR = 'data-dsh-tidy-bar';
		const NAV_STATE_ATTR = 'data-dsh-tidy-nav';
		const ZEN_ROOT_ATTR = 'data-dsh-tidy-zen';
		const ZEN_HIDE_ATTR = 'data-dsh-tidy-zen-hide';
		const ZEN_EXIT_ATTR = 'data-dsh-tidy-zen-exit';
		const HIDE_ATTR = 'data-dsh-tidy-hide';
		const MARK_ATTR = 'data-dsh-tidy-mark';
		const TINTED_ATTR = 'data-dsh-tidy-tinted';
		const MENU_ITEM_ATTR = 'data-dsh-tidy-menu-item';
		const PICKER_ATTR = 'data-dsh-tidy-picker';
		const NAV_ID = 'dsh-tidy-nav-target';
		const STYLE_MARK = 'data-plugin';

		/* 12 色：够分，又不至于挑花眼 */
		const PALETTE = ['#e5484d', '#e07b39', '#e0b23a', '#5cc93b', '#2fa36b', '#2f9fd0',
			'#3b6fe0', '#7c5cf0', '#c04fd0', '#d0568f', '#6b7280', '#9aa0a6'];

		/* 内联 SVG —— 不用 `▾`/`⛶` 这类字符：缺字会渲染成方块，读起来像个 tag */
		const SVG_CHEVRON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
			+ '<path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
		const SVG_RESTORE = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
			+ '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/>'
			+ '<path d="M6.25 2.75v10.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
			+ '<path d="M8.9 8h3.3M10.5 6.3 12.2 8l-1.7 1.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

		/* ── 模块内状态（全部在 teardown 里清） ─────────────────────────────────── */
		let styleEl = null;
		let barEl = null;
		let navEl = null;
		let arrowEl = null;
		let labelEl = null;
		let toggleEl = null;
		let bodyObs = null;
		let parentObs = null;
		let observed = null;
		let scheduled = false;
		let disposed = false;
		let pickerEl = null;

		/* ══════════════════════════ 存储 ══════════════════════════ */

		/** 没存过就按"收起"：装这个插件的目的就是把 188px 让出来。 */
		function readFolded() {
			try {
				const v = window.localStorage.getItem(STORAGE_KEY);
				if (v === null) return true;
				return v === '1';
			} catch {
				return true;
			}
		}

		function writeFolded(folded) {
			try { window.localStorage.setItem(STORAGE_KEY, folded ? '1' : '0'); } catch { /* 记不住也当场生效 */ }
		}

		/** 没存过就按"极简"：同上。 */
		function readZen() {
			try {
				const v = window.localStorage.getItem(ZEN_KEY);
				if (v === null) return true;
				return v === '1';
			} catch {
				return true;
			}
		}

		function writeZen(zen) {
			try { window.localStorage.setItem(ZEN_KEY, zen ? '1' : '0'); } catch { /* 同上 */ }
		}

		function readFlag(key, def) {
			try {
				const v = window.localStorage.getItem(key);
				if (v === null) return def;
				return v === '1';
			} catch {
				return def;
			}
		}

		function writeFlag(key, on) {
			try { window.localStorage.setItem(key, on ? '1' : '0'); } catch { /* 同上 */ }
		}

		function readMarks() {
			try {
				const raw = window.localStorage.getItem(MARKS_KEY);
				const obj = raw ? JSON.parse(raw) : {};
				return obj && typeof obj === 'object' ? obj : {};
			} catch {
				return {};
			}
		}

		function writeMark(rowKey, hex) {
			try {
				const marks = readMarks();
				if (hex) marks[rowKey] = hex;
				else delete marks[rowKey];
				window.localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
			} catch { /* 同上 */ }
		}

		/* ══════════════════════════ 定位 ══════════════════════════ */

		function findNav() {
			const byClass = document.querySelector(NAV_BY_CLASS);
			if (byClass) return byClass;
			const navs = document.querySelectorAll('nav');
			for (let i = 0; i < navs.length; i += 1) {
				const text = navs[i].textContent || '';
				for (let k = 0; k < NAV_TEXT_HINTS.length; k += 1) {
					if (text.indexOf(NAV_TEXT_HINTS[k]) >= 0) return navs[i];
				}
			}
			return null;
		}

		/** 侧栏列（容纳 品牌行 / 新会话 / 面板组 / 工作区 / 底部 的那个容器）。 */
		function findRoot(nav) {
			let el = nav && nav.parentElement;
			for (let i = 0; el && i < 6; i += 1, el = el.parentElement) {
				const cls = String(el.className || '');
				if (cls.indexOf('root') >= 0 || cls.indexOf('quietBars') >= 0) return el;
			}
			return nav ? nav.parentElement : null;
		}

		/** 按 `data-row-key` 前缀取行（不用 `^=`，桩与各种环境都稳）。 */
		function rowsByPrefix(prefix) {
			const all = document.querySelectorAll('[data-row-key]');
			const out = [];
			for (let i = 0; i < all.length; i += 1) {
				const k = String(all[i].getAttribute('data-row-key') || '');
				if (k.indexOf(prefix) === 0) out.push(all[i]);
			}
			return out;
		}

		/* ══════════════════════════ 样式 ══════════════════════════ */

		function installStyle() {
			if (styleEl && styleEl.isConnected) return styleEl;
			const old = document.querySelector('style[' + STYLE_MARK + '="' + PLUGIN + '"]');
			if (old) old.remove();

			const css = [
				/* 折叠本体：只作用于 nav 自己，绝不碰父级高度 */
				'nav[' + NAV_STATE_ATTR + '="folded"]{display:none!important}',

				/* ── 标题栏：这组入口的"分组标题"，不是第 6 个入口 ────────────────────
				 * 间距/圆角照官方口径，但排版用分组标题的语言（小字、淡色、加字距）——
				 * 否则会和下面 `插件 / 自动化任务` 长得一模一样，人一眼读成"又一个入口"。 */
				'[' + BAR_ATTR + ']{',
				'  display:flex;align-items:center;gap:2px;align-self:stretch;',
				'  margin:6px 2px 0;padding:0;box-sizing:border-box;',
				'}',
				'[' + BAR_ATTR + '] .dsh-tidy-toggle{',
				'  flex:1 1 0;min-width:0;display:flex;align-items:center;gap:2px;',
				'  height:24px;padding:0 2px;margin:0;box-sizing:border-box;',
				'  border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;',
				'  color:var(--dsw-alias-label-caption,#81858c);',
				'  font:inherit;font-size:.78em;letter-spacing:.02em;line-height:24px;',
				'  cursor:pointer;text-align:left;user-select:none;',
				'  transition:background-color .15s var(--ds-ease-in-out,ease),color .15s var(--ds-ease-in-out,ease);',
				'}',
				'[' + BAR_ATTR + '] .dsh-tidy-toggle:hover{',
				'  background:var(--dsw-alias-interactive-bg-hover);',
				'  color:var(--dsw-alias-label-secondary,#cfd3d6);',
				'}',
				'[' + BAR_ATTR + '] .dsh-tidy-toggle:focus-visible{',
				'  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4c8dff));',
				'  outline-offset:-2px;',
				'}',
				'[' + BAR_ATTR + '] .dsh-tidy-arrow{',
				'  display:inline-flex;align-items:center;justify-content:center;',
				'  width:14px;height:14px;flex:none;',
				'  transition:transform .18s var(--ds-ease-in-out,ease);',
				'}',
				'[' + BAR_ATTR + '][data-folded="1"] .dsh-tidy-arrow{transform:rotate(180deg)}',
				'[' + BAR_ATTR + '] .dsh-tidy-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

				/* 中间两个开关：与两侧等宽（导航 / 缩写 / 标色 / 极简模式 各 25%） */
				'.dsh-tidy-switches{display:flex;align-items:center;justify-content:center;gap:2px;flex:2 1 0;min-width:0}',
				'.dsh-tidy-sw{',
				'  flex:1 1 0;min-width:0;display:inline-flex;align-items:center;justify-content:center;',
				'  height:20px;padding:0 4px;margin:0;box-sizing:border-box;',
				'  border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;',
				'  color:var(--dsw-alias-label-caption,#81858c);',
				'  font:inherit;font-size:.72em;letter-spacing:.04em;line-height:20px;white-space:nowrap;',
				'  cursor:pointer;user-select:none;',
				'  transition:background-color .15s var(--ds-ease-in-out,ease),color .15s var(--ds-ease-in-out,ease),opacity .15s var(--ds-ease-in-out,ease);',
				'}',
				'.dsh-tidy-sw:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary,#cfd3d6)}',
				/* 关掉的开关：更淡 + 删除线（不靠颜色区分，色弱也看得出） */
				'.dsh-tidy-sw[data-on="0"]{opacity:.45;text-decoration:line-through}',
				'.dsh-tidy-sw:focus-visible{',
				'  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4c8dff));',
				'  outline-offset:-2px;',
				'}',

				/* 极简入口：右侧小字 */
				'[' + BAR_ATTR + '] .dsh-tidy-zen{',
				'  flex:1 1 0;min-width:0;display:inline-flex;align-items:center;justify-content:center;',
				'  height:24px;padding:0 6px;margin:0;',
				'  border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;',
				'  color:var(--dsw-alias-label-caption,#81858c);',
				'  font:inherit;font-size:.72em;letter-spacing:.04em;line-height:24px;white-space:nowrap;',
				'  opacity:.85;cursor:pointer;',
				'  transition:background-color .15s var(--ds-ease-in-out,ease),opacity .15s var(--ds-ease-in-out,ease),color .15s var(--ds-ease-in-out,ease);',
				'}',
				'[' + BAR_ATTR + ']:hover .dsh-tidy-zen{opacity:1}',
				'[' + BAR_ATTR + '] .dsh-tidy-zen:hover{',
				'  opacity:1;background:var(--dsw-alias-interactive-bg-hover);',
				'  color:var(--dsw-alias-label-primary,#f9fafb);',
				'}',
				'[' + BAR_ATTR + '] .dsh-tidy-zen:focus-visible{',
				'  opacity:1;outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4c8dff));',
				'  outline-offset:-2px;',
				'}',

				/* 窄条（侧栏整体折叠）时：只留箭头 */
				'[' + BAR_ATTR + '][data-dsh-tidy-rail="1"]{justify-content:center}',
				'[' + BAR_ATTR + '][data-dsh-tidy-rail="1"] .dsh-tidy-label,',
				'[' + BAR_ATTR + '][data-dsh-tidy-rail="1"] .dsh-tidy-switches,',
				'[' + BAR_ATTR + '][data-dsh-tidy-rail="1"] .dsh-tidy-zen{display:none}',
				'[' + BAR_ATTR + '][data-dsh-tidy-rail="1"] .dsh-tidy-toggle{flex:none;padding:0 2px}',

				/* ── 极简模式 ────────────────────────────────────────────────────
				 * 隐藏块由 JS 逐个打 `data-dsh-tidy-zen-hide`（不是 `> [class*=…]` 树选择器：
				 * 类名会变、层级也可能被包一层，属性才稳）。只留 regionArea 与 topStrip。 */
				'[' + ZEN_HIDE_ATTR + ']{display:none!important}',
				'[' + ZEN_EXIT_ATTR + ']{',
				'  display:none;box-sizing:border-box;align-self:stretch;',
				'  min-height:36px;padding:7px 8px;margin:0 2px;margin-top:auto;',
				'  align-items:center;gap:8px;',
				'  font:inherit;line-height:22px;',
				'  color:var(--dsw-alias-label-secondary,#cfd3d6);',
				'  background:0 0;border:none;border-radius:var(--dsw-radius-md,8px);',
				'  cursor:pointer;text-align:left;user-select:none;',
				'  transition:background-color .15s var(--ds-ease-in-out,ease),color .15s var(--ds-ease-in-out,ease);',
				'}',
				'[' + ZEN_ROOT_ATTR + '="1"] [' + ZEN_EXIT_ATTR + ']{display:flex}',
				'[' + ZEN_EXIT_ATTR + '] svg{flex:none}',
				'[' + ZEN_EXIT_ATTR + ']:hover{',
				'  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
				'  color:var(--dsw-alias-label-primary,#f9fafb);',
				'}',

				/* 盖掉官方工作区行的文件夹图标：缩写块顶替它的位置（两个并排太挤） */
				'[' + HIDE_ATTR + ']{display:none!important}',

				/* ── 工作区缩写块 ────────────────────────────────────────────────
				 * 尺寸照同行图标槽（官方 slot 16×20），做 20×20 给 2 个字母留位。 */
				'[' + MARK_ATTR + ']{',
				'  display:inline-flex;align-items:center;justify-content:center;flex:none;',
				'  width:20px;height:20px;margin:0 6px 0 2px;box-sizing:border-box;',
				'  border-radius:var(--dsw-radius-xs,4px);',
				'  font:inherit;font-size:9px;font-weight:600;line-height:1;letter-spacing:0;',
				'  color:#fff;text-transform:uppercase;user-select:none;cursor:pointer;',
				'  box-shadow:inset 0 0 0 1px rgba(0,0,0,.12);',
				'  transition:transform .12s var(--ds-ease-in-out,ease),box-shadow .12s var(--ds-ease-in-out,ease);',
				'}',
				'[' + MARK_ATTR + ']:hover{transform:scale(1.08);box-shadow:inset 0 0 0 1px rgba(0,0,0,.2)}',
				'[' + MARK_ATTR + ']:focus-visible{',
				'  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4c8dff));',
				'  outline-offset:1px;',
				'}',

				/* ── 颜色选择浮层 ────────────────────────────────────────────────
				 * `position:fixed`：侧栏有 overflow 滚动，absolute 会被裁掉。 */
				'[' + PICKER_ATTR + ']{',
				'  position:fixed;z-index:2147483000;width:196px;box-sizing:border-box;',
				'  padding:8px;border-radius:var(--dsw-radius-md,8px);',
				'  background:var(--dsw-specific-menu-fill,var(--dsw-alias-bg-overlay,#2a2a2c));',
				'  color:var(--dsw-alias-label-primary,#f9fafb);',
				'  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));',
				'  box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.28));',
				'  font:inherit;',
				'}',
				'[' + PICKER_ATTR + '] .dsh-tidy-swatches{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}',
				'[' + PICKER_ATTR + '] .dsh-tidy-swatch{',
				'  width:100%;height:20px;border:0;border-radius:var(--dsw-radius-xs,4px);cursor:pointer;padding:0;',
				'  box-shadow:inset 0 0 0 1px rgba(0,0,0,.15);',
				'  transition:transform .12s var(--ds-ease-in-out,ease);',
				'}',
				'[' + PICKER_ATTR + '] .dsh-tidy-swatch:hover{transform:scale(1.12)}',
				'[' + PICKER_ATTR + '] .dsh-tidy-swatch:focus-visible{',
				'  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4c8dff));',
				'  outline-offset:1px;',
				'}',
				'[' + PICKER_ATTR + '] .dsh-tidy-reset{',
				'  display:block;width:100%;margin-top:8px;height:22px;padding:0;',
				'  border:0;border-radius:var(--dsw-radius-xs,4px);background:0 0;',
				'  color:var(--dsw-alias-label-secondary,#cfd3d6);font:inherit;font-size:.85em;',
				'  cursor:pointer;text-align:center;',
				'}',
				'[' + PICKER_ATTR + '] .dsh-tidy-reset:hover{background:var(--dsw-alias-interactive-bg-hover)}',

				/* 插进官方 `...` 菜单的那一项：只补必要样式，外观继承官方菜单项 */
				'[' + MENU_ITEM_ATTR + ']{cursor:pointer}',
			].join('');

			const el = document.createElement('style');
			el.setAttribute(STYLE_MARK, PLUGIN);
			el.textContent = css;
			(document.head || document.documentElement).appendChild(el);
			styleEl = el;
			return el;
		}

		/* ══════════════════════════ 标题栏 ══════════════════════════ */

		function makeSwitch(label, key, title) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'dsh-tidy-sw';
			btn.textContent = label;
			btn.title = title;
			btn.setAttribute('aria-label', title);
			const sync = () => {
				const on = readFlag(key, true);
				btn.setAttribute('aria-pressed', on ? 'true' : 'false');
				btn.setAttribute('data-on', on ? '1' : '0');
			};
			sync();
			btn.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				try {
					writeFlag(key, !readFlag(key, true));
					sync();
					syncWorkspaceMarks();
					syncSessionMarks();
				} catch (e) { console.warn('[dsh-sidebar-tidy] 切换开关失败：', e); }
			});
			return btn;
		}

		function createBar() {
			const bar = document.createElement('div');
			bar.setAttribute(BAR_ATTR, '');
			bar.setAttribute('data-dsh-plugin', PLUGIN);
			bar.setAttribute('data-dsh-part', 'nav-tidy-bar');
			bar.setAttribute('role', 'group');
			bar.setAttribute('aria-label', '导航入口组');

			const toggle = document.createElement('button');
			toggle.type = 'button';
			toggle.className = 'dsh-tidy-toggle';
			toggle.setAttribute('aria-expanded', 'true');
			toggle.title = '收起 / 展开这组导航入口';

			const arrow = document.createElement('span');
			arrow.className = 'dsh-tidy-arrow';
			arrow.setAttribute('aria-hidden', 'true');
			arrow.innerHTML = SVG_CHEVRON;

			const label = document.createElement('span');
			label.className = 'dsh-tidy-label';

			toggle.appendChild(arrow);
			toggle.appendChild(label);
			toggle.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				try {
					const next = !readFolded();
					writeFolded(next);
					syncBar(next);        // 当场生效，不等 observer
					syncNav(next);
				} catch (e) { console.warn('[dsh-sidebar-tidy] 切换折叠失败：', e); }
			});

			const switches = document.createElement('span');
			switches.className = 'dsh-tidy-switches';
			switches.appendChild(makeSwitch('缩写', ABBR_KEY, '工作区缩写：给每个工作区显示彩色缩写块'));
			switches.appendChild(makeSwitch('标色', COLOR_KEY, '颜色标记：给会话行铺底色（入口在会话的 ⋯ 菜单里）'));

			const zenBtn = document.createElement('button');
			zenBtn.type = 'button';
			zenBtn.className = 'dsh-tidy-zen';
			zenBtn.title = '极简模式：只保留工作区（品牌行 / 新会话 / 面板入口 / 设置都收起）';
			zenBtn.setAttribute('aria-label', '极简模式：只保留工作区');
			zenBtn.textContent = '极简模式';
			zenBtn.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				try {
					writeZen(true);
					ensure();
				} catch (e) { console.warn('[dsh-sidebar-tidy] 进入极简失败：', e); }
			});

			bar.appendChild(toggle);
			bar.appendChild(switches);
			bar.appendChild(zenBtn);
			arrowEl = arrow;
			labelEl = label;
			toggleEl = toggle;
			return bar;
		}

		function syncBar(folded) {
			if (!barEl) return;
			const count = navEl ? navEl.children.length : 0;
			// 它是**分组标题**：正常就叫"导航"，收起后补上条数
			// 四等宽后左侧只有 ~60px：收起态用"导航 5"（不带分隔点），否则会被截成"导航…"
			const wantLabel = folded ? '导航' + (count > 0 ? ' ' + count : '') : '导航';
			if (labelEl && labelEl.textContent !== wantLabel) labelEl.textContent = wantLabel;

			const wantExpanded = String(!folded);
			const ariaHost = toggleEl || barEl;
			if (ariaHost.getAttribute('aria-expanded') !== wantExpanded) {
				ariaHost.setAttribute('aria-expanded', wantExpanded);
			}
			const wantFolded = folded ? '1' : '0';
			if (barEl.getAttribute('data-folded') !== wantFolded) {
				barEl.setAttribute('data-folded', wantFolded);
			}
			// 窄条模式：可用宽度小于 ~60px 时只留箭头（不硬编码侧栏宽度）
			try {
				const w = barEl.getBoundingClientRect ? barEl.getBoundingClientRect().width : 0;
				const rail = String(w > 0 && w < 60);
				if (barEl.getAttribute('data-dsh-tidy-rail') !== rail) barEl.setAttribute('data-dsh-tidy-rail', rail);
			} catch { /* 布局还没算出来就跳过 */ }
		}

		function syncNav(folded) {
			if (!navEl) return;
			const want = folded ? 'folded' : 'open';
			if (navEl.getAttribute(NAV_STATE_ATTR) !== want) navEl.setAttribute(NAV_STATE_ATTR, want);
		}

		/* ══════════════════════════ 工作区缩写 ══════════════════════════ */

		function abbrOf(name) {
			const raw = String(name ?? '').trim();
			if (!raw) return '?';
			const cjk = raw.match(/[\u4e00-\u9fa5]/);
			if (cjk) {
				const i = raw.indexOf(cjk[0]);
				return raw.slice(i, i + 1);
			}
			const words = raw.split(/[\s_\-./\\]+/).filter(Boolean);
			if (words.length >= 2) {
				return (words[0][0] + words[words.length - 1][0]).toUpperCase();
			}
			const w = words[0] || raw;
			const caps = w.match(/[A-Z]/g);
			if (caps && caps.length >= 1 && /^[a-z]/.test(w)) return (w[0] + caps[0]).toUpperCase();
			return w[0].toUpperCase();
		}

		function autoColor(key) {
			let h = 0;
			const s = String(key ?? '');
			for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
			return PALETTE[h % PALETTE.length];
		}

		function rowInfo(row) {
			const rowKey = String(row.getAttribute('data-row-key') || '');
			const titleEl = row.querySelector('[class*="title"]') || row.querySelector('[class*="projectText"]');
			const name = String((titleEl && titleEl.textContent) || row.textContent || '').trim();
			return { rowKey, name };
		}

		function syncWorkspaceMarks() {
			const rows = rowsByPrefix('workspace:');
			const show = readFlag(ABBR_KEY, true);
			const marks = readMarks();

			for (let i = 0; i < rows.length; i += 1) {
				const row = rows[i];
				try {
					const folder = row.querySelector('[class*="folder"]');
					let mark = row.querySelector('[' + MARK_ATTR + ']');
					if (!show) {
						if (mark) mark.remove();
						if (folder && folder.getAttribute(HIDE_ATTR) !== null) folder.removeAttribute(HIDE_ATTR);
						continue;
					}
					// 缩写块**顶替**官方文件夹图标（两个并排一行太挤）
					if (folder && folder.getAttribute(HIDE_ATTR) !== '1') folder.setAttribute(HIDE_ATTR, '1');

					const info = rowInfo(row);
					if (!mark) {
						mark = document.createElement('span');
						mark.setAttribute(MARK_ATTR, '');
						mark.setAttribute('role', 'button');
						mark.setAttribute('tabindex', '0');
						// 必须 stopPropagation：行自身 onClick 是"展开/收起分组"
						mark.addEventListener('click', (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							const now = rowInfo(row);      // 点击时重取：行可能被 React 复用
							openPicker(mark, now.rowKey, now.name);
						});
						mark.addEventListener('keydown', (ev) => {
							if (ev.key !== 'Enter' && ev.key !== ' ') return;
							ev.preventDefault();
							ev.stopPropagation();
							const now = rowInfo(row);
							openPicker(mark, now.rowKey, now.name);
						});
						row.insertBefore(mark, row.firstChild);
					}
					const hex = marks[info.rowKey] || autoColor(info.rowKey || info.name);
					if (mark.getAttribute('data-hex') !== hex) {
						mark.setAttribute('data-hex', hex);
						mark.style.background = hex;
					}
					const text = abbrOf(info.name);
					if (mark.textContent !== text) mark.textContent = text;
					mark.setAttribute('title', (info.name || info.rowKey) + '（点一下改颜色）');
				} catch (e) {
					console.warn('[dsh-sidebar-tidy] 工作区缩写失败：', e);
				}
			}
		}

		/* ══════════════════════════ 会话标色 ══════════════════════════ */

		/** hex → 半透明底色。默认**没有颜色**：只有手动标过的会话才上色。 */
		function tintOf(hex) {
			const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''));
			if (!m) return null;
			const n = parseInt(m[1], 16);
			return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', 0.18)';
		}

		/**
		 * 给标过颜色的会话行铺底色。
		 *
		 * 为什么用 `inset box-shadow` 而不是 `background-color`：
		 * 官方行自己用 background 表达 hover / 选中 / 菜单打开（`.sessionRow.menuOpen{background:…}`），
		 * 直接写 background 会把这些状态**盖掉**（选中了看不出来，最容易踩）。
		 * inset 阴影叠在背景**之上**，两者能同时看见。
		 */
		function syncSessionMarks() {
			const rows = rowsByPrefix('session:');
			const show = readFlag(COLOR_KEY, true);
			const marks = readMarks();

			for (let i = 0; i < rows.length; i += 1) {
				const row = rows[i];
				try {
					const rowKey = String(row.getAttribute('data-row-key') || '');
					const tint = show ? tintOf(marks[rowKey]) : null;
					if (tint === null) {
						if (row.getAttribute(TINTED_ATTR) !== null) {
							row.style.removeProperty('box-shadow');
							row.removeAttribute(TINTED_ATTR);
						}
						continue;
					}
					const want = 'inset 0 0 0 9999px ' + tint;
					if (row.style.boxShadow !== want) row.style.boxShadow = want;
					row.setAttribute(TINTED_ATTR, '1');
				} catch (e) {
					console.warn('[dsh-sidebar-tidy] 会话标色失败：', e);
				}
			}
		}

		/* ══════════════════════════ 极简模式 ══════════════════════════ */

		/**
		 * 极简时**保留**哪些块（白名单，其余一律隐藏）。
		 * 白名单而非黑名单：DSH 以后往侧栏加新块，极简模式默认也把它收起来 —— 正是"纯净"的意思。
		 * `topStrip` 必须留：那是 mac 桌面端的窗口拖拽条 + 整体折叠按钮。
		 */
		function keepInZen(child) {
			const cls = String(child.className || '');
			if (cls.indexOf('regionArea') >= 0) return true;
			if (cls.indexOf('topStrip') >= 0) return true;
			if (child.getAttribute(BAR_ATTR) !== null) return true;
			if (child.getAttribute(ZEN_EXIT_ATTR) !== null) return true;
			return false;
		}

		function ensureZenExit(root) {
			if (!root) return null;
			let exit = root.querySelector('[' + ZEN_EXIT_ATTR + ']');
			if (exit) return exit;
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.setAttribute(ZEN_EXIT_ATTR, '');
			btn.setAttribute('data-dsh-plugin', PLUGIN);
			btn.setAttribute('data-dsh-part', 'zen-exit');
			btn.title = '退出极简：把品牌行 / 新会话 / 面板入口 / 设置都放回来';
			btn.innerHTML = SVG_RESTORE + '<span>退出极简</span>';
			btn.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				try {
					writeZen(false);
					ensure();
				} catch (e) { console.warn('[dsh-sidebar-tidy] 退出极简失败：', e); }
			});
			root.appendChild(btn);
			return btn;
		}

		function syncZen(root) {
			if (!root) return;
			const zen = readZen();
			const want = zen ? '1' : '0';
			if (root.getAttribute(ZEN_ROOT_ATTR) !== want) root.setAttribute(ZEN_ROOT_ATTR, want);

			const kids = root.children || [];
			for (let i = 0; i < kids.length; i += 1) {
				const child = kids[i];
				const shouldHide = zen && !keepInZen(child);
				const hidden = child.getAttribute(ZEN_HIDE_ATTR) === '1';
				if (shouldHide && !hidden) child.setAttribute(ZEN_HIDE_ATTR, '1');
				else if (!shouldHide && hidden) child.removeAttribute(ZEN_HIDE_ATTR);
			}
			ensureZenExit(root);
		}

		/* ══════════════════════════ 颜色选择浮层 ══════════════════════════ */

		function onPickerDocDown(ev) {
			if (pickerEl && !pickerEl.contains(ev.target)) closePicker();
		}
		function onPickerEsc(ev) {
			if (ev.key === 'Escape') closePicker();
		}
		function closePicker() {
			try {
				if (pickerEl) { pickerEl.remove(); pickerEl = null; }
				document.removeEventListener('mousedown', onPickerDocDown, true);
				document.removeEventListener('keydown', onPickerEsc, true);
			} catch { /* 关不掉也别抛 */ }
		}

		function openPicker(anchorEl, rowKey, rowName) {
			try {
				closePicker();
				const box = document.createElement('div');
				box.setAttribute(PICKER_ATTR, '');
				box.setAttribute('data-dsh-plugin', PLUGIN);
				box.setAttribute('role', 'dialog');
				box.setAttribute('aria-label', '给「' + (rowName || rowKey) + '」选颜色');

				const grid = document.createElement('div');
				grid.className = 'dsh-tidy-swatches';
				for (let i = 0; i < PALETTE.length; i += 1) {
					const hex = PALETTE[i];
					const sw = document.createElement('button');
					sw.type = 'button';
					sw.className = 'dsh-tidy-swatch';
					sw.style.background = hex;
					sw.setAttribute('aria-label', hex);
					sw.title = hex;
					sw.addEventListener('click', (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						writeMark(rowKey, hex);
						closePicker();
						ensure();
					});
					grid.appendChild(sw);
				}
				box.appendChild(grid);

				const reset = document.createElement('button');
				reset.type = 'button';
				reset.className = 'dsh-tidy-reset';
				reset.textContent = '清除颜色';
				reset.addEventListener('click', (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					writeMark(rowKey, null);
					closePicker();
					ensure();
				});
				box.appendChild(reset);

				// 位置：**优先弹在右边**（菜单与行都在左侧栏，右边空间更富余，也不会盖住菜单）；
				// 右边放不下就翻到左边；两边都不够就贴着视口右缘。垂直方向贴着锚点下沿。
				const r = anchorEl && anchorEl.getBoundingClientRect
					? anchorEl.getBoundingClientRect()
					: { left: 0, right: 0, bottom: 0 };
				const vw = window.innerWidth || 1200;
				const vh = window.innerHeight || 800;
				const w = 196;
				const h = 132;                                  // 12 色 + 清除，约 132px
				const rightEdge = (r.right === undefined ? r.left + (r.width || 0) : r.right) + 8;
				const leftEdge = r.left - w - 8;
				let left = rightEdge;
				if (left + w > vw - 8) left = leftEdge;         // 右边放不下 → 翻到左边
				if (left < 8) left = Math.max(8, vw - w - 8);   // 两边都不够 → 贴右缘
				let top = Math.round((r.bottom || 0) + 6);
				if (top + h > vh - 8) top = Math.max(8, vh - h - 8);   // 下方不够 → 往上收
				box.style.left = Math.round(left) + 'px';
				box.style.top = top + 'px';

				document.body.appendChild(box);
				pickerEl = box;
				document.addEventListener('mousedown', onPickerDocDown, true);
				document.addEventListener('keydown', onPickerEsc, true);
			} catch (e) {
				console.warn('[dsh-sidebar-tidy] 打开颜色选择失败：', e);
			}
		}

		/* ══════════════════════════ 会话菜单里的「标色」 ══════════════════════════
		 * 会话行的 `...` 菜单由官方 primitives 的 Menu 渲染（`portal: true` → 挂到 body），
		 * 它的 `items` 写在官方代码里，改不了 —— 只能等它弹出来后**往里插一项**。
		 * 定位不猜类名：先认 `[role="menu"]`，退化时按菜单项文字找；插进去的节点**复制**
		 * 官方菜单项的 className，所以外观与它们一致、不会看着像外挂。
		 */
		const MENU_TEXTS = ['归档会话', '分叉会话', '复制 Session ID', '重命名', 'Archive', 'Rename'];

		function findOpenMenu() {
			const byRole = document.querySelector('[role="menu"]');
			if (byRole) return byRole;
			const boxes = document.querySelectorAll('div');
			for (let i = 0; i < boxes.length; i += 1) {
				const t = boxes[i].textContent || '';
				if (t.length > 0 && t.length < 400) {
					let hits = 0;
					for (let k = 0; k < MENU_TEXTS.length; k += 1) if (t.indexOf(MENU_TEXTS[k]) >= 0) hits += 1;
					if (hits >= 2) return boxes[i];
				}
			}
			return null;
		}

		/** 当前菜单属于哪条会话：官方在菜单打开时给行加 `menuOpen` 类。 */
		function currentMenuRow() {
			const rows = rowsByPrefix('session:');
			for (let i = 0; i < rows.length; i += 1) {
				if (String(rows[i].className || '').indexOf('menuOpen') >= 0) return rows[i];
			}
			return null;
		}

		function syncSessionMenu() {
			const menu = findOpenMenu();
			if (!menu) return;
			if (menu.querySelector('[' + MENU_ITEM_ATTR + ']')) return;   // 已经插过

			const row = currentMenuRow();
			if (!row) return;
			const info = rowInfo(row);

			// 复制官方菜单项的 className，让新项和它们长得一样
			const proto = menu.querySelector('[role="menuitem"]')
				|| menu.querySelector('button')
				|| menu.firstElementChild;
			const cls = proto ? String(proto.className || '') : '';

			const item = document.createElement('div');
			item.setAttribute(MENU_ITEM_ATTR, '');
			item.setAttribute('role', 'menuitem');
			item.setAttribute('tabindex', '-1');
			if (cls) item.className = cls;
			item.textContent = '标色…';
			item.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				openPicker(item, info.rowKey, info.name);
			});
			// ⚠️ **插在最前面，不要 append 到最后**：菜单贴着屏幕下缘弹出时，
			// 追加在末尾的那一项会落在可视区外（实测"最底下就看不到了"）。
			// 菜单顶部的项永远可见，所以放最前面。
			menu.insertBefore(item, menu.firstChild);
		}

		/* ══════════════════════════ 注入 / 自愈 ══════════════════════════ */

		function ensure() {
			if (disposed) return;
			const nav = findNav();

			if (!nav) {
				// nav 被整个卸载：把它留下的条收掉（留一个孤零零的条最难看）
				if (barEl && !barEl.isConnected) barEl = null;
				if (barEl && navEl && !navEl.isConnected) { barEl.remove(); barEl = null; }
				return;
			}

			const parent = nav.parentElement;
			if (!parent) return;

			if (nav !== navEl) {
				if (barEl && barEl.parentElement !== parent) { barEl.remove(); barEl = null; }
				navEl = nav;
			}
			if (!nav.id) nav.id = NAV_ID;

			// 找/建标题栏：只认**紧跟 nav 之前**的那一个
			let bar = barEl && barEl.isConnected && barEl.parentElement === parent ? barEl : null;
			if (!bar) {
				const strays = document.querySelectorAll('[' + BAR_ATTR + ']');
				for (let i = 0; i < strays.length; i += 1) if (strays[i] !== barEl) strays[i].remove();
				if (barEl && barEl.parentElement !== parent) { barEl.remove(); barEl = null; }
				bar = createBar();
				parent.insertBefore(bar, nav);
				barEl = bar;
			}

			const ctrlHost = toggleEl || bar;
			if (ctrlHost.getAttribute('aria-controls') !== nav.id) ctrlHost.setAttribute('aria-controls', nav.id);

			const folded = readFolded();
			syncNav(folded);
			syncBar(folded);
			syncZen(findRoot(nav));
			syncWorkspaceMarks();
			syncSessionMarks();
			syncSessionMenu();

			observeParent(parent);
		}

		function observeParent(parent) {
			if (parentObs && observed === parent) return;
			if (parentObs) { parentObs.disconnect(); parentObs = null; }
			observed = parent;
			parentObs = new MutationObserver(() => schedule());
			try {
				parentObs.observe(parent, { childList: true });
			} catch {
				parentObs = null;
				observed = null;
			}
		}

		function schedule() {
			if (scheduled || disposed) return;
			scheduled = true;
			const raf = typeof requestAnimationFrame === 'function'
				? requestAnimationFrame
				: (fn) => setTimeout(fn, 16);
			raf(() => {
				scheduled = false;
				try { ensure(); } catch (e) { console.warn('[dsh-sidebar-tidy] 自愈失败：', e); }
			});
		}

		function teardown() {
			disposed = true;
			try {
				if (bodyObs) { bodyObs.disconnect(); bodyObs = null; }
				if (parentObs) { parentObs.disconnect(); parentObs = null; }
				observed = null;
				closePicker();
				if (barEl) { barEl.remove(); barEl = null; }

				if (navEl) {
					const root = navEl.parentElement;
					navEl.removeAttribute(NAV_STATE_ATTR);
					if (navEl.id === NAV_ID) navEl.removeAttribute('id');
					if (root) {
						root.removeAttribute(ZEN_ROOT_ATTR);
						const kids = root.children || [];
						for (let i = 0; i < kids.length; i += 1) kids[i].removeAttribute(ZEN_HIDE_ATTR);
						const exit = root.querySelector('[' + ZEN_EXIT_ATTR + ']');
						if (exit) exit.remove();
					}
				}
				navEl = null;

				const marks = document.querySelectorAll('[' + MARK_ATTR + ']');
				for (let i = 0; i < marks.length; i += 1) marks[i].remove();
				const hidden = document.querySelectorAll('[' + HIDE_ATTR + ']');
				for (let i = 0; i < hidden.length; i += 1) hidden[i].removeAttribute(HIDE_ATTR);
				const tinted = document.querySelectorAll('[' + TINTED_ATTR + ']');
				for (let i = 0; i < tinted.length; i += 1) {
					tinted[i].style.removeProperty('box-shadow');
					tinted[i].removeAttribute(TINTED_ATTR);
				}
				const menuItems = document.querySelectorAll('[' + MENU_ITEM_ATTR + ']');
				for (let i = 0; i < menuItems.length; i += 1) menuItems[i].remove();

				arrowEl = null;
				labelEl = null;
				toggleEl = null;

				if (styleEl) { styleEl.remove(); styleEl = null; }
				else {
					const stale = document.querySelector('style[' + STYLE_MARK + '="' + PLUGIN + '"]');
					if (stale) stale.remove();
				}
				delete window.__dshSidebarTidy;
			} catch (e) {
				console.warn('[dsh-sidebar-tidy] 卸载时出错（已忽略）：', e);
			}
		}

		/* ══════════════════════════ 入口（绝不 throw） ══════════════════════════ */

		function apply(ctx) {
			if (typeof document === 'undefined') return;
			try {
				if (document.querySelector('[' + BAR_ATTR + ']')) {
					console.warn('[dsh-sidebar-tidy] 标题栏已存在，跳过重复注入');
					window.__dshSidebarTidy = {
						toggle: () => { writeFolded(!readFolded()); ensure(); },
						version: '0.1.0',
						plugin: PLUGIN,
					};
					return;
				}
				disposed = false;
				installStyle();
				ensure();

				bodyObs = new MutationObserver(() => schedule());
				bodyObs.observe(document.body, { childList: true, subtree: true });

				window.__dshSidebarTidy = {
					toggle: () => { writeFolded(!readFolded()); ensure(); },
					status: () => ({
						plugin: PLUGIN,
						found: Boolean(findNav()),
						folded: readFolded(),
						zen: readZen(),
						abbr: readFlag(ABBR_KEY, true),
						color: readFlag(COLOR_KEY, true),
						items: navEl ? navEl.children.length : 0,
						barMounted: Boolean(barEl && barEl.isConnected),
					}),
					version: '0.1.0',
				};

				if (ctx && typeof ctx.effect === 'function') {
					ctx.effect(() => teardown, 'dsh-sidebar-tidy:dom');
				}
			} catch (e) {
				// 这里绝不能抛：Client apply 抛错会让整个 Web 壳起不来
				console.warn('[dsh-sidebar-tidy] 挂载失败（侧栏精简不可用，其它功能不受影响）：', e);
			}
		}

		exports.name = PLUGIN;
		exports.inject = [];
		exports.apply = apply;
		return module.exports;
	},
});
