/* ============================================================================
 * 本地插图 · local-illustration
 * SillyTavern 客户端扩展（安卓 Tauri Tavern 优先，兼容电脑版标准酒馆）
 * ----------------------------------------------------------------------------
 * 作用：AI 回复里出现约定好的标记时（默认 [img]挠头[/img]），在【渲染阶段】
 *       把它显示成从本地图片库随机选中的一张图片。
 * 铁律：绝不修改消息原文（ctx.chat[i].mes 一个字符都不动），
 *       所以点击「编辑」时看到的仍然是纯文本。
 * ----------------------------------------------------------------------------
 * 分区：一、常量与上下文   二、设置读写   三、界面（设置面板）
 *       四、图片库          五、导入与关键词索引
 *       六、渲染替换        七、交互与事件   八、启动
 * ========================================================================== */
(function () {
  'use strict';

  /* ======================= 一、常量与上下文 ======================= */

  const PLUGIN_ID = 'local-illustration';
  const PREFIX = 'lpic-';
  const VERSION = '1.0.0';
  const LS_KEY = 'lpic_settings';

  const DB_NAME = 'lpic-db';
  const DB_VER = 1;
  const STORE_FILES = 'files';
  const STORE_META = 'meta';
  const META_INDEX = 'index';
  const META_SOURCE = 'source';

  const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'];

  const DEFAULT_SETTINGS = {
    enabled: true,          // 总开关
    tag: 'img',             // 标签名（可改成任意词防冲突）
    wrap: 'both',           // 包裹符：both / square / fullwidth
    imgHeight: 200,         // 插图高度（像素）
    blockMode: true,        // true=块级居中，false=行内小图
    applyToUser: false,     // 是否也处理用户消息
    skipCode: true,         // 跳过代码块与行内代码
    pinPerMessage: true,    // 同一条消息内同一关键词固定同一张图
    lightbox: true,         // 点击图片放大查看
    caseSensitive: false,   // 关键词是否区分大小写
    debug: false,           // 诊断日志
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);

  // 运行期状态（不落盘）
  const state = {
    observer: null,
    observedEl: null,
    busy: false,
    dirty: false,
    retryTimer: 0,
    retryCount: 0,
    scanTimer: 0,
    rebuildTimer: 0,
    saveTimer: 0,
    watchTimer: 0,
    mountTimer: 0,
    armClear: 0,
    generating: false,
  };

  /** 统一入口：拿酒馆上下文（任何一步都可能不存在，全部兜底） */
  function getCtx() {
    try {
      const st = window.SillyTavern;
      if (st && typeof st.getContext === 'function') return st.getContext();
    } catch (e) { /* 壳差异，忽略 */ }
    return null;
  }

  function getEventSource() {
    try {
      const c = getCtx();
      if (c && c.eventSource) return c.eventSource;
    } catch (e) { /* ignore */ }
    return window.eventSource || null;
  }

  function getEventTypes() {
    try {
      const c = getCtx();
      if (c && c.event_types) return c.event_types;
    } catch (e) { /* ignore */ }
    return window.event_types || null;
  }

  function getExtSettings() {
    try {
      const c = getCtx();
      if (c && c.extensionSettings) return c.extensionSettings;
    } catch (e) { /* ignore */ }
    return window.extension_settings || null;
  }

  function getChatEl() {
    try {
      return document.getElementById('chat') || document.querySelector('#chat_container .chat') || null;
    } catch (e) {
      return null;
    }
  }

  /* ======================= 二、设置读写 ======================= */

  function log() {
    if (!settings.debug) return;
    try {
      const a = Array.prototype.slice.call(arguments);
      a.unshift('[lpic]');
      console.log.apply(console, a);
    } catch (e) { /* ignore */ }
  }

  function warn() {
    try {
      const a = Array.prototype.slice.call(arguments);
      a.unshift('[lpic]');
      console.warn.apply(console, a);
    } catch (e) { /* ignore */ }
  }

  function clampTag(v) {
    const s = String(v == null ? '' : v).trim();
    return s ? s.slice(0, 16) : '';
  }

  /** 读设置：优先 localStorage，其次酒馆 extension_settings，最后默认值 */
  function loadSettings() {
    let stored = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch (e) { warn('读取本地设置失败', e); }

    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      try {
        const es = getExtSettings();
        if (es && es[PLUGIN_ID] && typeof es[PLUGIN_ID] === 'object') stored = es[PLUGIN_ID];
      } catch (e) { /* ignore */ }
    }

    settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});

    // 归一化，避免脏数据/旧快照造成的异常值
    settings.enabled = !!settings.enabled;
    settings.tag = clampTag(settings.tag) || DEFAULT_SETTINGS.tag;
    settings.wrap = ['both', 'square', 'fullwidth'].indexOf(settings.wrap) >= 0 ? settings.wrap : 'both';
    settings.imgHeight = Math.max(40, Math.min(800, Math.round(Number(settings.imgHeight) || DEFAULT_SETTINGS.imgHeight)));
    settings.blockMode = !!settings.blockMode;
    settings.applyToUser = !!settings.applyToUser;
    settings.skipCode = !!settings.skipCode;
    settings.pinPerMessage = !!settings.pinPerMessage;
    settings.lightbox = !!settings.lightbox;
    settings.caseSensitive = !!settings.caseSensitive;
    settings.debug = !!settings.debug;

    // 立刻回写一次：localStorage 与 extension_settings 双份都在，任一份丢了都还能靠另一份恢复
    persist();
    log('设置已载入', settings);
  }

  /** 写设置：localStorage 双写 + 酒馆 extension_settings（读时以 localStorage 为准） */
  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { warn('写本地设置失败', e); }
    try {
      const es = getExtSettings();
      if (es) es[PLUGIN_ID] = Object.assign({}, settings);
      if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
      else if (typeof window.saveSettings === 'function') window.saveSettings();
    } catch (e) { warn('写酒馆设置失败', e); }
  }

  function scheduleSave() {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(function () {
      state.saveTimer = 0;
      persist();
    }, 200);
  }

  function resetSettings() {
    settings = Object.assign({}, DEFAULT_SETTINGS);
    persist();
    syncUI();
    if (typeof onSettingsChanged === 'function') onSettingsChanged('__all__');
    log('已恢复默认设置');
  }

  /* ======================= 三、界面：设置面板 ======================= */

  function icon(name) {
    const p = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    switch (name) {
      case 'logo':
        return '<svg width="15" height="15" viewBox="0 0 24 24" ' + p + '><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.6" cy="9.6" r="1.5"/><path d="M4.4 17.6 9.2 12.8l3.1 3.1 2.4-2.4 4.9 4.1"/></svg>';
      case 'chevron':
        return '<svg width="14" height="14" viewBox="0 0 24 24" ' + p + '><path d="M6 9l6 6 6-6"/></svg>';
      case 'folder':
        return '<svg width="15" height="15" viewBox="0 0 24 24" ' + p + '><path d="M3 7.6A2 2 0 0 1 5 5.6h3.5a2 2 0 0 1 1.6.8l1 1.3H19a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
      case 'plus':
        return '<svg width="15" height="15" viewBox="0 0 24 24" ' + p + '><path d="M12 5v14M5 12h14"/></svg>';
      case 'refresh':
        return '<svg width="15" height="15" viewBox="0 0 24 24" ' + p + '><path d="M20 11a8 8 0 1 0-2.3 5.6"/><path d="M20 5v6h-6"/></svg>';
      case 'trash':
        return '<svg width="15" height="15" viewBox="0 0 24 24" ' + p + '><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.8 11a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-11"/></svg>';
      case 'close':
        return '<svg width="18" height="18" viewBox="0 0 24 24" ' + p + '><path d="M6 6l12 12M18 6L6 18"/></svg>';
      default:
        return '';
    }
  }

  function panelHTML() {
    return ''
      + '<div class="' + PREFIX + 'panel" id="' + PREFIX + 'panel">'
      + '  <div class="' + PREFIX + 'head">'
      + '    <div class="' + PREFIX + 'head-l">'
      + '      <span class="' + PREFIX + 'logo">' + icon('logo') + '</span>'
      + '      <span class="' + PREFIX + 'title">本地插图</span>'
      + '      <span class="' + PREFIX + 'ver">v' + VERSION + '</span>'
      + '    </div>'
      + '    <div class="' + PREFIX + 'head-r">'
      + '      <label class="' + PREFIX + 'switch" title="总开关">'
      + '        <input type="checkbox" data-lpic="enabled">'
      + '        <span class="' + PREFIX + 'slider"></span>'
      + '      </label>'
      + '      <button class="' + PREFIX + 'chev" data-lpic-act="toggle-body" aria-label="展开或收起">' + icon('chevron') + '</button>'
      + '    </div>'
      + '  </div>'
      + '  <div class="' + PREFIX + 'body">'

      // —— 标记设置 ——
      + '    <div class="' + PREFIX + 'group">'
      + '      <div class="' + PREFIX + 'group-title">标记设置</div>'
      + '      <div class="' + PREFIX + 'row">'
      + '        <span class="' + PREFIX + 'label">标签名（可改成任意词，防与其他插件冲突）</span>'
      + '        <input class="' + PREFIX + 'input" type="text" data-lpic="tag" maxlength="16" placeholder="img" spellcheck="false" autocomplete="off">'
      + '      </div>'
      + '      <div class="' + PREFIX + 'row">'
      + '        <span class="' + PREFIX + 'label">包裹符</span>'
      + '        <div class="' + PREFIX + 'seg" data-lpic-seg="wrap">'
      + '          <button class="' + PREFIX + 'seg-btn" data-value="both">两者都认</button>'
      + '          <button class="' + PREFIX + 'seg-btn" data-value="square">方括号</button>'
      + '          <button class="' + PREFIX + 'seg-btn" data-value="fullwidth">全角尖括号</button>'
      + '        </div>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'example">当前识别：<code class="' + PREFIX + 'example-code"></code></div>'
      + '      <div class="' + PREFIX + 'hint ' + PREFIX + 'hint-warn">半角尖括号（例如 &lt;img&gt;）会被酒馆的 HTML 清洗剥掉、识别不到，请只用上面两种包裹符。</div>'
      + '    </div>'

      // —— 图片库 ——
      + '    <div class="' + PREFIX + 'group">'
      + '      <div class="' + PREFIX + 'group-title">图片库</div>'
      + '      <div class="' + PREFIX + 'btn-row">'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-primary" data-lpic-act="import-dir">' + icon('folder') + '选择图片根目录</button>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'btn-row">'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="import-files">' + icon('plus') + '追加图片</button>'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="rescan">' + icon('refresh') + '重新渲染</button>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'status" id="' + PREFIX + 'status">尚未导入图片</div>'
      + '      <div class="' + PREFIX + 'src" id="' + PREFIX + 'src"></div>'
      + '      <button class="' + PREFIX + 'kw-toggle" data-lpic-act="toggle-kw">关键词清单（点一项可试看）<span id="' + PREFIX + 'kw-count">0</span></button>'
      + '      <div class="' + PREFIX + 'kw-list" id="' + PREFIX + 'kw-list" hidden></div>'
      + '    </div>'

      // —— 显示设置 ——
      + '    <div class="' + PREFIX + 'group">'
      + '      <div class="' + PREFIX + 'group-title">显示设置</div>'
      + '      <div class="' + PREFIX + 'row">'
      + '        <span class="' + PREFIX + 'label">图片高度</span>'
      + '        <input class="' + PREFIX + 'range" type="range" min="60" max="600" step="10" data-lpic="imgHeight">'
      + '        <span class="' + PREFIX + 'val" id="' + PREFIX + 'h-val">200px</span>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'row">'
      + '        <span class="' + PREFIX + 'label">排版</span>'
      + '        <div class="' + PREFIX + 'seg" data-lpic-seg="blockMode">'
      + '          <button class="' + PREFIX + 'seg-btn" data-value="1">块级居中</button>'
      + '          <button class="' + PREFIX + 'seg-btn" data-value="0">行内小图</button>'
      + '        </div>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'row"><span class="' + PREFIX + 'label">点击图片放大查看</span>'
      + '        <label class="' + PREFIX + 'switch"><input type="checkbox" data-lpic="lightbox"><span class="' + PREFIX + 'slider"></span></label></div>'
      + '      <div class="' + PREFIX + 'row"><span class="' + PREFIX + 'label">也处理用户消息</span>'
      + '        <label class="' + PREFIX + 'switch"><input type="checkbox" data-lpic="applyToUser"><span class="' + PREFIX + 'slider"></span></label></div>'
      + '      <div class="' + PREFIX + 'row"><span class="' + PREFIX + 'label">跳过代码块</span>'
      + '        <label class="' + PREFIX + 'switch"><input type="checkbox" data-lpic="skipCode"><span class="' + PREFIX + 'slider"></span></label></div>'
      + '      <div class="' + PREFIX + 'row"><span class="' + PREFIX + 'label">同一条消息固定同一张图</span>'
      + '        <label class="' + PREFIX + 'switch"><input type="checkbox" data-lpic="pinPerMessage"><span class="' + PREFIX + 'slider"></span></label></div>'
      + '      <div class="' + PREFIX + 'row"><span class="' + PREFIX + 'label">关键词区分大小写</span>'
      + '        <label class="' + PREFIX + 'switch"><input type="checkbox" data-lpic="caseSensitive"><span class="' + PREFIX + 'slider"></span></label></div>'
      + '    </div>'

      // —— 底部 ——
      + '    <div class="' + PREFIX + 'group">'
      + '      <div class="' + PREFIX + 'btn-row">'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="reset">恢复默认设置</button>'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="debug">诊断日志</button>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'btn-row">'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost ' + PREFIX + 'btn-danger" data-lpic-act="clear">' + icon('trash') + '清空图片库</button>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'hint">图片只保存在本机浏览器数据库里，不上传、不联网。把图片按「关键词」命名文件夹后导入，标记里写这个关键词即可。</div>'
      + '    </div>'

      + '  </div>'
      + '</div>';
  }

  function sampleMarker() {
    const tag = clampTag(settings.tag) || DEFAULT_SETTINGS.tag;
    if (settings.wrap === 'fullwidth') return '＜' + tag + '＞挠头＜/' + tag + '＞';
    return '[' + tag + ']挠头[/' + tag + ']';
  }

  /** 把当前设置回灌到面板控件上 */
  function syncUI() {
    const panel = document.getElementById(PREFIX + 'panel');
    if (!panel) return;

    panel.querySelectorAll('[data-lpic]').forEach(function (el) {
      const key = el.getAttribute('data-lpic');
      if (!(key in DEFAULT_SETTINGS)) return;
      const v = settings[key];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    });

    panel.querySelectorAll('[data-lpic-seg]').forEach(function (seg) {
      const key = seg.getAttribute('data-lpic-seg');
      const cur = (typeof settings[key] === 'boolean') ? (settings[key] ? '1' : '0') : String(settings[key]);
      seg.querySelectorAll('[data-value]').forEach(function (b) {
        b.classList.toggle(PREFIX + 'on', b.getAttribute('data-value') === cur);
      });
    });

    const code = panel.querySelector('.' + PREFIX + 'example-code');
    if (code) code.textContent = sampleMarker();

    const hv = document.getElementById(PREFIX + 'h-val');
    if (hv) hv.textContent = settings.imgHeight + 'px';

    const dbg = panel.querySelector('[data-lpic-act="debug"]');
    if (dbg) dbg.textContent = '诊断日志：' + (settings.debug ? '开' : '关');

    panel.classList.toggle(PREFIX + 'collapsed', state.collapsed === true);
  }

  /** 状态文字（导入流程会频繁调用） */
  function setStatus(text, kind) {
    const el = document.getElementById(PREFIX + 'status');
    if (!el) return;
    el.textContent = String(text == null ? '' : text);
    el.classList.toggle(PREFIX + 'status-ok', kind === 'ok');
    el.classList.toggle(PREFIX + 'status-err', kind === 'err');
  }

  function findHolder() {
    return document.getElementById('extensions_settings2')
      || document.getElementById('extensions_settings')
      || null;
  }

  /** 挂载面板；已挂过就只做幂等（顺便把降级挂载挪回设置区） */
  function mountPanel() {
    let mount = document.getElementById(PREFIX + 'mount');
    const holder = findHolder();

    if (mount) {
      if (holder && mount.parentNode !== holder) {
        try {
          holder.appendChild(mount);
          mount.classList.remove(PREFIX + 'mount-float');
          log('面板已移回酒馆扩展设置区');
        } catch (e) { warn('移动面板失败', e); }
      }
      return true;
    }

    if (!holder) return false;

    mount = document.createElement('div');
    mount.id = PREFIX + 'mount';
    mount.className = PREFIX + 'mount';
    mount.innerHTML = panelHTML();
    holder.appendChild(mount);
    bindPanel(mount);
    syncUI();
    log('面板已挂载到 #' + holder.id);
    return true;
  }

  /** 找不到酒馆设置容器时的降级：右下角浮动面板 */
  function mountPanelFloat() {
    if (document.getElementById(PREFIX + 'mount')) return true;
    let mount;
    try {
      mount = document.createElement('div');
      mount.id = PREFIX + 'mount';
      mount.className = PREFIX + 'mount ' + PREFIX + 'mount-float';
      mount.innerHTML = panelHTML();
      document.body.appendChild(mount);
      bindPanel(mount);
      syncUI();
      warn('未找到酒馆的扩展设置容器，面板已降级挂到页面右下角');
      return true;
    } catch (e) {
      warn('挂载面板失败', e);
      return false;
    }
  }

  function mountPanelWithRetry() {
    if (mountPanel()) return;
    let tries = 0;
    if (state.mountTimer) return;
    state.mountTimer = setInterval(function () {
      tries += 1;
      if (mountPanel() || tries >= 20) {
        clearInterval(state.mountTimer);
        state.mountTimer = 0;
        if (!document.getElementById(PREFIX + 'mount')) mountPanelFloat();
      }
    }, 1000);
  }

  /* ------------------ 面板交互（事件委托，全部 lpic- 前缀） ------------------ */

  function bindPanel(mount) {
    mount.addEventListener('click', onPanelClick);
    mount.addEventListener('input', onPanelInput);
    mount.addEventListener('change', onPanelChange);
    // 面板内的点击不再往外冒，避免穿透触发酒馆/其他插件的行为
    mount.addEventListener('click', function (e) {
      try { e.stopPropagation(); } catch (err) { /* ignore */ }
    });
  }

  function readControlValue(el, key) {
    if (el.type === 'checkbox') return !!el.checked;
    if (typeof DEFAULT_SETTINGS[key] === 'number') return Number(el.value) || 0;
    return el.value;
  }

  function onPanelClick(e) {
    try {
      const btn = e.target.closest ? e.target.closest('[data-lpic-act]') : null;
      if (btn) {
        e.preventDefault();
        handleAct(btn.getAttribute('data-lpic-act'), btn, e);
        return;
      }
      const segBtn = e.target.closest ? e.target.closest('.' + PREFIX + 'seg-btn') : null;
      if (segBtn) {
        const seg = segBtn.closest('[data-lpic-seg]');
        if (seg) {
          const key = seg.getAttribute('data-lpic-seg');
          if (key in DEFAULT_SETTINGS) {
            const raw = segBtn.getAttribute('data-value');
            settings[key] = (typeof DEFAULT_SETTINGS[key] === 'boolean') ? (raw === '1') : raw;
            persist();
            syncUI();
            if (typeof onSettingsChanged === 'function') onSettingsChanged(key);
          }
        }
      }
    } catch (err) {
      warn('面板点击处理异常', err);
    }
  }

  function onPanelInput(e) {
    try {
      const el = e.target.closest ? e.target.closest('[data-lpic]') : null;
      if (!el || el.type === 'checkbox') return;
      const key = el.getAttribute('data-lpic');
      if (!(key in DEFAULT_SETTINGS)) return;
      settings[key] = readControlValue(el, key);
      const hv = document.getElementById(PREFIX + 'h-val');
      if (key === 'imgHeight' && hv) hv.textContent = settings.imgHeight + 'px';
      scheduleSave();
      if (typeof onSettingsChanged === 'function') onSettingsChanged(key);
    } catch (err) {
      warn('面板输入处理异常', err);
    }
  }

  function onPanelChange(e) {
    try {
      const el = e.target.closest ? e.target.closest('[data-lpic]') : null;
      if (!el) return;
      const key = el.getAttribute('data-lpic');
      if (!(key in DEFAULT_SETTINGS)) return;
      settings[key] = readControlValue(el, key);
      persist();
      syncUI();
      if (typeof onSettingsChanged === 'function') onSettingsChanged(key);
    } catch (err) {
      warn('面板切换处理异常', err);
    }
  }

  function handleAct(act, btn) {
    switch (act) {
      case 'toggle-body':
        state.collapsed = !state.collapsed;
        syncUI();
        break;
      case 'toggle-kw':
        if (typeof toggleKeywordList === 'function') toggleKeywordList();
        break;
      case 'import-dir':
        if (typeof importFlow === 'function') importFlow('replace');
        break;
      case 'import-files':
        if (typeof importFlow === 'function') importFlow('append');
        break;
      case 'clear':
        if (typeof requestClearLibrary === 'function') requestClearLibrary(btn);
        break;
      case 'rescan':
        if (typeof rebuildRendered === 'function') rebuildRendered();
        break;
      case 'reset':
        resetSettings();
        break;
      case 'debug':
        settings.debug = !settings.debug;
        persist();
        syncUI();
        publishDebugApi();
        log('诊断日志已' + (settings.debug ? '开启' : '关闭'));
        break;
      default:
        if (typeof handleExtraAct === 'function') handleExtraAct(act, btn);
        break;
    }
  }

  /* ======================= 四、图片库（IndexedDB） ======================= */

  let dbPromise = null;
  let indexList = [];              // 轻量索引：[{ path, keyword, names, name, size }]
  let keywordMap = new Map();      // 小写关键词 -> { name, paths: [path...] }
  const urlCache = new Map();      // path -> objectURL（懒加载缓存）
  const pinned = new Map();        // `${mesId}|${小写关键词}` -> path（同一消息固定同图）

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      let req;
      try {
        if (!window.indexedDB) { resolve(null); return; }
        req = indexedDB.open(DB_NAME, DB_VER);
      } catch (e) {
        warn('打开图片库异常', e);
        resolve(null);
        return;
      }
      req.onupgradeneeded = function () {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(STORE_FILES)) {
            const s = db.createObjectStore(STORE_FILES, { keyPath: 'path' });
            s.createIndex('keyword', 'keyword', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_META)) {
            db.createObjectStore(STORE_META, { keyPath: 'key' });
          }
        } catch (e) { warn('建表失败', e); }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { warn('打开图片库失败', req.error); resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbPromise;
  }

  function dbGet(store, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        if (!db) { resolve(null); return; }
        try {
          const tx = db.transaction(store, 'readonly');
          const rq = tx.objectStore(store).get(key);
          rq.onsuccess = function () { resolve(rq.result || null); };
          rq.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function dbPut(store, records) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        if (!db || !records || !records.length) { resolve(0); return; }
        try {
          const tx = db.transaction(store, 'readwrite');
          const os = tx.objectStore(store);
          for (let i = 0; i < records.length; i += 1) {
            try { os.put(records[i]); } catch (e) { warn('写入单条失败', e); }
          }
          tx.oncomplete = function () { resolve(records.length); };
          tx.onerror = function () { warn('写入失败', tx.error); resolve(0); };
          tx.onabort = function () { resolve(0); };
        } catch (e) {
          warn('写入异常', e);
          resolve(0);
        }
      });
    });
  }

  function dbClear(store) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        if (!db) { resolve(false); return; }
        try {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).clear();
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  /** 取图片对象 URL：命中缓存直接返回，否则从库里读 Blob 现造 */
  function getUrl(path) {
    if (!path) return Promise.resolve(null);
    if (urlCache.has(path)) return Promise.resolve(urlCache.get(path));
    return dbGet(STORE_FILES, path).then(function (rec) {
      if (!rec || !rec.blob) return null;
      const url = URL.createObjectURL(rec.blob);
      urlCache.set(path, url);
      return url;
    }).catch(function (e) {
      warn('读取图片失败', path, e);
      return null;
    });
  }

  function revokeUrls() {
    urlCache.forEach(function (u) {
      try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
    });
    urlCache.clear();
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ======================= 五、导入与关键词索引 ======================= */

  function isImageFile(f) {
    try {
      if (!f) return false;
      const t = String(f.type || '');
      if (t.indexOf('image/') === 0) return true;
      const n = String(f.name || '').toLowerCase();
      const dot = n.lastIndexOf('.');
      if (dot < 0) return false;
      return IMG_EXT.indexOf(n.slice(dot + 1)) >= 0;
    } catch (e) {
      return false;
    }
  }

  /** 从文件名猜关键词：取第一个分隔符之前的部分（挠头_01.png → 挠头） */
  function namePrefix(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '').trim();
    if (!base) return '';
    const m = base.match(/^(.+?)[\s_\-.#（(．]+/);
    return (m && m[1] ? m[1] : base).trim();
  }

  /** 打开系统选择器；isDir=true 时尝试目录模式（安卓可能不支持，会走多选兜底） */
  function pickWithInput(isDir) {
    return new Promise(function (resolve) {
      let input = null;
      try {
        input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'image/*';
        if (isDir) {
          input.webkitdirectory = true;
          input.setAttribute('webkitdirectory', '');
          input.setAttribute('directory', '');
        }
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        input.style.top = '0';
        input.style.width = '1px';
        input.style.height = '1px';
        input.style.opacity = '0';
        document.body.appendChild(input);
      } catch (e) {
        warn('创建选择器失败', e);
        resolve([]);
        return;
      }

      let settled = false;
      function finish(list) {
        if (settled) return;
        settled = true;
        try { input.remove(); } catch (e) { /* ignore */ }
        resolve(list || []);
      }
      function collect() {
        try {
          return Array.prototype.slice.call(input.files || []).filter(isImageFile);
        } catch (e) {
          return [];
        }
      }

      input.addEventListener('change', function () { finish(collect()); });
      input.addEventListener('cancel', function () { finish([]); });

      // 用户在部分壳里取消时既没有 change 也没有 cancel，用「焦点回到页面」兜底
      window.addEventListener('focus', function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(function () {
          if (settled) return;
          finish(collect());
        }, 3000);
      }, { once: true });

      try { input.click(); } catch (e) { finish([]); }
    });
  }

  function buildIndex() {
    keywordMap = new Map();
    for (let i = 0; i < indexList.length; i += 1) {
      const rec = indexList[i];
      if (!rec || !rec.path) continue;
      const names = [rec.keyword].concat(rec.names || []);
      for (let j = 0; j < names.length; j += 1) {
        const nm = String(names[j] == null ? '' : names[j]).trim();
        if (!nm) continue;
        const k = nm.toLowerCase();
        let entry = keywordMap.get(k);
        if (!entry) {
          entry = { name: nm, paths: [] };
          keywordMap.set(k, entry);
        }
        if (entry.paths.indexOf(rec.path) < 0) entry.paths.push(rec.path);
      }
    }
  }

  /** 查关键词：命中返回 { name, paths }，未命中返回 null（未命中就保留原文） */
  function lookupKeyword(kw) {
    const s = String(kw == null ? '' : kw).trim();
    if (!s) return null;
    if (!settings.caseSensitive) {
      const e = keywordMap.get(s.toLowerCase());
      return (e && e.paths.length) ? e : null;
    }
    let hit = null;
    keywordMap.forEach(function (e) {
      if (hit || e.name !== s) return;
      if (e.paths && e.paths.length) hit = e;
    });
    return hit;
  }

  function pickPath(entry, mesId, kw) {
    if (!entry || !entry.paths || !entry.paths.length) return null;
    const key = String(mesId) + '|' + String(kw).toLowerCase();
    if (settings.pinPerMessage && pinned.has(key)) return pinned.get(key);
    const path = entry.paths[Math.floor(Math.random() * entry.paths.length)];
    if (settings.pinPerMessage) pinned.set(key, path);
    return path;
  }

  async function doImport(files, mode) {
    const total = files.length;
    const records = [];
    const list = [];
    const used = new Set();
    const now = Date.now();
    let rootName = '';

    for (let i = 0; i < total; i += 1) {
      const f = files[i];
      const rel = String(f.webkitRelativePath || f.name || '').replace(/\\/g, '/');
      const parts = rel.split('/').filter(Boolean);
      let relFromRoot = rel;
      let kwSource = '';

      if (parts.length >= 2) {
        if (!rootName) rootName = parts[0];
        const inner = parts.slice(1);
        relFromRoot = inner.join('/');
        kwSource = inner.length >= 2 ? inner[inner.length - 2] : namePrefix(inner[inner.length - 1]);
      } else {
        relFromRoot = parts[0] || f.name;
        kwSource = namePrefix(f.name);
      }

      const kwRaw = String(kwSource || '').trim();
      if (!kwRaw) continue;

      const names = kwRaw.split(/[|｜,，;；]/).map(function (s) { return s.trim(); }).filter(Boolean);
      const primary = names[0] || kwRaw;

      let path = relFromRoot || f.name;
      let n = 1;
      while (used.has(path)) { n += 1; path = (relFromRoot || f.name) + '#' + n; }
      used.add(path);

      records.push({
        path: path,
        keyword: primary,
        names: names,
        name: f.name,
        type: f.type || '',
        size: f.size || 0,
        ts: now,
        blob: f,
      });
      list.push({ path: path, keyword: primary, names: names, name: f.name, size: f.size || 0 });

      if (i % 25 === 0) {
        setStatus('正在读取图片 ' + (i + 1) + ' / ' + total + ' …');
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }

    if (!records.length) {
      setStatus('没有读到可用的图片（支持 png / jpg / gif / webp / avif / bmp / svg）', 'err');
      return;
    }

    if (mode === 'replace') {
      await dbClear(STORE_FILES);
      setStatus('正在清空旧图片库 …');
    }

    const CHUNK = 80;
    for (let i = 0; i < records.length; i += CHUNK) {
      await dbPut(STORE_FILES, records.slice(i, i + CHUNK));
      setStatus('正在入库 ' + Math.min(i + CHUNK, records.length) + ' / ' + records.length + ' …');
      await new Promise(function (r) { setTimeout(r, 0); });
    }

    let merged = list;
    if (mode === 'append') {
      const old = await dbGet(STORE_META, META_INDEX);
      const oldList = (old && Array.isArray(old.list)) ? old.list : [];
      const newPaths = new Set(list.map(function (r) { return r.path; }));
      merged = oldList.filter(function (r) { return !newPaths.has(r.path); }).concat(list);
    }

    await dbPut(STORE_META, [{ key: META_INDEX, list: merged }]);
    await dbPut(STORE_META, [{
      key: META_SOURCE,
      info: { rootName: rootName || '（直接选择的图片文件）', count: merged.length, ts: now },
    }]);

    indexList = merged;
    buildIndex();

    // 库变了：先把画面上的旧图还原成原文，再清缓存、重新渲染
    if (typeof revertRendered === 'function') revertRendered();
    revokeUrls();
    pinned.clear();
    updateStats();
    if (typeof applyAll === 'function') applyAll();
    log('导入完成', list.length, '张，库内共', merged.length, '张');
  }

  async function importFlow(mode, forceFiles) {
    if (state.busy) { log('导入进行中，忽略本次请求'); return; }
    state.busy = true;
    try {
      let files = [];
      if (!forceFiles) {
        setStatus('请在弹窗里选中你的「图片根目录」…');
        files = await pickWithInput(true);
      }
      if (!files.length) {
        if (!forceFiles) setStatus('没读到文件夹（部分安卓设备不支持选文件夹），改为多选图片…');
        files = await pickWithInput(false);
      }
      if (!files.length) {
        setStatus('已取消，没有导入任何图片');
        return;
      }
      await doImport(files, mode);
    } catch (e) {
      warn('导入失败', e);
      setStatus('导入失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      state.busy = false;
    }
  }

  async function refreshLibrary() {
    try {
      const rec = await dbGet(STORE_META, META_INDEX);
      indexList = (rec && Array.isArray(rec.list)) ? rec.list : [];
      buildIndex();
      updateStats();

      const src = await dbGet(STORE_META, META_SOURCE);
      const srcEl = document.getElementById(PREFIX + 'src');
      if (srcEl) {
        const info = (src && src.info) || null;
        srcEl.textContent = (info && info.ts)
          ? ('来源：' + info.rootName + ' · 导入于 ' + new Date(info.ts).toLocaleString())
          : '';
      }
      if (typeof applyAll === 'function') applyAll();
      log('图片库已就绪，共', indexList.length, '张');
    } catch (e) {
      warn('读取图片库失败', e);
    }
  }

  function updateStats() {
    const total = indexList.length;
    if (!total) {
      setStatus('尚未导入图片');
      renderKeywordList();
      return;
    }
    let bytes = 0;
    for (let i = 0; i < indexList.length; i += 1) bytes += Number(indexList[i].size) || 0;
    setStatus('已就绪：' + keywordMap.size + ' 个关键词 · ' + total + ' 张图片 · 占用 ' + fmtSize(bytes), 'ok');
    renderKeywordList();
  }

  function renderKeywordList() {
    const listEl = document.getElementById(PREFIX + 'kw-list');
    const countEl = document.getElementById(PREFIX + 'kw-count');
    if (!listEl) return;

    const items = Array.from(keywordMap.values()).sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });
    if (countEl) countEl.textContent = String(items.length);
    if (!items.length) {
      listEl.innerHTML = '<div class="' + PREFIX + 'kw-empty">还没有关键词。把图片按关键词命名文件夹（或用「关键词_01.png」这样命名）后导入即可。</div>';
      return;
    }
    listEl.innerHTML = items.map(function (it) {
      const safe = String(it.name).replace(/[&<>"]/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
      });
      return '<button class="' + PREFIX + 'kw-item" data-lpic-act="kw-preview" data-kw="' + safe + '">'
        + '<span class="' + PREFIX + 'kw-name">' + safe + '</span>'
        + '<span class="' + PREFIX + 'kw-num">' + it.paths.length + '</span>'
        + '</button>';
    }).join('');
  }

  function toggleKeywordList() {
    const listEl = document.getElementById(PREFIX + 'kw-list');
    if (!listEl) return;
    listEl.hidden = !listEl.hidden;
    if (!listEl.hidden) renderKeywordList();
  }

  function requestClearLibrary(btn) {
    if (state.armClear) {
      clearTimeout(state.armClear);
      state.armClear = 0;
      if (btn) {
        btn.classList.remove(PREFIX + 'armed');
        btn.innerHTML = icon('trash') + '清空图片库';
      }
      clearLibrary();
      return;
    }
    if (btn) {
      btn.classList.add(PREFIX + 'armed');
      btn.innerHTML = icon('trash') + '再点一次确认';
    }
    setStatus('再点一次「清空图片库」即会清空（只是插件不再记得这些图片，原文件不会被删）');
    state.armClear = setTimeout(function () {
      state.armClear = 0;
      if (btn) {
        btn.classList.remove(PREFIX + 'armed');
        btn.innerHTML = icon('trash') + '清空图片库';
      }
      updateStats();
    }, 4000);
  }

  async function clearLibrary() {
    try {
      if (typeof revertRendered === 'function') revertRendered();
      revokeUrls();
      pinned.clear();
      await dbClear(STORE_FILES);
      await dbClear(STORE_META);
      indexList = [];
      buildIndex();
      const srcEl = document.getElementById(PREFIX + 'src');
      if (srcEl) srcEl.textContent = '';
      updateStats();
      setStatus('图片库已清空', 'ok');
      log('图片库已清空');
    } catch (e) {
      warn('清空图片库失败', e);
      setStatus('清空失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  /* ======================= 六、渲染替换（核心） =======================
   * 只改画面，不改数据：把标记所在的文本节点换成图片节点，
   * ctx.chat[i].mes 原封不动 —— 所以点「编辑」看到的仍是纯文本。
   * ================================================================= */

  const pendingEls = new Set();

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 按「标签名 + 包裹符」现建正则（每次新建，避免 /g 的 lastIndex 陷阱） */
  function buildRegex() {
    const tag = escapeRe(clampTag(settings.tag) || DEFAULT_SETTINGS.tag);
    const sq = '\\[\\s*' + tag + '\\s*\\]([^\\n]{1,60}?)\\[\\s*\\/\\s*' + tag + '\\s*\\]';
    const fw = '[＜〈]\\s*' + tag + '\\s*[＞〉]([^\\n]{1,60}?)[＜〈]\\s*\\/\\s*' + tag + '\\s*[＞〉]';
    let src;
    if (settings.wrap === 'square') src = sq;
    else if (settings.wrap === 'fullwidth') src = fw;
    else src = sq + '|' + fw;
    return new RegExp(src, 'g');
  }

  function getMesId(mesEl) {
    if (!mesEl) return null;
    try {
      const raw = mesEl.getAttribute('mesid');
      if (raw != null && raw !== '') {
        const n = parseInt(raw, 10);
        return isNaN(n) ? raw : n;
      }
    } catch (e) { /* ignore */ }
    try {
      const chat = getChatEl();
      if (chat) {
        const all = chat.querySelectorAll('.mes');
        for (let i = 0; i < all.length; i += 1) if (all[i] === mesEl) return 'i' + i;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function getChatArray() {
    try {
      const c = getCtx();
      if (c && Array.isArray(c.chat)) return c.chat;
    } catch (e) { /* ignore */ }
    try {
      if (Array.isArray(window.chat)) return window.chat;
    } catch (e) { /* ignore */ }
    return null;
  }

  function mesRole(mesEl) {
    if (!mesEl) return null;
    try {
      const attr = mesEl.getAttribute('is_user');
      if (attr === 'true') return 'user';
      if (attr === 'false') return 'char';
      if (mesEl.classList && mesEl.classList.contains('user-message')) return 'user';
    } catch (e) { /* ignore */ }
    const id = getMesId(mesEl);
    const arr = getChatArray();
    if (arr && id != null && arr[id]) {
      const m = arr[id];
      if (m.is_user) return 'user';
      if (m.role === 'system') return 'system';
      return 'char';
    }
    return null;
  }

  function isGenerating() {
    if (state.generating) return true;
    try {
      const stop = document.getElementById('mes_stop');
      if (stop && stop.offsetParent !== null && !stop.classList.contains('displayNone')) return true;
      if (document.querySelector('#chat .mes.streaming')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function replaceWithText(el, text) {
    try {
      if (!el || !el.parentNode) return;
      el.parentNode.replaceChild(document.createTextNode(text == null ? '' : text), el);
    } catch (e) { /* ignore */ }
  }

  /** 图片加载失败时的兜底：把标记还原成纯文本（带标记类，避免被再次处理成死循环） */
  function toFailText(el, raw) {
    try {
      if (!el || !el.parentNode) return;
      const s = document.createElement('span');
      s.className = PREFIX + 'fail-text';
      s.setAttribute('data-lpic-raw', raw || '');
      s.textContent = raw || '';
      el.parentNode.replaceChild(s, el);
    } catch (e) { /* ignore */ }
  }

  function makeImageNode(entry, mesId, kw, raw) {
    const wrap = document.createElement('span');
    wrap.className = PREFIX + (settings.blockMode ? 'block' : 'inline');
    wrap.setAttribute('data-lpic-kw', kw);
    wrap.setAttribute('data-lpic-raw', raw);

    const img = document.createElement('img');
    img.className = PREFIX + 'img';
    img.alt = kw;
    img.decoding = 'async';
    img.draggable = false;
    img.style.height = settings.imgHeight + 'px';
    img.style.cursor = settings.lightbox ? 'zoom-in' : 'default';
    wrap.appendChild(img);

    const path = pickPath(entry, mesId, kw);
    if (!path) return document.createTextNode(raw);

    getUrl(path).then(function (url) {
      if (!url) { toFailText(wrap, raw); return; }
      img.addEventListener('load', function () { wrap.classList.add(PREFIX + 'ready'); });
      img.addEventListener('error', function () { toFailText(wrap, raw); });
      img.src = url;
      if (img.complete && img.naturalWidth) wrap.classList.add(PREFIX + 'ready');
    });

    return wrap;
  }

  function processTextNode(node, mesId) {
    const text = node.nodeValue;
    if (!text) return;

    const matches = Array.from(text.matchAll(buildRegex()));
    if (!matches.length) return;

    const frag = document.createDocumentFragment();
    let last = 0;
    let changed = 0;

    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i];
      const kwRaw = (m[1] !== undefined) ? m[1] : ((m[2] !== undefined) ? m[2] : '');
      const kw = String(kwRaw).trim();
      const entry = lookupKeyword(kw);
      if (!entry) continue;                       // 没有对应图片目录 → 原样保留

      const idx = m.index;
      const raw = m[0];
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      frag.appendChild(makeImageNode(entry, mesId, kw, raw));
      last = idx + raw.length;
      changed += 1;
    }

    if (!changed) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (!node.parentNode) return;
    node.parentNode.replaceChild(frag, node);
  }

  function processRoot(rootEl, mesId) {
    const nodes = [];
    try {
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          try {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            if (p.closest('.' + PREFIX + 'block, .' + PREFIX + 'inline, .' + PREFIX + 'fail-text, .' + PREFIX + 'lb')) return NodeFilter.FILTER_REJECT;
            if (settings.skipCode && p.closest('pre, code')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          } catch (e) {
            return NodeFilter.FILTER_REJECT;
          }
        },
      });
      while (walker.nextNode()) nodes.push(walker.currentNode);
    } catch (e) {
      warn('遍历文本节点失败', e);
      return;
    }
    for (let i = 0; i < nodes.length; i += 1) {
      try { processTextNode(nodes[i], mesId); } catch (e) { warn('替换单条失败', e); }
    }
  }

  function processMesText(textEl) {
    try {
      if (!textEl || !textEl.isConnected) return;
      if (!settings.enabled) return;
      const mesEl = textEl.closest ? textEl.closest('.mes') : null;
      if (mesEl) {
        const role = mesRole(mesEl);
        if (role === 'system') return;
        if (role === 'user' && !settings.applyToUser) return;
      }
      if (isGenerating()) {          // 生成中先不动，避免图片闪烁
        state.dirty = true;
        scheduleRetry();
        return;
      }
      processRoot(textEl, getMesId(mesEl));
    } catch (e) {
      warn('处理消息失败', e);
    }
  }

  function applyAll() {
    try {
      if (!settings.enabled) return;
      const chat = getChatEl();
      if (!chat) return;
      const list = chat.querySelectorAll('.mes_text');
      for (let i = 0; i < list.length; i += 1) processMesText(list[i]);
      state.retryCount = 0;
    } catch (e) {
      warn('全量渲染失败', e);
    }
  }

  /** 把画面上所有插图还原成原文（原文一字未改，所以能完整还原） */
  function revertRendered() {
    try {
      const sel = '.' + PREFIX + 'block, .' + PREFIX + 'inline, .' + PREFIX + 'fail-text';
      const nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
      for (let i = 0; i < nodes.length; i += 1) {
        const n = nodes[i];
        replaceWithText(n, n.getAttribute('data-lpic-raw') || n.textContent || '');
      }
      if (nodes.length) log('已还原', nodes.length, '处插图');
    } catch (e) {
      warn('还原插图失败', e);
    }
  }

  function rebuildRendered(clearPins) {
    try {
      revertRendered();
      if (clearPins) pinned.clear();
      applyAll();
    } catch (e) {
      warn('重新渲染失败', e);
    }
  }

  function scheduleRetry() {
    if (state.retryTimer) return;
    state.retryTimer = setTimeout(function () {
      state.retryTimer = 0;
      if (!state.dirty) return;
      state.dirty = false;
      state.retryCount += 1;
      if (state.retryCount > 40) { state.retryCount = 0; return; }
      applyAll();
    }, 1200);
  }

  /* ------------------ 监听聊天区域变化 ------------------ */

  function scheduleScan(el) {
    if (!el) return;
    pendingEls.add(el);
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(function () {
      state.scanTimer = 0;
      const list = Array.from(pendingEls);
      pendingEls.clear();
      for (let i = 0; i < list.length; i += 1) processMesText(list[i]);
    }, 260);
  }

  function onMutations(muts) {
    try {
      for (let i = 0; i < muts.length; i += 1) {
        const m = muts[i];

        // ① 变更目标所在的消息
        let t = m.target;
        if (t && t.nodeType === 3) t = t.parentElement;
        if (t && t.closest) {
          const mine = t.closest('.' + PREFIX + 'block, .' + PREFIX + 'inline, .' + PREFIX + 'fail-text, .' + PREFIX + 'lb');
          if (!mine) {
            const near = (t.classList && t.classList.contains('mes_text')) ? t : t.closest('.mes_text');
            if (near) scheduleScan(near);
          }
        }

        // ② 新插入的节点里可能夹着整条新消息
        if (m.type === 'childList' && m.addedNodes && m.addedNodes.length) {
          for (let j = 0; j < m.addedNodes.length; j += 1) {
            const n = m.addedNodes[j];
            if (!n || n.nodeType !== 1) continue;
            if (n.closest && n.closest('.' + PREFIX + 'block, .' + PREFIX + 'inline, .' + PREFIX + 'fail-text')) continue;
            if (n.classList && n.classList.contains('mes_text')) scheduleScan(n);
            else if (n.querySelectorAll) {
              const inner = n.querySelectorAll('.mes_text');
              for (let k = 0; k < inner.length; k += 1) scheduleScan(inner[k]);
            }
          }
        }
      }
    } catch (e) {
      warn('监听回调异常', e);
    }
  }

  function startObserver() {
    const chat = getChatEl();
    if (!chat) return false;
    if (state.observer && state.observedEl === chat) return true;
    try {
      if (state.observer) { state.observer.disconnect(); state.observer = null; }
      state.observer = new MutationObserver(onMutations);
      state.observer.observe(chat, { childList: true, subtree: true, characterData: true });
      state.observedEl = chat;
      log('已开始监听聊天区域');
      applyAll();
      return true;
    } catch (e) {
      warn('启动监听失败', e);
      state.observer = null;
      return false;
    }
  }

  /** 兜底巡检：聊天容器被换掉时自动重挂监听 */
  function startWatchdog() {
    if (state.watchTimer) return;
    state.watchTimer = setInterval(function () {
      try {
        const chat = getChatEl();
        if (!chat) return;
        if (chat !== state.observedEl) {
          log('聊天容器发生变化，重新挂监听');
          startObserver();
          rebuildRendered(false);
        }
      } catch (e) { /* ignore */ }
    }, 5000);
  }

  function applyDisplay() {
    try {
      const imgs = document.querySelectorAll('img.' + PREFIX + 'img');
      for (let i = 0; i < imgs.length; i += 1) {
        imgs[i].style.height = settings.imgHeight + 'px';
        imgs[i].style.cursor = settings.lightbox ? 'zoom-in' : 'default';
      }
      const wraps = document.querySelectorAll('.' + PREFIX + 'block, .' + PREFIX + 'inline');
      for (let i = 0; i < wraps.length; i += 1) {
        wraps[i].classList.toggle(PREFIX + 'block', !!settings.blockMode);
        wraps[i].classList.toggle(PREFIX + 'inline', !settings.blockMode);
      }
    } catch (e) {
      warn('应用显示设置失败', e);
    }
  }

  function scheduleRebuild() {
    if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
    state.rebuildTimer = setTimeout(function () {
      state.rebuildTimer = 0;
      pinned.clear();
      rebuildRendered(false);
    }, 450);
  }

  function onSettingsChanged(key) {
    try {
      if (key === 'enabled') {
        if (settings.enabled) rebuildRendered(false);
        else revertRendered();
        return;
      }
      if (!settings.enabled) return;
      if (key === '__all__') { pinned.clear(); rebuildRendered(false); applyDisplay(); return; }
      if (key === 'tag' || key === 'wrap') { scheduleRebuild(); return; }
      if (key === 'imgHeight' || key === 'blockMode' || key === 'lightbox') { applyDisplay(); return; }
      if (key === 'applyToUser' || key === 'skipCode') { rebuildRendered(false); return; }
      if (key === 'caseSensitive') { pinned.clear(); rebuildRendered(false); return; }
      if (key === 'pinPerMessage' && !settings.pinPerMessage) { pinned.clear(); }
    } catch (e) {
      warn('设置变更处理异常', e);
    }
  }

  /* ======================= 七、交互与事件 ======================= */

  function ensureLightbox() {
    let lb = document.getElementById(PREFIX + 'lb');
    if (lb) return lb;
    try {
      lb = document.createElement('div');
      lb.id = PREFIX + 'lb';
      lb.className = PREFIX + 'lb';
      lb.innerHTML = '<img alt=""><button class="' + PREFIX + 'lb-close" data-lpic-act="lb-close" aria-label="关闭">'
        + icon('close') + '</button>';
      document.body.appendChild(lb);
      lb.addEventListener('click', function (e) {
        const hitClose = e.target.closest ? e.target.closest('[data-lpic-act="lb-close"]') : null;
        if (hitClose || e.target === lb) {
          closeLightbox();
          e.preventDefault();
        }
        e.stopPropagation();
      });
    } catch (e) {
      warn('创建放大层失败', e);
      return null;
    }
    return lb;
  }

  function openLightbox(url, alt) {
    if (!url) return;
    const lb = ensureLightbox();
    if (!lb) return;
    const img = lb.querySelector('img');
    if (img) { img.src = url; img.alt = alt || ''; }
    lb.classList.add(PREFIX + 'open');
  }

  function closeLightbox() {
    const lb = document.getElementById(PREFIX + 'lb');
    if (!lb) return;
    lb.classList.remove(PREFIX + 'open');
    const img = lb.querySelector('img');
    if (img) {
      setTimeout(function () {
        try { img.removeAttribute('src'); } catch (e) { /* ignore */ }
      }, 220);
    }
  }

  function previewKeyword(kw) {
    const entry = lookupKeyword(kw);
    if (!entry || !entry.paths.length) {
      setStatus('关键词「' + kw + '」没有可用图片', 'err');
      return;
    }
    const path = entry.paths[Math.floor(Math.random() * entry.paths.length)];
    getUrl(path).then(function (url) {
      if (url) openLightbox(url, kw);
      else setStatus('图片读取失败：' + path, 'err');
    });
  }

  function handleExtraAct(act, btn) {
    switch (act) {
      case 'kw-preview':
        previewKeyword(btn ? (btn.getAttribute('data-kw') || '') : '');
        break;
      case 'lb-close':
        closeLightbox();
        break;
      default:
        break;
    }
  }

  /** 页面级委托：点正文里的插图 → 放大查看 */
  function onDocClick(e) {
    try {
      const t = e.target;
      if (!t || !t.closest) return;
      const img = t.closest('img.' + PREFIX + 'img');
      if (img && settings.lightbox && img.getAttribute('src')) {
        openLightbox(img.getAttribute('src'), img.getAttribute('alt') || '');
        e.preventDefault();
        return;
      }
      const lb = document.getElementById(PREFIX + 'lb');
      if (lb && t === lb && lb.classList.contains(PREFIX + 'open')) closeLightbox();
    } catch (err) {
      warn('点击处理异常', err);
    }
  }

  function onKeyDown(e) {
    try {
      if (e.key !== 'Escape') return;
      const lb = document.getElementById(PREFIX + 'lb');
      if (lb && lb.classList.contains(PREFIX + 'open')) closeLightbox();
    } catch (err) { /* ignore */ }
  }

  let docBound = false;
  function bindDocEvents() {
    if (docBound) return;
    docBound = true;
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
  }

  function scheduleScanAll() {
    if (state.scanAllTimer) return;
    state.scanAllTimer = setTimeout(function () {
      state.scanAllTimer = 0;
      applyAll();
    }, 320);
  }

  function bindSTEvents() {
    const es = getEventSource();
    const et = getEventTypes();
    if (!es || !et) {
      log('事件系统不可用，将只依赖 DOM 监听');
      return;
    }

    function on(name, fn) {
      if (!name) return;
      try { es.on(name, fn); } catch (e) { /* 壳不支持该事件，忽略 */ }
    }

    on(et.CHAT_CHANGED, function () {
      log('切换聊天，清空随机记忆并重新渲染');
      pinned.clear();
      rebuildRendered(false);
    });

    // 消息被编辑 / 更新 / 切换 swipe：解绑该消息的随机记忆后重新处理
    const mesChanged = function (data) {
      const ids = [];
      try {
        if (typeof data === 'number') ids.push(data);
        else if (data && typeof data === 'object') {
          if (data.mesId != null) ids.push(data.mesId);
          if (data.messageId != null) ids.push(data.messageId);
          if (data.id != null) ids.push(data.id);
        }
      } catch (e) { /* ignore */ }

      if (ids.length) {
        const kill = [];
        ids.forEach(function (id) {
          const pre = String(id) + '|';
          pinned.forEach(function (v, k) { if (k.indexOf(pre) === 0) kill.push(k); });
        });
        kill.forEach(function (k) { pinned.delete(k); });
      } else {
        pinned.clear();
      }
      scheduleScanAll();
    };

    on(et.MESSAGE_EDITED, mesChanged);
    on(et.MESSAGE_UPDATED, mesChanged);
    on(et.MESSAGE_SWIPED, mesChanged);
    on(et.MESSAGE_DELETED, function () { pinned.clear(); scheduleScanAll(); });

    on(et.GENERATION_STARTED, function () { state.generating = true; });
    const genEnd = function () {
      state.generating = false;
      state.dirty = false;
      state.retryCount = 0;
      scheduleScanAll();
    };
    on(et.GENERATION_ENDED, genEnd);
    on(et.GENERATION_STOPPED, genEnd);

    on(et.MESSAGE_RECEIVED, function () { setTimeout(scheduleScanAll, 120); });

    log('已订阅酒馆事件');
  }


  /** 诊断模式下的外部探针：控制台可取证；关闭时不留任何全局变量 */
  function publishDebugApi() {
    try {
      if (!settings.debug) {
        if (window.__lpic) {
          try { delete window.__lpic; } catch (e) { window.__lpic = undefined; }
        }
        return;
      }
      window.__lpic = {
        version: VERSION,
        settings: function () { return Object.assign({}, settings); },
        buildRegex: buildRegex,
        lookupKeyword: lookupKeyword,
        keywords: function () {
          return Array.from(keywordMap.values()).map(function (e) { return { name: e.name, count: e.paths.length }; });
        },
        pinned: function () { return Array.from(pinned.entries()); },
        urls: function () { return Array.from(urlCache.keys()); },
        refreshLibrary: refreshLibrary,
        applyAll: applyAll,
        revertRendered: revertRendered,
        rebuildRendered: rebuildRendered,
      };
      log('诊断探针已挂到 window.__lpic');
    } catch (e) {
      warn('挂载诊断探针失败', e);
    }
  }

  /* ======================= 八、启动 ======================= */

  function init() {
    loadSettings();
    bindDocEvents();
    ensureLightbox();
    mountPanelWithRetry();
    startObserver();
    startWatchdog();
    bindSTEvents();
    refreshLibrary();
    publishDebugApi();
    log('初始化完成 v' + VERSION);
  }

  let booted = false;
  function fire() {
    if (booted) return;   // 幂等：谁先到谁执行
    booted = true;
    try {
      init();
    } catch (e) {
      warn('初始化失败', e);
    }
  }

  // 主通道：等酒馆说「我准备好了」
  try {
    const es = getEventSource();
    const et = getEventTypes();
    if (es && et && et.APP_READY) es.on(et.APP_READY, fire);
  } catch (e) { /* ignore */ }

  // 兜底通道：轮询全局是否就绪，最多 3.5 秒后强制执行
  const t0 = Date.now();
  const bootPoll = setInterval(function () {
    try {
      const ready = !!(window.extension_settings || window.SillyTavern);
      if (ready || Date.now() - t0 > 3500) {
        clearInterval(bootPoll);
        fire();
      }
    } catch (e) {
      clearInterval(bootPoll);
      fire();
    }
  }, 250);

})();
