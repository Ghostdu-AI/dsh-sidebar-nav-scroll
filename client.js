/*
 * dsh-sidebar-nav-scroll — browser half.
 *
 * Caps the DSH sidebar's global panel list (插件 / 插件市场 / 归档会话 / 自动化任务 /
 * IM机器人 / Worktree Space / 记忆系统 / 更多) to a fraction of its natural height and
 * scrolls whatever no longer fits. The sidebar column is a flex box in which the panel
 * list is `flex: none` and the workspace area below it is `flex: 1`, so shrinking the
 * list hands the freed height straight to the workspace area — no layout hack needed.
 *
 * The cap is measured from the rendered rows instead of being hard-coded, so a host
 * restyle cannot silently break it, and the natural height is recomputed from the rows
 * themselves (never from `scrollHeight`) so applying the cap cannot feed back into the
 * measurement.
 *
 * The visible cap lives in the injected stylesheet, driven by one custom property, so
 * the "collapsed rail" guard can always win over the inline value.
 *
 * Settings live in the browser: `localStorage["dsh-sidebar-nav-scroll"]` holds
 * `{ "fraction": 0.5, "minRows": 2, "enabled": true }`, and the console API
 * `window.__DSH_SIDEBAR_SCROLL__` exposes `get()`, `set(patch)`, `reset()` and
 * `status()`. The host-side patch row cannot carry these values into the browser, so
 * the browser half owns its configuration (see README.md).
 *
 * That configuration is reachable from the UI: the plugin registers a card in the
 * 插件 page's `plugins.bundle.config` slot, keyed by its package name, so the row in
 * 已安装插件 opens a page with the same three settings. The card writes the same
 * localStorage key and announces the change in-process, so the cap follows the
 * control immediately instead of waiting for a reload.
 */
(function () {
  'use strict';

  var MARK = 'dsh-sidebar-nav-scroll';
  var STYLE_ID = 'dsh-sidebar-nav-scroll';
  var STORAGE_KEY = 'dsh-sidebar-nav-scroll';
  var CONSOLE_API = '__DSH_SIDEBAR_SCROLL__';
  var ATTR = 'data-dsh-sidebar-nav-scroll';
  var ATTR_STATE = 'data-dsh-sidebar-nav-scroll-state';
  var STATE_CAPPED = 'capped';
  var STATE_FULL = 'full';

  var DEFAULTS = { fraction: 0.5, minRows: 2, enabled: true };
  var MIN_FRACTION = 0.05;
  var MAX_FRACTION = 1;
  var ATTACH_MS = 250;
  var WATCH_MS = 1000;

  /* The 插件 page hands a bundle its own form through this slot, keyed by package
   * name; it is the one place a user can reach these settings without the console. */
  var PACKAGE_NAME = 'dsh-sidebar-nav-scroll';
  var CONFIG_SLOT = 'plugins.bundle.config';
  var CHANGE_EVENT = 'dsh-sidebar-nav-scroll:settings';
  var CARD_STYLE_ID = 'dsh-sidebar-nav-scroll-card';

  var SHEET_TEXT = [
    '/* dsh-sidebar-nav-scroll */',
    '[' + ATTR + '] {',
    '  --dsh-sidebar-nav-scroll-cap: none;',
    '}',
    '[' + ATTR + '][' + ATTR_STATE + '="' + STATE_CAPPED + '"] {',
    '  max-height: var(--dsh-sidebar-nav-scroll-cap, none);',
    '  overflow-y: auto !important;',
    '  overflow-x: hidden !important;',
    '  overscroll-behavior: contain;',
    '  scrollbar-gutter: stable;',
    '  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);',
    '  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);',
    '}',
    '[' + ATTR + '][' + ATTR_STATE + '="' + STATE_CAPPED + '"] > * {',
    '  flex-shrink: 0;',
    '}',
    '/* The collapsed rail has no room for a capped list; never fight the host there. */',
    '[data-sidebar-collapsed] [' + ATTR + '],',
    '[class*="collapsed"] [' + ATTR + '] {',
    '  max-height: none !important;',
    '  overflow-y: visible !important;',
    '  overflow-x: visible !important;',
    '  scrollbar-gutter: auto !important;',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  function clampFraction(value) {
    var n = Number(value);
    if (!isFinite(n)) return DEFAULTS.fraction;
    if (n < MIN_FRACTION) return MIN_FRACTION;
    if (n > MAX_FRACTION) return MAX_FRACTION;
    return n;
  }

  function clampRows(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function readStored() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function writeStored(patch) {
    var next = {};
    var stored = readStored();
    if (stored) {
      for (var key in stored) {
        if (Object.prototype.hasOwnProperty.call(stored, key)) next[key] = stored[key];
      }
    }
    if (patch && typeof patch === 'object') {
      for (var pkey in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, pkey)) next[pkey] = patch[pkey];
      }
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      /* storage unavailable — keep the in-memory value */
    }
    announce();
    return next;
  }

  function clearStored() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      /* ignore */
    }
    announce();
  }

  /**
   * Tell this page that the stored settings moved.
   * The browser fires `storage` only in OTHER documents, so the card and the cap
   * inside one window would otherwise not see each other's writes.
   */
  function announce() {
    try {
      window.dispatchEvent(new window.Event(CHANGE_EVENT));
    } catch (error) {
      /* an environment without Event still keeps the stored value */
    }
  }

  function normalize(raw) {
    return {
      fraction: clampFraction(raw.fraction),
      minRows: clampRows(raw.minRows),
      enabled: raw.enabled !== false
    };
  }

  /**
   * Resolve the effective settings.
   * Priority: browser storage > config handed to the plugin > built-in defaults.
   */
  function resolveSettings(rawConfig) {
    var base = {
      fraction: DEFAULTS.fraction,
      minRows: DEFAULTS.minRows,
      enabled: DEFAULTS.enabled
    };
    if (rawConfig && typeof rawConfig === 'object') {
      if (typeof rawConfig.fraction === 'number') base.fraction = rawConfig.fraction;
      if (typeof rawConfig.minRows === 'number') base.minRows = rawConfig.minRows;
      if (typeof rawConfig.enabled === 'boolean') base.enabled = rawConfig.enabled;
    }
    var stored = readStored();
    if (stored) {
      if (typeof stored.fraction === 'number') base.fraction = stored.fraction;
      if (typeof stored.minRows === 'number') base.minRows = stored.minRows;
      if (typeof stored.enabled === 'boolean') base.enabled = stored.enabled;
    }
    return normalize(base);
  }

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */

  function hasClassFragment(className, fragment) {
    if (typeof className !== 'string') return false;
    return new RegExp('(^|[\\s_-])' + fragment + '(\\b|$)', 'i').test(className);
  }

  /** The host marks the collapsed rail on the app frame and on the sidebar root. */
  function isCollapsed(list) {
    if (!list) return false;
    if (list.closest && list.closest('[data-sidebar-collapsed]')) return true;
    var node = list.parentElement;
    while (node) {
      if (node.getAttribute && node.getAttribute('data-sidebar-collapsed') !== null) return true;
      if (hasClassFragment(node.className, 'collapsed')) return true;
      node = node.parentElement;
    }
    return false;
  }

  /**
   * Locate the global panel list.
   * The host renders it as a <nav> that owns one button per panel; the buttons carry
   * the `panelRow` class, so the list is the closest <nav> of any panel row. The class
   * name of the list itself is CSS-module generated and may change between host
   * releases, so it is only used as a fallback.
   */
  function findPanelList() {
    var rows = document.querySelectorAll('[class*="panelRow"]');
    var i;
    for (i = 0; i < rows.length; i++) {
      var nav = rows[i].closest ? rows[i].closest('nav') : null;
      if (nav) return nav;
    }
    var navs = document.querySelectorAll('nav');
    for (i = 0; i < navs.length; i++) {
      if (hasClassFragment(navs[i].className, 'panelList')) return navs[i];
    }
    return null;
  }

  function rowGapOf(list) {
    var gap = 0;
    try {
      var style = window.getComputedStyle(list);
      if (style) {
        var parsed = parseFloat(style.rowGap);
        if (!isFinite(parsed)) parsed = parseFloat(style.gap);
        if (isFinite(parsed)) gap = parsed;
      }
    } catch (error) {
      gap = 0;
    }
    return gap < 0 ? 0 : gap;
  }

  /**
   * Measure the rendered rows.
   * `natural` is the height the list would take without a cap. It is derived from the
   * rows themselves, so it stays correct while the cap is already applied.
   */
  function measureRows(list) {
    var heights = [];
    var children = list ? list.children : [];
    var i;
    for (i = 0; i < children.length; i++) {
      var child = children[i];
      if (!child || child.nodeType !== 1) continue;
      var height = 0;
      try {
        var rect = child.getBoundingClientRect();
        if (rect && rect.height) height = rect.height;
      } catch (error) {
        height = 0;
      }
      if (!height) height = child.offsetHeight || 0;
      if (height > 0) heights.push(height);
    }
    var gap = rowGapOf(list);
    var natural = 0;
    var rowHeight = 0;
    for (i = 0; i < heights.length; i++) {
      natural += heights[i];
      if (heights[i] > rowHeight) rowHeight = heights[i];
    }
    natural += gap * Math.max(0, heights.length - 1);
    return {
      count: heights.length,
      natural: Math.ceil(natural),
      rowHeight: Math.ceil(rowHeight),
      gap: gap
    };
  }

  /** The cap for the current rows and settings; 0 means "no cap needed". */
  function computeCap(metrics, settings) {
    if (!metrics || !metrics.count || !metrics.natural) return 0;
    var cap = Math.round(metrics.natural * settings.fraction);
    if (settings.minRows > 0 && metrics.rowHeight > 0) {
      var floor = settings.minRows * metrics.rowHeight + Math.max(0, settings.minRows - 1) * metrics.gap;
      if (cap < floor) cap = Math.ceil(floor);
    }
    if (cap >= metrics.natural) return 0;
    return cap;
  }

  function ensureSheet() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-plugin', MARK);
    style.textContent = SHEET_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeSheet() {
    var style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  /* ------------------------------------------------------------------ *
   * The settings card the 插件 page renders
   * ------------------------------------------------------------------ */

  var CARD_TEXT = {
    title: '面板列表限高',
    intro: '限制侧边栏「全局面板」列表的高度，并在超出的部分加滚动条；省下的高度交给下方的工作区。改动立即生效。',
    fraction: '高度上限（占自然高度的比例）',
    fractionHint: '0.05 – 1。例如 0.5 表示列表最多占自然高度的一半。',
    minRows: '至少保留几行',
    minRowsHint: '滚动区至少容纳的完整行数，0 表示不限制。',
    enabled: '启用限高',
    reset: '恢复默认',
    saved: '已保存',
    unsupported: '这个版本的面板没有提供插件配置槽位，设置只能在控制台里调整。'
  };

  var CARD_CSS = [
    '.dsh-sns-card{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#1f1f1f)}',
    '.dsh-sns-intro{margin:0;color:var(--dsw-alias-label-secondary,#666)}',
    '.dsh-sns-field{display:flex;flex-direction:column;gap:6px}',
    '.dsh-sns-field-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
    '.dsh-sns-label{font-weight:500}',
    '.dsh-sns-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#666)}',
    '.dsh-sns-range{width:100%;margin:0;accent-color:var(--dsw-alias-brand-primary,#4176e6)}',
    '.dsh-sns-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#888)}',
    '.dsh-sns-row{display:flex;align-items:center;justify-content:space-between;gap:10px}',
    '.dsh-sns-number{box-sizing:border-box;flex:0 0 auto;width:72px;height:30px;padding:0 8px;font:inherit;color:inherit;text-align:center;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px}',
    '.dsh-sns-number:focus{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:1px}',
    '.dsh-sns-check{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}',
    '.dsh-sns-check input{flex:0 0 auto;width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4176e6)}',
    '.dsh-sns-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:26px;margin-top:2px}',
    '.dsh-sns-status{margin:0;font-size:12px;color:var(--dsw-alias-state-success-primary,#2f8f4e)}',
    '.dsh-sns-reset{flex:0 0 auto;margin-left:auto;padding:4px 10px;font:inherit;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px}',
    '.dsh-sns-reset:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}'
  ].join('\n');

  function ensureCardSheet() {
    if (document.getElementById(CARD_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = CARD_STYLE_ID;
    style.setAttribute('data-plugin', MARK);
    style.textContent = CARD_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeCardSheet() {
    var style = document.getElementById(CARD_STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  /**
   * Build the settings card.
   * The 插件 page renders a bundle's form through `plugins.bundle.config`, keyed by
   * the package name; it draws its own title and crumb, so this card is only the
   * controls. It writes the same storage key the cap reads and announces the change,
   * so the cap moves with the control.
   */
  function buildConfigCard(react) {
    var h = react.createElement;

    return function SidebarNavScrollCard(props) {
      var stored = react.useState(function () {
        return resolveSettings();
      });
      var settings = stored[0];
      var setSettings = stored[1];
      var saved = react.useState(false);
      var setSaved = saved[1];

      react.useEffect(function () {
        ensureCardSheet();
        function sync() {
          setSettings(resolveSettings());
        }
        window.addEventListener(CHANGE_EVENT, sync);
        window.addEventListener('storage', sync);
        return function () {
          window.removeEventListener(CHANGE_EVENT, sync);
          window.removeEventListener('storage', sync);
          removeCardSheet();
        };
      }, []);

      function commit(patch) {
        writeStored(patch);
        setSettings(resolveSettings());
        setSaved(true);
      }

      function onFraction(event) {
        var next = Number(event.target.value);
        if (!isFinite(next)) return;
        commit({ fraction: Math.round(clampFraction(next / 100) * 100) / 100 });
      }

      function onMinRows(event) {
        var next = Number(event.target.value);
        if (!isFinite(next)) return;
        commit({ minRows: clampRows(next) });
      }

      function onEnabled(event) {
        commit({ enabled: event.target.checked });
      }

      function onReset() {
        clearStored();
        setSettings(resolveSettings());
      }

      var percent = Math.round(settings.fraction * 100);

      return h(
        'div',
        { className: 'dsh-sns-card', 'data-dsh-sidebar-nav-scroll-card': '' },
        h('p', { className: 'dsh-sns-intro' }, CARD_TEXT.intro),
        h(
          'div',
          { className: 'dsh-sns-field' },
          h(
            'div',
            { className: 'dsh-sns-field-head' },
            h('span', { className: 'dsh-sns-label' }, CARD_TEXT.fraction),
            h('span', { className: 'dsh-sns-value' }, percent + '%')
          ),
          h('input', {
            className: 'dsh-sns-range',
            type: 'range',
            min: '5',
            max: '100',
            step: '5',
            value: String(percent),
            'aria-label': CARD_TEXT.fraction,
            onChange: onFraction
          }),
          h('p', { className: 'dsh-sns-hint' }, CARD_TEXT.fractionHint)
        ),
        h(
          'div',
          { className: 'dsh-sns-field' },
          h(
            'div',
            { className: 'dsh-sns-row' },
            h('span', { className: 'dsh-sns-label' }, CARD_TEXT.minRows),
            h('input', {
              className: 'dsh-sns-number',
              type: 'number',
              min: '0',
              step: '1',
              value: String(settings.minRows),
              'aria-label': CARD_TEXT.minRows,
              onChange: onMinRows
            })
          ),
          h('p', { className: 'dsh-sns-hint' }, CARD_TEXT.minRowsHint)
        ),
        h(
          'div',
          { className: 'dsh-sns-row' },
          h(
            'label',
            { className: 'dsh-sns-check' },
            h('input', {
              type: 'checkbox',
              checked: settings.enabled,
              onChange: onEnabled
            }),
            h('span', null, CARD_TEXT.enabled)
          )
        ),
        h(
          'div',
          { className: 'dsh-sns-foot' },
          h(
            'p',
            { className: 'dsh-sns-status', role: 'status' },
            saved[0] ? CARD_TEXT.saved : ''
          ),
          h(
            'button',
            { type: 'button', className: 'dsh-sns-reset', onClick: onReset },
            CARD_TEXT.reset
          )
        )
      );
    };
  }

  /**
   * Register the card in the 插件 page.
   * The page's slot exists only while that page is mounted, so the registration
   * waits for the slot through `slots.inject`, exactly like the shipped plugins do.
   */
  function registerConfigCard(ctx, requireFn) {
    /* Reaching for an undeclared service throws in cordis, so `slots` rides a
     * scoped inject of its own: the closure runs where the service exists and
     * never runs where it does not. */
    if (!ctx || typeof ctx.inject !== 'function' || typeof requireFn !== 'function') return null;
    var disposer = null;
    try {
      ctx.inject(['slots'], function (scope) {
        var slots = scope.slots;
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
        var react = null;
        try {
          react = requireFn('react');
        } catch (error) {
          return;
        }
        if (!react || typeof react.createElement !== 'function') return;
        var Card = buildConfigCard(react);
        var options = { name: CONFIG_SLOT, key: PACKAGE_NAME };
        disposer = slots.inject(CONFIG_SLOT, function () {
          return slots.register(options, Card);
        });
      });
    } catch (error) {
      return null;
    }
    return function () {
      if (typeof disposer === 'function') {
        try {
          disposer();
        } catch (error) {
          /* the registration is already gone */
        }
      }
      disposer = null;
    };
  }

  /* ------------------------------------------------------------------ *
   * Plugin
   * ------------------------------------------------------------------ */

  function apply(ctx, rawConfig) {
    var settings = resolveSettings(rawConfig);
    var boundList = null;
    var resizeObserver = null;
    var mutationObserver = null;
    var collapseObserver = null;
    var attachTimer = null;
    var watchTimer = null;
    var frame = null;
    var lastCap = 0;
    var lastNatural = 0;
    var lastCount = 0;
    var lastCollapsed = null;
    var disposed = false;

    function refreshSettings() {
      settings = resolveSettings(rawConfig);
      schedule();
      return api.get();
    }

    function schedule() {
      if (disposed || frame !== null) return;
      var raf = window.requestAnimationFrame || function (fn) { return window.setTimeout(fn, 16); };
      frame = raf(function () {
        frame = null;
        sync();
      });
    }

    function clearCap(list) {
      if (!list) return;
      list.style.removeProperty('--dsh-sidebar-nav-scroll-cap');
      if (list.getAttribute(ATTR_STATE) !== STATE_FULL) list.setAttribute(ATTR_STATE, STATE_FULL);
    }

    function applyCap(list, cap) {
      list.style.setProperty('--dsh-sidebar-nav-scroll-cap', cap + 'px');
      list.setAttribute(ATTR_STATE, STATE_CAPPED);
    }

    function sync() {
      if (disposed) return;
      if (!settings.enabled) {
        unbind();
        removeSheet();
        return;
      }
      var list = boundList && boundList.isConnected ? boundList : findPanelList();
      if (!list) {
        unbind();
        ensureSheet();
        return;
      }
      if (list !== boundList) bind(list);
      ensureSheet();
      if (isCollapsed(list)) {
        lastCollapsed = true;
        clearCap(list);
        return;
      }
      lastCollapsed = false;
      var metrics = measureRows(list);
      lastNatural = metrics.natural;
      lastCount = metrics.count;
      var cap = computeCap(metrics, settings);
      if (cap <= 0) {
        lastCap = 0;
        clearCap(list);
        return;
      }
      lastCap = cap;
      applyCap(list, cap);
    }

    function bind(list) {
      unbind();
      boundList = list;
      list.setAttribute(ATTR, MARK);
      if (typeof window.ResizeObserver === 'function') {
        try {
          resizeObserver = new window.ResizeObserver(function () {
            schedule();
          });
          resizeObserver.observe(list);
        } catch (error) {
          resizeObserver = null;
        }
      }
      if (typeof window.MutationObserver === 'function') {
        try {
          mutationObserver = new window.MutationObserver(function () {
            schedule();
          });
          mutationObserver.observe(list, { childList: true });
        } catch (error) {
          mutationObserver = null;
        }
        try {
          collapseObserver = new window.MutationObserver(function () {
            var collapsed = isCollapsed(boundList);
            if (collapsed !== lastCollapsed) schedule();
          });
          collapseObserver.observe(document.documentElement || document.body, {
            attributes: true,
            attributeFilter: ['data-sidebar-collapsed', 'class'],
            subtree: true
          });
        } catch (error) {
          collapseObserver = null;
        }
      }
    }

    function unbind() {
      if (boundList) {
        boundList.style.removeProperty('--dsh-sidebar-nav-scroll-cap');
        boundList.removeAttribute(ATTR);
        boundList.removeAttribute(ATTR_STATE);
      }
      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch (error) {
          /* ignore */
        }
      }
      if (mutationObserver) {
        try {
          mutationObserver.disconnect();
        } catch (error) {
          /* ignore */
        }
      }
      if (collapseObserver) {
        try {
          collapseObserver.disconnect();
        } catch (error) {
          /* ignore */
        }
      }
      resizeObserver = null;
      mutationObserver = null;
      collapseObserver = null;
      boundList = null;
      lastCap = 0;
      lastNatural = 0;
      lastCount = 0;
    }

    function onResize() {
      schedule();
    }

    /** The card, the console API and another tab all write the same storage key. */
    function onSettingsChange() {
      if (disposed) return;
      settings = resolveSettings(rawConfig);
      schedule();
    }

    window.addEventListener('resize', onResize);
    window.addEventListener(CHANGE_EVENT, onSettingsChange);
    window.addEventListener('storage', onSettingsChange);

    attachTimer = window.setInterval(function () {
      if (disposed) return;
      if (!boundList || !boundList.isConnected) {
        var list = findPanelList();
        if (list) {
          bind(list);
          schedule();
        }
      }
      if (boundList && boundList.isConnected) {
        window.clearInterval(attachTimer);
        attachTimer = null;
      }
    }, ATTACH_MS);

    watchTimer = window.setInterval(function () {
      if (disposed) return;
      if (!boundList || !boundList.isConnected) {
        var list = findPanelList();
        if (list) bind(list);
      }
      schedule();
    }, WATCH_MS);

    var api = {
      get: function () {
        return { fraction: settings.fraction, minRows: settings.minRows, enabled: settings.enabled };
      },
      set: function (patch) {
        writeStored(patch);
        return refreshSettings();
      },
      reset: function () {
        clearStored();
        return refreshSettings();
      },
      status: function () {
        return {
          attached: !!boundList,
          collapsed: lastCollapsed === null ? false : lastCollapsed,
          rows: lastCount,
          naturalHeight: lastNatural,
          capHeight: lastCap
        };
      }
    };
    window[CONSOLE_API] = api;

    ensureSheet();
    schedule();

    var disposedOnce = false;
    function dispose() {
      if (disposedOnce) return;
      disposedOnce = true;
      disposed = true;
      if (attachTimer) window.clearInterval(attachTimer);
      if (watchTimer) window.clearInterval(watchTimer);
      attachTimer = null;
      watchTimer = null;
      if (frame !== null) {
        var cancel = window.cancelAnimationFrame || window.clearTimeout;
        cancel(frame);
        frame = null;
      }
      window.removeEventListener('resize', onResize);
      window.removeEventListener(CHANGE_EVENT, onSettingsChange);
      window.removeEventListener('storage', onSettingsChange);
      unbind();
      removeSheet();
      removeCardSheet();
      if (window[CONSOLE_API] === api) {
        try {
          delete window[CONSOLE_API];
        } catch (error) {
          window[CONSOLE_API] = undefined;
        }
      }
    }

    if (ctx && typeof ctx.effect === 'function') {
      try {
        ctx.effect(function () {
          return dispose;
        }, 'dsh-sidebar-nav-scroll: lifetime');
      } catch (error) {
        /* fall back to the returned disposer */
      }
    }

    return dispose;
  }

  window.__ModuleLoader__.load({
    id: 'dsh-sidebar-nav-scroll',
    factory: function (require) {
      return {
        inject: [],
        apply: function () {
          var ctx = arguments[0];
          var rawConfig = arguments[1];
          /* The page's slot card is a React component, so it can only appear where the
           * host exposes `react` through the module-table require. Everything else
           * works without it: the cap is plain DOM. */
          var cardDisposer = registerConfigCard(ctx, require);
          var dispose = apply(ctx, rawConfig);
          return function () {
            if (typeof cardDisposer === 'function') {
              try {
                cardDisposer();
              } catch (error) {
                /* the slot registration is already gone */
              }
            }
            dispose();
          };
        }
      };
    }
  });
})();
