/* Regression proof for dsh-sidebar-nav-scroll's browser half (v2 rewrite).
 *
 * The DOM replica mirrors the real host sidebar structure (test/fixtures/sidebar.css
 * + the React tree of @deepseek-ai/dsh-client-ui-sidebar):
 *
 *   div.frame[data-sidebar-collapsed]
 *     div.root                       (.wtg9ga_root — flex column, height 100%)
 *       div.logoRow
 *       button.newSession
 *       nav.panelList               (.wtg9ga_panelList — flex:none, gap 2px)
 *         button.panelRow ...       (one per panel + the host's 更多 button)
 *       div.regionArea              (.wtg9ga_regionArea — flex:1, min-height:0)
 *       div.footArea
 *
 * jsdom has no layout engine, so the row heights and the row-gap are stubbed per case;
 * everything else (attribute wiring, custom-property cascade, collapse guard, teardown,
 * settings resolution) is exercised for real.
 *
 * Run: npm test
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const CLIENT = path.resolve(__dirname, '..', 'client.js');
const HOST_CSS = path.resolve(__dirname, 'fixtures', 'sidebar.css');
const clientSrc = fs.readFileSync(CLIENT, 'utf8');
const hostCss = fs.readFileSync(HOST_CSS, 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${actual} expected=${expected}`);
}

/**
 * @param {{rows?:number, rowHeight?:number, gap?:string, collapsed?:boolean,
 *          quietBars?:boolean, listClass?:string, rowClass?:string}} spec
 */
function makeDom(spec) {
  spec = Object.assign({ rows: 8, rowHeight: 36, gap: '2px', listClass: 'wtg9ga_panelList', rowClass: 'wtg9ga_panelRow' }, spec);
  const rowHtml = Array.from(
    { length: spec.rows },
    (_, i) => `<button class="${spec.rowClass}"><span class="wtg9ga_panelGlyph"></span><span class="wtg9ga_panelTitle">${i}</span></button>`,
  ).join('');
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${hostCss}</style></head><body>
      <div class="mP3x-q_frame"${spec.collapsed ? ' data-sidebar-collapsed=""' : ''}>
        <div class="wtg9ga_root${spec.quietBars ? ' wtg9ga_quietBars' : ''}">
          <div class="wtg9ga_logoRow"></div>
          <button class="wtg9ga_newSession"></button>
          <nav class="${spec.listClass}" aria-label="全局面板">${rowHtml}</nav>
          <div class="wtg9ga_regionArea"></div>
          <div class="wtg9ga_footArea"></div>
        </div>
      </div>
    </body></html>`,
    { pretendToBeVisual: true, runScripts: 'outside-only', url: 'http://localhost/' },
  );
  const { window } = dom;

  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // Stub the layout jsdom does not compute: every row reports rowHeight.
  const rows = window.document.querySelectorAll(`.${spec.rowClass}`);
  rows.forEach((row) => {
    Object.defineProperty(row, 'offsetHeight', { value: spec.rowHeight, configurable: true });
    row.getBoundingClientRect = () => ({ height: spec.rowHeight, width: 100, top: 0, left: 0, right: 100, bottom: spec.rowHeight });
  });

  const origGetComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (el, pseudo) => {
    const s = origGetComputedStyle(el, pseudo);
    return new Proxy(s, {
      get(t, k) {
        if (k === 'rowGap') return spec.gap;
        if (k === 'gap') return spec.gap;
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  };
  return { window, nav: window.document.querySelector('nav'), rows };
}

/** Load the client bundle against one window, then apply the plugin. */
function run(spec, config) {
  const { window, nav, rows } = makeDom(spec);
  let registered = null;
  window.__ModuleLoader__ = { load: (entry) => { registered = entry; } };
  window.eval(clientSrc);

  check('module id registered', registered && registered.id, 'dsh-sidebar-nav-scroll');
  const exports = registered.factory(() => { throw new Error('unexpected require'); });
  check('inject list', JSON.stringify(exports.inject), '[]');

  const ctx = { logger: { error() {}, warn() {} } };
  const teardown = exports.apply(ctx, config);
  return { window, nav, rows, teardown, exports };
}

function tick(ms = 400) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  // --- Case 1: 8 rows @36px, gap 2 -> natural 302, fraction 0.5 -> cap 151
  {
    const { window, nav, teardown } = run({ rows: 8 });
    await tick();
    const cap = nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap');
    check('case1 cap custom property', cap, '151px');
    check('case1 state attribute', nav.getAttribute('data-dsh-sidebar-nav-scroll-state'), 'capped');
    check('case1 mark attribute', nav.getAttribute('data-dsh-sidebar-nav-scroll'), 'dsh-sidebar-nav-scroll');
    check('case1 sheet injected', !!window.document.getElementById('dsh-sidebar-nav-scroll'), 'true');
    const sheet = window.document.getElementById('dsh-sidebar-nav-scroll').textContent;
    check('case1 overflow rule', /overflow-y:\s*auto\s*!important/.test(sheet), 'true');
    check('case1 thumb token', /--dsh-scrollbar-thumb:\s*var\(--dsw-alias-scrollbar-bg-l2\)/.test(sheet), 'true');
    check('case1 collapse guard', /\[data-sidebar-collapsed\] \[data-dsh-sidebar-nav-scroll\]/.test(sheet), 'true');
    const cs = window.getComputedStyle(nav);
    check('case1 computed overflow-y', cs.overflowY, 'auto');
    check('case1 computed overflow-x', cs.overflowX, 'hidden');
    // jsdom does not resolve var() references, so assert the rule keeps the custom
    // property as the cap source and that the property carries the value.
    check('case1 max-height uses the custom property', /var\(--dsh-sidebar-nav-scroll-cap/.test(cs.maxHeight), 'true');
    check('case1 custom property value', cs.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '151px');
    check('case1 status rows', window.__DSH_SIDEBAR_SCROLL__.status().rows, 8);
    check('case1 status natural', window.__DSH_SIDEBAR_SCROLL__.status().naturalHeight, 302);
    teardown();
    check('case1 teardown mark', nav.hasAttribute('data-dsh-sidebar-nav-scroll'), 'false');
    check('case1 teardown state', nav.hasAttribute('data-dsh-sidebar-nav-scroll-state'), 'false');
    check('case1 teardown custom property', nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '');
    check('case1 teardown sheet', !!window.document.getElementById('dsh-sidebar-nav-scroll'), 'false');
    check('case1 teardown api', typeof window.__DSH_SIDEBAR_SCROLL__, 'undefined');
  }

  // --- Case 2: short list (2 rows -> natural 74, half 37 < floor 74) -> no cap
  {
    const { window, nav } = run({ rows: 2 });
    await tick();
    check('case2 no cap on short list', nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '');
    check('case2 state full', nav.getAttribute('data-dsh-sidebar-nav-scroll-state'), 'full');
  }

  // --- Case 3: minRows floor wins (3 rows natural 110, fraction 0.05 -> 6px, floor 74)
  {
    const { window, nav } = run({ rows: 3 }, { fraction: 0.05, minRows: 2 });
    await tick();
    check('case3 floor applied', nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '74px');
  }

  // --- Case 4: collapsed rail -> no cap, but still marked
  {
    const { window, nav } = run({ rows: 8, collapsed: true });
    await tick();
    check('case4 collapsed no cap', nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '');
    check('case4 still marked', nav.getAttribute('data-dsh-sidebar-nav-scroll'), 'dsh-sidebar-nav-scroll');
    check('case4 status collapsed', window.__DSH_SIDEBAR_SCROLL__.status().collapsed, 'true');
  }

  // --- Case 5: enabled:false -> nothing happens
  {
    const { window, nav } = run({ rows: 8 }, { enabled: false });
    await tick();
    check('case5 disabled mark', nav.hasAttribute('data-dsh-sidebar-nav-scroll'), 'false');
    check('case5 disabled style', !!window.document.getElementById('dsh-sidebar-nav-scroll'), 'false');
  }

  // --- Case 6: custom fraction 0.4 on 10 rows (natural 380) -> 152
  {
    const { window, nav } = run({ rows: 10 }, { fraction: 0.4 });
    await tick();
    check('case6 fraction 0.4', nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '151px');
  }

  // --- Case 7: rows added later -> MutationObserver re-caps
  {
    const { window, nav } = run({ rows: 4 });
    await tick();
    check('case7 initial cap', nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '75px');
    for (let i = 0; i < 4; i++) {
      const b = window.document.createElement('button');
      b.className = 'wtg9ga_panelRow';
      b.getBoundingClientRect = () => ({ height: 36 });
      nav.append(b);
    }
    await tick();
    check('case7 recapped after rows added', nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '151px');
  }

  // --- Case 8: the list is found through its rows, not its CSS-module class
  {
    const { window, nav } = run({ rows: 8, listClass: 'zzz_unknownList' });
    await tick();
    check('case8 found list by rows', nav.getAttribute('data-dsh-sidebar-nav-scroll'), 'dsh-sidebar-nav-scroll');
    check('case8 capped', nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '151px');
  }

  // --- Case 9: remount after the sidebar appears later
  {
    const { window, nav } = run({ rows: 8 });
    const root = window.document.querySelector('.wtg9ga_root');
    nav.remove();
    await tick(100);
    check('case9 nothing while unmounted', window.document.querySelector('[data-dsh-sidebar-nav-scroll]'), null);
    const fresh = window.document.createElement('nav');
    fresh.className = 'wtg9ga_panelList';
    for (let i = 0; i < 8; i++) {
      const b = window.document.createElement('button');
      b.className = 'wtg9ga_panelRow';
      b.getBoundingClientRect = () => ({ height: 36 });
      fresh.append(b);
    }
    root.append(fresh);
    await tick(900);
    check('case9 caps after remount', fresh.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '151px');
  }

  // --- Case 10: localStorage settings win over the config argument
  {
    const { window } = run({ rows: 8 }, { fraction: 0.5 });
    window.localStorage.setItem('dsh-sidebar-nav-scroll', JSON.stringify({ fraction: 0.25 }));
    window.__DSH_SIDEBAR_SCROLL__.set({});
    await tick();
    check('case10 storage wins', window.__DSH_SIDEBAR_SCROLL__.get().fraction, 0.25);
    check('case10 cap follows storage', window.__DSH_SIDEBAR_SCROLL__.status().capHeight, 76);
    window.__DSH_SIDEBAR_SCROLL__.reset();
    await tick();
    check('case10 reset restores default', window.__DSH_SIDEBAR_SCROLL__.get().fraction, 0.5);
    check('case10 storage cleared', window.localStorage.getItem('dsh-sidebar-nav-scroll'), null);
  }

  // --- Case 11: console API set() applies immediately
  {
    const { window } = run({ rows: 8 });
    await tick();
    window.__DSH_SIDEBAR_SCROLL__.set({ fraction: 0.75 });
    await tick();
    check('case11 cap follows set()', window.__DSH_SIDEBAR_SCROLL__.status().capHeight, 227);
    check('case11 get() reflects set()', window.__DSH_SIDEBAR_SCROLL__.get().fraction, 0.75);
  }

  // --- Case 12: enabled:false through storage disables the cap
  {
    const { window, nav } = run({ rows: 8 });
    window.localStorage.setItem('dsh-sidebar-nav-scroll', JSON.stringify({ enabled: false }));
    window.__DSH_SIDEBAR_SCROLL__.set({});
    await tick();
    check('case12 disabled clears cap', nav.style.getPropertyValue('--dsh-sidebar-nav-scroll-cap'), '');
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
