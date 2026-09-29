/* ============================================================================
 * 本地插图 · local-illustration
 * SillyTavern 客户端扩展（安卓 Tauri Tavern 优先，兼容电脑版标准酒馆）
 * ----------------------------------------------------------------------------
 * 作用：AI 回复里出现约定好的标记时（默认 [img]关键词[/img]），在【渲染阶段】
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
  const VERSION = '1.7.0';
  const LS_KEY = 'lpic_settings';

  const DB_NAME = 'lpic-db';
  const DB_VER = 1;
  const STORE_FILES = 'files';
  const STORE_META = 'meta';
  const META_INDEX = 'index';
  const META_SOURCE = 'source';
  const META_KEYWORDS = 'keywords';
  const META_DIRHANDLE = 'dirhandle';

  const PICK_TIMEOUT_MS = 90000;   // 选择器硬超时：到点必然结算，绝不留下悬空状态
  const BUSY_MAX_MS = 60000;       // 导入锁最长持有时长，超时自动解锁
  const GEN_MAX_DEFER_MS = 3000;   // 因为「正在生成」而推迟渲染的最长时间（超过就改由「文字是否还在变」来判断）
  const STREAM_SETTLE_MS = 800;    // 正文安静多久才算本次输出结束（流式出字期间不插图，避免反复闪烁）
  const ASSURE_SCAN_MS = 15000;    // 保命重扫间隔：无论发生什么，最多这么久一定把该出的图补上
  const SCAN_BURST = [600, 1500, 3000, 6000, 12000];   // 启动后补扫的次数与时间点

  const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'];
  // 浏览器（安卓 WebView / Chrome）能直接播放的视频容器
  const VID_EXT = ['mp4', 'm4v', 'mov', 'webm', 'ogv'];
  // 常见但浏览器放不了的格式：导入时直接跳过并说明原因，免得正文里出现黑框
  const VID_EXT_BAD = ['mkv', 'avi', 'flv', 'wmv', 'rmvb', 'rm', 'mpg', 'mpeg', 'ts', '3gp', 'vob', 'asf', 'divx'];
  const LARGE_VIDEO_BYTES = 20 * 1024 * 1024;   // 单个视频超过这个大小就在导入结果里提醒一下

  const DEFAULT_SETTINGS = {
    enabled: true,          // 总开关
    tag: 'img',             // 图片标记的标签名（可改成任意词防冲突）
    videoTag: 'video',      // 视频标记的标签名（[video]关键词[/video]）
    imgHeight: 200,         // 插图/视频高度（像素）
    blockMode: true,        // true=块级居中，false=行内小图
    applyToUser: false,     // 是否也处理用户消息
    skipCode: true,         // 跳过代码块与行内代码
    pinPerMessage: true,    // 同一条消息内同一关键词固定同一张图
    lightbox: true,         // 点击图片放大查看
    caseSensitive: false,   // 关键词是否区分大小写
    panelOpen: false,       // 设置面板是否展开（默认收起，并记住上次的选择）
    showDiag: false,        // 是否显示诊断工具（默认隐藏，排查问题时才需要）
    debug: false,           // 把调试日志输出到浏览器控制台
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);

  // 运行期状态（不落盘）
  const state = {
    observer: null,
    observedEl: null,
    busy: false,
    busySince: 0,
    cancelPick: null,
    dirty: false,
    retryTimer: 0,
    retryCount: 0,
    scanTimer: 0,
    rebuildTimer: 0,
    saveTimer: 0,
    watchTimer: 0,
    mountTimer: 0,
    armClear: 0,
    armMedia: 0,        // 素材清单里「再点一次删除」的计时器
    generating: false,
    generatingSince: 0, // 从什么时候开始处于生成中（用来识别卡死状态）
    deferSince: 0,      // 从什么时候开始因为「生成中」而推迟渲染
    assureTimer: 0,
    scanAllForce: false, // 下一次全量重扫是否按「确定不在输出中」处理
    lastStorage: null,   // 最近一次存储用量查询结果（诊断信息里用）
    failTimer: 0,
    failRetries: 0,
    dbReady: false,
    dbRetries: 0,
    dbRetryTimer: 0,
    observerTimer: 0,
    dirPickerBlocked: false,     // 实测：系统不允许网页选文件夹
    lastPickerError: null,
    lastFolderTest: null,
    stats: { hits: 0, fails: 0, scans: 0, skips: 0, lastScanAt: 0, lastErr: '' },
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

  /* 最近日志环形缓冲：手机上看控制台很不方便，这里留一份给「环境探测」导出取证 */
  const LOG_RING = [];
  const LOG_RING_MAX = 260;

  function ringPush(level, args) {
    try {
      const parts = [];
      for (let i = 0; i < args.length; i += 1) {
        const x = args[i];
        if (x == null) parts.push(String(x));
        else if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') parts.push(String(x));
        else if (x instanceof Error) parts.push((x.name || 'Error') + ': ' + (x.message || ''));
        else { try { parts.push(JSON.stringify(x)); } catch (e) { parts.push(String(x)); } }
      }
      const d = new Date();
      const t = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      LOG_RING.push(t + ' [' + level + '] ' + parts.join(' '));
      while (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
    } catch (e) { /* ignore */ }
  }

  function log() {
    ringPush('log', arguments);
    if (!settings.debug) return;
    try {
      const a = Array.prototype.slice.call(arguments);
      a.unshift('[lpic]');
      console.log.apply(console, a);
    } catch (e) { /* ignore */ }
  }

  function warn() {
    ringPush('warn', arguments);
    if (!settings.debug) return;   // 默认不刷控制台；记录仍保留，可在「诊断 → 最近日志」里查看
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
    settings.videoTag = clampTag(settings.videoTag) || DEFAULT_SETTINGS.videoTag;
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
    const keepOpen = settings.panelOpen;   // 面板展开与否属于界面偏好，保留它用户才看得见反馈
    settings = Object.assign({}, DEFAULT_SETTINGS, { panelOpen: !!keepOpen });
    persist();
    syncUI();
    if (typeof onSettingsChanged === 'function') onSettingsChanged('__all__');
    setStatus('已恢复默认设置：标记回到 [img]关键词[/img]，图片高度 ' + DEFAULT_SETTINGS.imgHeight + 'px', 'ok');
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
      case 'eye':
        return '<svg width="15" height="15" viewBox="0 0 24 24" ' + p + '><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/></svg>';
      case 'pen':
        return '<svg width="15" height="15" viewBox="0 0 24 24" ' + p + '><path d="M4 16.5V20h3.5L19 8.5 15.5 5z"/><path d="M14 6.5 17.5 10"/></svg>';
      case 'close':
        return '<svg width="18" height="18" viewBox="0 0 24 24" ' + p + '><path d="M6 6l12 12M18 6L6 18"/></svg>';
      case 'play':
        return '<svg width="26" height="26" viewBox="0 0 24 24" ' + p + '><path d="M9.5 6.4v11.2l8.8-5.6z"/></svg>';
      case 'expand':
        return '<svg width="15" height="15" viewBox="0 0 24 24" ' + p + '><path d="M9 3.5H4.5a1 1 0 0 0-1 1V9M15 3.5h4.5a1 1 0 0 1 1 1V9M15 20.5h4.5a1 1 0 0 0 1-1V15M9 20.5H4.5a1 1 0 0 1-1-1V15"/></svg>';
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
      + '      <label class="' + PREFIX + 'switch" title="总开关：关闭后正文里的标记不再显示成图片">'
      + '        <input type="checkbox" data-lpic="enabled">'
      + '        <span class="' + PREFIX + 'slider"></span>'
      + '      </label>'
      + '      <button class="' + PREFIX + 'chev" data-lpic-act="toggle-body" aria-label="展开或收起设置" aria-expanded="false">' + icon('chevron') + '</button>'
      + '    </div>'
      + '  </div>'
      + '  <div class="' + PREFIX + 'sum" id="' + PREFIX + 'sum"></div>'
      + '  <div class="' + PREFIX + 'body">'

      // —— 怎么用 ——
      + '    <div class="' + PREFIX + 'group">'
      + '      <div class="' + PREFIX + 'group-title">怎么用</div>'
      + '      <div class="' + PREFIX + 'hint">共三步：建关键词、加素材、让回复里出现标记。</div>'
      + '      <ol class="' + PREFIX + 'howto">'
      + '        <li>新建一个关键词（例如「挠头」），再点它的「加图/视频」按钮选中素材。素材多的可以用「按文件夹导入」，子文件夹名会自动成为关键词。</li>'
      + '        <li>让回复里出现标记：图片写 <code class="' + PREFIX + 'example-code"></code>，视频写 <code class="' + PREFIX + 'example-code-v"></code>。</li>'
      + '        <li>渲染时标记会变成随机挑中的素材：图片直接显示，视频先显示首帧、点一下才开始播放。</li>'
      + '      </ol>'
      + '      <div class="' + PREFIX + 'hint">消息原文不会被改动：点「编辑」看到的仍然是纯文字，图片和视频只是显示效果。两个标记的名字都可以在下方「标记设置」里改。</div>'
      + '    </div>'

      // —— 关键词与图片库 ——
      + '    <div class="' + PREFIX + 'group">'
      + '      <div class="' + PREFIX + 'group-title">关键词与图片库</div>'
      + '      <div class="' + PREFIX + 'btn-row">'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-primary" data-lpic-act="kw-new">' + icon('plus') + '新建关键词</button>'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="rescan">' + icon('refresh') + '重新渲染</button>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'btn-row">'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="import-folder">' + icon('folder') + '按文件夹导入</button>'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="resync-folder">从上次的文件夹重新同步</button>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'hint">「按文件夹导入」会替换整个素材库：所选目录下每个子文件夹名就是一个关键词，写成「挠头|摸摸头」表示几种写法都认。本机不支持选择文件夹时会自动改成多选。'
      + '<br>图片支持 png / jpg / gif / webp / avif / bmp / svg；视频支持 mp4 / webm / mov（浏览器自带的解码器放不了的格式，例如 mkv、avi，导入时会跳过并告诉你）。</div>'
      + '      <div class="' + PREFIX + 'newkw" id="' + PREFIX + 'newkw" hidden>'
      + '        <input class="' + PREFIX + 'input" type="text" data-lpic-newkw maxlength="60" spellcheck="false" autocomplete="off" placeholder="例如 挠头；多个写法写 挠头|摸摸头">'
      + '        <button class="' + PREFIX + 'mini-btn ' + PREFIX + 'mini-primary" data-lpic-act="kw-new-ok">创建</button>'
      + '        <button class="' + PREFIX + 'mini-btn" data-lpic-act="kw-new-cancel">取消</button>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'status" id="' + PREFIX + 'status"></div>'
      + '      <div class="' + PREFIX + 'kw-head">关键词清单 <span id="' + PREFIX + 'kw-count">0</span></div>'
      + '      <div class="' + PREFIX + 'hint">点关键词右侧的眼睛按钮可以展开它的素材清单：缩略图浏览、单个查看、单个删除。</div>'
      + '      <div class="' + PREFIX + 'kw-list" id="' + PREFIX + 'kw-list"></div>'
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
      + '        <span class="' + PREFIX + 'label">排版方式</span>'
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

      // —— 标记设置 ——
      + '    <div class="' + PREFIX + 'group">'
      + '      <div class="' + PREFIX + 'group-title">标记设置</div>'
      + '      <div class="' + PREFIX + 'row">'
      + '        <span class="' + PREFIX + 'label">图片标记名</span>'
      + '        <input class="' + PREFIX + 'input" type="text" data-lpic="tag" maxlength="16" placeholder="img" spellcheck="false" autocomplete="off">'
      + '      </div>'
      + '      <div class="' + PREFIX + 'row">'
      + '        <span class="' + PREFIX + 'label">视频标记名</span>'
      + '        <input class="' + PREFIX + 'input" type="text" data-lpic="videoTag" maxlength="16" placeholder="video" spellcheck="false" autocomplete="off">'
      + '      </div>'
      + '      <div class="' + PREFIX + 'example">图片：<code class="' + PREFIX + 'example-code"></code></div>'
      + '      <div class="' + PREFIX + 'example">视频：<code class="' + PREFIX + 'example-code-v"></code></div>'
      + '      <div class="' + PREFIX + 'hint" id="' + PREFIX + 'tag-warn" hidden>两个标记不能重名，请改掉其中一个。</div>'
      + '      <div class="' + PREFIX + 'hint">两个名字都能改（例如 localimg / localvideo），避免与其它插件冲突。标记必须用方括号写成 <code>[名字]关键词[/名字]</code>：尖括号会被聊天界面的安全过滤当作 HTML 标签处理，标记会失效。'
      + ' <code>[图片标记名]</code> 只会抽到图片，<code>[视频标记名]</code> 只会抽到视频，两者不会混。</div>'
      + '    </div>'

      // —— 数据 ——
      + '    <div class="' + PREFIX + 'group">'
      + '      <div class="' + PREFIX + 'group-title">数据</div>'
      + '      <div class="' + PREFIX + 'hint">导入的素材只保存在本机浏览器数据库里，不上传、不联网。清除浏览器数据、换设备或卸载扩展都会丢失，请保留原始文件。'
      + '<br>视频比图片大得多，而浏览器本地库容量有限：放几十个大视频可能装不下，建议只放短片段。</div>'
      + '      <div class="' + PREFIX + 'example" id="' + PREFIX + 'store">本机占用：查询中…</div>'
      + '      <div class="' + PREFIX + 'btn-row">'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="store-refresh">刷新占用</button>'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="store-persist">申请持久保存</button>'
      + '      </div>'
      + '      <div class="' + PREFIX + 'hint">「申请持久保存」是向系统申请不被自动清理：磁盘紧张时浏览器会优先清掉这类数据。申请被拒也不影响使用，只是要多留意保留原文件。</div>'
      + '      <div class="' + PREFIX + 'btn-row">'
      + '        <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost ' + PREFIX + 'btn-danger" data-lpic-act="clear">' + icon('trash') + '清空图片库</button>'
      + '      </div>'
      + '    </div>'

      // —— 诊断（默认隐藏，需要时再打开） ——
      + '    <div class="' + PREFIX + 'group">'
      + '      <div class="' + PREFIX + 'group-title">诊断</div>'
      + '      <div class="' + PREFIX + 'row"><span class="' + PREFIX + 'label">显示诊断工具</span>'
      + '        <label class="' + PREFIX + 'switch"><input type="checkbox" data-lpic="showDiag"><span class="' + PREFIX + 'slider"></span></label></div>'
      + '      <div class="' + PREFIX + 'diag" id="' + PREFIX + 'diag" hidden>'
      + '        <div class="' + PREFIX + 'hint">以下信息用于排查问题，平时不用打开。遇到「标记没有变成图片」之类的情况时，先点「环境信息」，再点「复制」，把结果提供给插件作者即可。</div>'
      + '        <div class="' + PREFIX + 'btn-row">'
      + '          <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="probe">' + icon('refresh') + '环境信息</button>'
      + '          <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="probe-copy">复制</button>'
      + '          <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="logs">最近日志</button>'
      + '        </div>'
      + '        <pre class="' + PREFIX + 'probe-out" id="' + PREFIX + 'probe-out" hidden></pre>'
      + '        <div class="' + PREFIX + 'row"><span class="' + PREFIX + 'label">输出调试日志到控制台</span>'
      + '          <label class="' + PREFIX + 'switch"><input type="checkbox" data-lpic="debug"><span class="' + PREFIX + 'slider"></span></label></div>'
      + '        <div class="' + PREFIX + 'btn-row">'
      + '          <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="probe-folder">测试文件夹选择能力</button>'
      + '          <button class="' + PREFIX + 'btn ' + PREFIX + 'btn-ghost" data-lpic-act="reset">恢复默认设置</button>'
      + '        </div>'
      + '        <div class="' + PREFIX + 'hint">「测试文件夹选择能力」会弹一次选择窗口，用于确认本机能否读取文件夹信息（能读取才能按文件夹名自动分关键词）。</div>'
      + '      </div>'
      + '    </div>'

      + '  </div>'
      + '</div>';
  }

  /** 面板里显示的标记示例（kind='video' 时给视频标记的示例） */
  function sampleMarker(kind) {
    const isVideo = (kind === 'video');
    const tag = clampTag(isVideo ? settings.videoTag : settings.tag)
      || (isVideo ? DEFAULT_SETTINGS.videoTag : DEFAULT_SETTINGS.tag);
    return '[' + tag + ']关键词[/' + tag + ']';
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

    const sampleImg = sampleMarker('img');
    panel.querySelectorAll('.' + PREFIX + 'example-code').forEach(function (el) {
      el.textContent = sampleImg;
    });
    const sampleVid = sampleMarker('video');
    panel.querySelectorAll('.' + PREFIX + 'example-code-v').forEach(function (el) {
      el.textContent = sampleVid;
    });

    // 两个标记重名时明确提醒（重名会让视频标记失效）
    const tagWarn = document.getElementById(PREFIX + 'tag-warn');
    if (tagWarn) tagWarn.hidden = videoTagEnabled();

    const hv = document.getElementById(PREFIX + 'h-val');
    if (hv) hv.textContent = settings.imgHeight + 'px';

    // 诊断工具默认隐藏，由「显示诊断工具」开关控制
    const diag = document.getElementById(PREFIX + 'diag');
    if (diag) diag.hidden = !settings.showDiag;

    const collapsed = !settings.panelOpen;
    panel.classList.toggle(PREFIX + 'collapsed', collapsed);
    const chev = panel.querySelector('.' + PREFIX + 'chev');
    if (chev) chev.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

    renderSummary();
  }

  /** 收起时也要让人一眼看懂当前状态 */
  function renderSummary() {
    const el = document.getElementById(PREFIX + 'sum');
    if (!el) return;
    let text;
    if (!indexList.length) {
      text = '还没导入素材 · 点右侧箭头展开设置';
    } else {
      let vids = 0;
      for (let i = 0; i < indexList.length; i += 1) {
        if (recordKind(indexList[i]) === 'video') vids += 1;
      }
      text = keywordList.length + ' 个关键词 · ' + (indexList.length - vids) + ' 张图片';
      if (vids) text += ' · ' + vids + ' 个视频';
      if (!settings.enabled) text += ' · 已关闭';
      text += ' · 点右侧箭头展开设置';
    }
    el.textContent = text;
  }

  /** 状态文字（导入流程会频繁调用）。kind='wait' 时整条可点，用来取消等待 */
  function setStatus(text, kind) {
    const el = document.getElementById(PREFIX + 'status');
    if (!el) return;
    el.textContent = String(text == null ? '' : text);
    el.classList.toggle(PREFIX + 'status-ok', kind === 'ok');
    el.classList.toggle(PREFIX + 'status-err', kind === 'err');
    el.classList.toggle(PREFIX + 'status-wait', kind === 'wait');
    el.classList.toggle(PREFIX + 'status-clickable', kind === 'wait');
    if (kind === 'wait') el.setAttribute('data-lpic-act', 'cancel-pick');
    else el.removeAttribute('data-lpic-act');
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
    mount.addEventListener('focusin', onPanelFocusIn);
    // 面板内的点击不再往外冒，避免穿透触发酒馆/其他插件的行为
    mount.addEventListener('click', function (e) {
      try { e.stopPropagation(); } catch (err) { /* ignore */ }
    });
  }

  /** 手机上软键盘会挡住输入框：聚焦后等键盘弹出，再把输入框滚到屏幕中间 */
  function onPanelFocusIn(e) {
    try {
      const el = e.target;
      if (!el || !el.closest) return;
      if (!el.closest('[data-lpic-newkw], [data-lpic-kwedit]')) return;
      setTimeout(function () {
        try {
          if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (err) { /* 不支持就忽略 */ }
      }, 280);
    } catch (err) { /* ignore */ }
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
        settings.panelOpen = !settings.panelOpen;
        persist();
        syncUI();
        break;
      case 'logs':
        showRecentLogs();
        break;
      case 'store-refresh':
        refreshStorageInfo(true);
        break;
      case 'store-persist':
        requestPersist();
        break;
      case 'cancel-pick':
        // 自助解锁：无论选择器那边发生什么，点这一下立刻恢复可用
        if (typeof state.cancelPick === 'function') {
          const fn = state.cancelPick;
          state.cancelPick = null;
          try { fn(); } catch (e) { warn('取消等待失败', e); }
        }
        unlockBusy();
        setStatus('已取消等待，可以重新点「加图」了');
        break;
      case 'clear':
        if (typeof requestClearLibrary === 'function') requestClearLibrary(btn);
        break;
      case 'rescan':
        // 手动点「重新渲染」时不受任何「生成中」状态影响，点了就必须立刻生效
        state.generating = false;
        state.generatingSince = 0;
        state.deferSince = 0;
        rebuildRendered(true);
        setStatus('已重新渲染一遍。若画面仍是文字，可打开下方「显示诊断工具」查看「环境信息」', 'ok');
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
  let indexList = [];              // 轻量索引：[{ path, kwId, name, size }]
  let keywordList = [];            // 关键词（唯一权威）：[{ id, name, names, ts }]
  let keywordMap = new Map();      // 小写写法 -> { id, name, paths: [path...] }（只用于查词）
  let countMap = new Map();        // kwId -> 图片数（只用于展示）
  let lastImportInfo = null;       // 最近一次导入的原始文件信息（环境探测用）
  const urlCache = new Map();      // path -> objectURL（懒加载缓存）
  const pinned = new Map();        // `${mesId}|${小写关键词}` -> path（同一消息固定同图）

  /* ---- 导入锁：带时间戳，超时自愈，绝不永久卡死 ---- */
  function isBusy() {
    if (!state.busy) return false;
    if (Date.now() - (state.busySince || 0) > BUSY_MAX_MS) {
      warn('检测到残留的导入锁，已自动解锁');
      unlockBusy();
      return false;
    }
    return true;
  }
  function lockBusy() { state.busy = true; state.busySince = Date.now(); }
  function unlockBusy() {
    state.busy = false;
    state.busySince = 0;
    state.cancelPick = null;
  }

  /* ---- 名称与转义工具 ---- */
  function normName(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' '); }

  function splitNames(s) {
    return String(s == null ? '' : s).split(/[|｜,，;；]/).map(normName).filter(Boolean);
  }

  /** 主名在前、别名去重（忽略大小写重复） */
  function uniqNames(primary, rest) {
    const out = [primary];
    const seen = new Set([primary.toLowerCase()]);
    (rest || []).forEach(function (n) {
      const k = String(n).toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(n);
    });
    return out;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function newKeywordId() {
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 用 id 或任意别名找关键词，返回下标（找不到 -1） */
  function findKeywordIndex(byIdOrName) {
    const key = normName(byIdOrName).toLowerCase();
    if (!key) return -1;
    for (let i = 0; i < keywordList.length; i += 1) {
      if (String(keywordList[i].id).toLowerCase() === key) return i;
    }
    for (let i = 0; i < keywordList.length; i += 1) {
      if (String(keywordList[i].name).toLowerCase() === key) return i;
    }
    for (let i = 0; i < keywordList.length; i += 1) {
      const names = keywordList[i].names || [];
      for (let j = 0; j < names.length; j += 1) {
        if (normName(names[j]).toLowerCase() === key) return i;
      }
    }
    return -1;
  }

  function getKeyword(byIdOrName) {
    const i = findKeywordIndex(byIdOrName);
    return i < 0 ? null : keywordList[i];
  }

  function pathsOfKeyword(id) {
    const out = [];
    for (let i = 0; i < indexList.length; i += 1) {
      if (indexList[i] && indexList[i].kwId === id) out.push(indexList[i].path);
    }
    return out;
  }

  /** 打开图片库。注意：失败绝不缓存结果 —— 否则一次偶然失败会让整场（直到刷新）都用不了 */
  function openDB() {
    if (dbPromise) return dbPromise;

    const attempt = new Promise(function (resolve) {
      let req;
      let settled = false;
      let timer = 0;

      function done(db, why) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = 0; }
        state.dbReady = !!db;
        if (!db) log('图片库这次没打开（' + (why || 'unknown') + '），稍后会自动重试');
        resolve(db);
      }

      try {
        if (!window.indexedDB) { done(null, 'no-indexeddb'); return; }
        req = indexedDB.open(DB_NAME, DB_VER);
      } catch (e) {
        warn('打开图片库异常', e);
        done(null, 'exception');
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
      req.onsuccess = function () { done(req.result); };
      req.onerror = function () { warn('打开图片库失败', req.error); done(null, 'error'); };
      req.onblocked = function () { done(null, 'blocked'); };
      // 有的环境既不成功也不报错，加超时避免整场卡住
      timer = setTimeout(function () { done(null, 'timeout'); }, 8000);
    });

    dbPromise = attempt.then(function (db) {
      if (!db) dbPromise = null;      // 关键：失败不缓存，下次调用重新尝试
      return db;
    });
    return dbPromise;
  }

  /** 图片库没打开时自动补一次重试，避免用户必须刷新网页 */
  function scheduleLibraryRetry() {
    if (state.dbRetryTimer) return;
    state.dbRetries += 1;
    if (state.dbRetries > 8) return;
    state.dbRetryTimer = setTimeout(function () {
      state.dbRetryTimer = 0;
      dbPromise = null;
      refreshLibrary();
    }, 3000);
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

  /** 删掉库里的一条记录（按主键） */
  function dbDelete(store, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        if (!db || key == null) { resolve(false); return; }
        try {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).delete(key);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { warn('删除单条失败', tx.error); resolve(false); };
          tx.onabort = function () { resolve(false); };
        } catch (e) {
          warn('删除单条异常', e);
          resolve(false);
        }
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

  function dbDelete(store, keys) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        if (!db || !keys || !keys.length) { resolve(0); return; }
        try {
          const tx = db.transaction(store, 'readwrite');
          const os = tx.objectStore(store);
          for (let i = 0; i < keys.length; i += 1) {
            try { os.delete(keys[i]); } catch (e) { warn('删除单条失败', e); }
          }
          tx.oncomplete = function () { resolve(keys.length); };
          tx.onerror = function () { resolve(0); };
          tx.onabort = function () { resolve(0); };
        } catch (e) {
          warn('删除异常', e);
          resolve(0);
        }
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
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /* ======================= 五、导入与关键词索引 ======================= */

  /** 这个文件属于哪一类：'img' 图片 / 'video' 可播放视频 / 'badVid' 浏览器放不了的视频 / '' 不认识 */
  function fileKind(f) {
    try {
      if (!f) return '';
      const t = String(f.type || '').toLowerCase();
      const name = String(f.name || '').toLowerCase();
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot + 1) : '';
      if (t.indexOf('image/') === 0 || IMG_EXT.indexOf(ext) >= 0) return 'img';
      if (t.indexOf('video/') === 0) return (VID_EXT_BAD.indexOf(ext) >= 0) ? 'badVid' : 'video';
      if (VID_EXT.indexOf(ext) >= 0) return 'video';
      if (VID_EXT_BAD.indexOf(ext) >= 0) return 'badVid';
      return '';
    } catch (e) {
      return '';
    }
  }

  function isMediaFile(f) {
    const k = fileKind(f);
    return k === 'img' || k === 'video';
  }

  /** 已入库的记录属于哪一类：优先看存的类型，其次看扩展名（老记录没有类型信息时按图片算） */
  function recordKind(rec) {
    try {
      if (!rec) return 'img';
      const t = String(rec.type || '').toLowerCase();
      if (t.indexOf('video/') === 0) return 'video';
      if (t.indexOf('image/') === 0) return 'img';
      const p = String(rec.path || '').toLowerCase();
      const dot = p.lastIndexOf('.');
      const ext = dot >= 0 ? p.slice(dot + 1) : '';
      return (VID_EXT.indexOf(ext) >= 0) ? 'video' : 'img';
    } catch (e) {
      return 'img';
    }
  }

  /** 打开系统选择器（isDir=true 时尝试目录模式，仅供「文件夹能力实测」使用）。
   *  无论成功 / 取消 / 超时 / 异常，Promise 都一定会结算，绝不留下悬空的等待状态。 */
  function pickWithInput(isDir) {
    return new Promise(function (resolve) {
      let input = null;
      let settled = false;
      let hardTimer = 0;
      let verifyTimer = 0;
      let visHandler = null;
      let focusHandler = null;

      function cleanup() {
        if (hardTimer) { clearTimeout(hardTimer); hardTimer = 0; }
        if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = 0; }
        try { if (visHandler) document.removeEventListener('visibilitychange', visHandler); } catch (e) { /* ignore */ }
        try { if (focusHandler) window.removeEventListener('focus', focusHandler); } catch (e) { /* ignore */ }
        try { if (input && input.parentNode) input.remove(); } catch (e) { /* ignore */ }
        if (state.cancelPick === cancelFn) state.cancelPick = null;
      }

      function collect() {
        try {
          // 图片和视频都收；浏览器放不了的视频也收进来，好在导入结果里明确告诉用户为什么没导入
          return Array.prototype.slice.call(input.files || []).filter(function (f) {
            const k = fileKind(f);
            return k === 'img' || k === 'video' || k === 'badVid';
          });
        } catch (e) {
          return [];
        }
      }

      function finish(list, reason) {
        if (settled) return;
        settled = true;
        cleanup();
        log('选择器结算（' + (reason || 'done') + '），文件数 ' + ((list || []).length));
        resolve(list || []);
      }

      // 用户点了状态条上的「取消等待」
      const cancelFn = function () { finish(collect(), 'user-cancel'); };
      state.cancelPick = cancelFn;

      // 页面重新可见（安卓 WebView 打开选择器时会隐藏页面，这比 focus 可靠）→ 延迟复查
      function scheduleVerify(delay) {
        if (settled || verifyTimer) return;
        verifyTimer = setTimeout(function () {
          verifyTimer = 0;
          if (settled) return;
          const got = collect();
          if (got.length) { finish(got, 'verify'); return; }
          // 有的设备把结果送回来更晚，再给一次机会
          verifyTimer = setTimeout(function () {
            verifyTimer = 0;
            if (settled) return;
            finish(collect(), 'verify-late');
          }, 1400);
        }, delay);
      }

      visHandler = function () {
        if (settled) return;
        if (document.visibilityState !== 'visible') return;
        scheduleVerify(900);
      };
      focusHandler = function () {
        if (settled) return;
        scheduleVerify(1500);
      };

      try {
        input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'image/*,video/*';
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

        input.addEventListener('change', function () { finish(collect(), 'change'); });
        input.addEventListener('cancel', function () { finish([], 'cancel'); });
        try { document.addEventListener('visibilitychange', visHandler); } catch (e) { /* ignore */ }
        try { window.addEventListener('focus', focusHandler); } catch (e) { /* ignore */ }

        // 硬超时兜底：所有侦测都失效时也不会永久悬空
        hardTimer = setTimeout(function () {
          hardTimer = 0;
          finish(collect(), 'timeout');
        }, PICK_TIMEOUT_MS);

        input.click();
      } catch (e) {
        warn('打开选择器失败', e);
        finish([], 'error');
      }
    });
  }

  /** 建查询表：关键词由用户定义（权威），图片挂在 keywordList 的 id 上 */
  function buildIndex() {
    keywordMap = new Map();
    countMap = new Map();               // kwId -> { img, video }（只用于展示）
    const byId = new Map();
    for (let i = 0; i < keywordList.length; i += 1) byId.set(keywordList[i].id, keywordList[i]);

    for (let i = 0; i < indexList.length; i += 1) {
      const rec = indexList[i];
      if (!rec || !rec.path) continue;
      const k = byId.get(rec.kwId);
      if (!k) continue;                         // 挂在已删除关键词上的记录，忽略
      const kind = recordKind(rec);             // 'img' 或 'video'
      let c = countMap.get(rec.kwId);
      if (!c) { c = { img: 0, video: 0 }; countMap.set(rec.kwId, c); }
      c[kind] += 1;

      const names = (k.names && k.names.length) ? k.names : [k.name];
      for (let j = 0; j < names.length; j += 1) {
        const nm = normName(names[j]);
        if (!nm) continue;
        const key = nm.toLowerCase();
        let entry = keywordMap.get(key);
        if (!entry) {
          entry = { id: k.id, name: k.name, paths: [], imgPaths: [], vidPaths: [] };
          keywordMap.set(key, entry);
        }
        // 图片和视频分开放：写 [img] 只会抽到图片，写 [video] 只会抽到视频
        const pool = (kind === 'video') ? entry.vidPaths : entry.imgPaths;
        if (pool.indexOf(rec.path) < 0) pool.push(rec.path);
        if (entry.paths.indexOf(rec.path) < 0) entry.paths.push(rec.path);
      }
    }
  }

  /** 某个关键词下的素材数量（图片与视频分开算） */
  function kwCounts(id) {
    const c = countMap.get(id);
    return c ? c : { img: 0, video: 0 };
  }

  function kwTotal(id) {
    const c = kwCounts(id);
    return c.img + c.video;
  }

  function kwCountText(id) {
    const c = kwCounts(id);
    if (c.img && c.video) return c.img + ' 图 · ' + c.video + ' 视频';
    if (c.video) return c.video + ' 个视频';
    return c.img + ' 张';
  }

  /** 取该关键词下指定类别的素材池 */
  function poolOf(entry, kind) {
    if (!entry) return [];
    return (kind === 'video') ? (entry.vidPaths || []) : (entry.imgPaths || []);
  }

  /** 查关键词：命中「且该类素材非空」才返回，否则 null（返回 null 就保留原文）。
   *  kind='img' 只认图片，kind='video' 只认视频 —— 两类从不混。 */
  function lookupKeyword(kw, kind) {
    const s = String(kw == null ? '' : kw).trim();
    if (!s) return null;
    const want = (kind === 'video') ? 'video' : 'img';
    if (!settings.caseSensitive) {
      const e = keywordMap.get(s.toLowerCase());
      return (e && poolOf(e, want).length) ? e : null;
    }
    let hit = null;
    keywordMap.forEach(function (e) {
      if (hit || e.name !== s) return;
      if (poolOf(e, want).length) hit = e;
    });
    return hit;
  }

  function pickPath(entry, mesId, kw, kind) {
    const pool = poolOf(entry, kind);
    if (!pool.length) return null;
    const key = String(mesId) + '|' + String(kw).toLowerCase() + '|' + (kind === 'video' ? 'v' : 'i');
    if (settings.pinPerMessage && pinned.has(key)) return pinned.get(key);
    const path = pool[Math.floor(Math.random() * pool.length)];
    if (settings.pinPerMessage) pinned.set(key, path);
    return path;
  }

  function yieldToUI() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  function saveIndex() {
    return dbPut(STORE_META, [{ key: META_INDEX, list: indexList }]);
  }

  function saveKeywords() {
    return dbPut(STORE_META, [{ key: META_KEYWORDS, list: keywordList }]);
  }

  /** 图片库变了以后：先把画面还原成原文，再清缓存并重新渲染 */
  function afterLibraryChanged() {
    try {
      revertRendered();
      revokeUrls();
      pinned.clear();
      buildIndex();
      updateStats();
      applyAll();
    } catch (e) {
      warn('刷新画面失败', e);
    }
  }

  /** 把一批素材（图片 + 视频）全部导入到指定关键词名下 */
  async function doImport(files, keywordIdOrName) {
    const kw = getKeyword(keywordIdOrName);
    if (!kw) {
      setStatus('找不到关键词，请先「新建关键词」再导入素材', 'err');
      return 0;
    }

    const total = files.length;
    const now = Date.now();
    const records = [];
    const list = [];
    state.lastImportNotes = '';   // 有额外说明（视频体积 / 跳过的格式）时由调用方保留这条提示
    state.lastImportStats = null;
    const skipped = [];           // 浏览器放不了的视频等，最后一起说明
    const used = new Set();
    let vidCount = 0;
    let vidBytes = 0;
    let bigCount = 0;
    let bigBytes = 0;
    for (let i = 0; i < indexList.length; i += 1) used.add(indexList[i].path);

    const prefix = 'k/' + kw.id + '/';

    for (let i = 0; i < total; i += 1) {
      const f = files[i];
      const kind = fileKind(f);
      if (kind === 'badVid') {
        if (skipped.length < 8) skipped.push(String(f.name || '') || '未命名');
        continue;                                  // 浏览器放不了的格式直接不收，免得正文里出现黑框
      }
      if (kind !== 'img' && kind !== 'video') continue;

      const fname = String(f.name || ('media' + i));
      let path = prefix + fname;
      let n = 1;
      while (used.has(path)) { n += 1; path = prefix + n + '_' + fname; }
      used.add(path);

      const size = Number(f.size) || 0;
      if (kind === 'video') {
        vidCount += 1;
        vidBytes += size;
        if (size >= LARGE_VIDEO_BYTES) { bigCount += 1; bigBytes += size; }
      }

      records.push({
        path: path,
        kwId: kw.id,
        name: fname,
        type: f.type || '',
        size: size,
        ts: now,
        blob: f,
      });
      list.push({ path: path, kwId: kw.id, name: fname, size: size });

      if (i % 25 === 0) {
        setStatus('正在读取素材 ' + (i + 1) + ' / ' + total + ' …', 'wait');
        await yieldToUI();
      }
    }

    if (!records.length) {
      setStatus('没有读到可用的素材（图片支持 png/jpg/gif/webp/avif/bmp/svg，视频支持 mp4/webm/mov）'
        + (skipped.length ? '；已跳过：' + skipped.join('、') : ''), 'err');
      return 0;
    }

    const CHUNK = 80;
    for (let i = 0; i < records.length; i += CHUNK) {
      await dbPut(STORE_FILES, records.slice(i, i + CHUNK));
      setStatus('正在入库 ' + Math.min(i + CHUNK, records.length) + ' / ' + records.length + ' …', 'wait');
      await yieldToUI();
    }

    indexList = indexList.concat(list);
    await saveIndex();
    await dbPut(STORE_META, [{
      key: META_SOURCE,
      info: { kw: kw.name, count: list.length, total: indexList.length, ts: now },
    }]);

    afterLibraryChanged();

    // 导入结果一次说清：视频体积、大文件提醒、被跳过的格式
    state.lastImportStats = {
      added: list.length, vid: vidCount, vidBytes: vidBytes,
      big: bigCount, bigBytes: bigBytes, skipped: skipped.slice(),
    };
    const notes = buildImportNotes(state.lastImportStats);
    if (notes.length) {
      state.lastImportNotes = notes.join('；');
      setStatus('已导入 ' + list.length + ' 个素材到「' + kw.name + '」：' + state.lastImportNotes,
        (bigCount || skipped.length) ? 'err' : 'ok');
    }
    log('导入完成：', kw.name, list.length, '个（视频', vidCount, '），库内共', indexList.length, '个');
    return list.length;
  }

  /** 文件夹导入的最终结果：关键词数、本次导入量、库内图片/视频数，以及体积与跳过格式的说明 */
  function reportImportResult(prefix, rootName, total) {
    let imgTotal = 0;
    let vidTotal = 0;
    for (let i = 0; i < indexList.length; i += 1) {
      if (recordKind(indexList[i]) === 'video') { vidTotal += 1; } else { imgTotal += 1; }
    }
    let text = prefix + '：' + keywordList.length + ' 个关键词 · 本次导入 ' + total + ' 个素材'
      + '（库内 ' + imgTotal + ' 图' + (vidTotal ? ' / ' + vidTotal + ' 视频' : '') + '）';
    const notes = buildImportNotes(state.lastFolderStats);
    if (notes.length) text += '；' + notes.join('；');
    setStatus(text, notes.length ? 'err' : 'ok');
  }

  /** 统一的「这次导入有什么要注意的」文案（单关键词导入与文件夹导入共用） */
  function buildImportNotes(s) {
    const notes = [];
    if (!s) return notes;
    if (s.vid) notes.push(s.vid + ' 个视频共 ' + fmtSize(s.vidBytes));
    if (s.big) notes.push('其中 ' + s.big + ' 个较大（合计 ' + fmtSize(s.bigBytes) + '），请注意本地数据库容量');
    if (s.skipped && s.skipped.length) {
      notes.push('已跳过 ' + s.skipped.length + ' 个浏览器无法播放的视频：' + s.skipped.join('、'));
    }
    return notes;
  }

  /** 唯一导入入口：先有目标关键词，再多选图片 */
  async function importFlow(keywordIdOrName) {
    const kw = getKeyword(keywordIdOrName);
    if (!kw) { setStatus('请先「新建关键词」，再点它的「加图/视频」按钮', 'err'); return; }
    if (isBusy()) {
      setStatus('上一次导入还没结束，点这里可以取消等待', 'wait');
      return;
    }

    lockBusy();
    try {
      setStatus('正在等待选择图片或视频…（点这里取消）', 'wait');
      const files = await pickWithInput();

      // 留一份原始信息给「环境探测」，便于判断设备能力
      lastImportInfo = {
        at: Date.now(),
        count: files.length,
        samples: files.slice(0, 5).map(function (f) {
          return {
            name: String(f.name || ''),
            type: String(f.type || ''),
            size: Number(f.size) || 0,
            rel: String(f.webkitRelativePath || ''),
          };
        }),
      };

      if (!files.length) {
        setStatus('已取消，没有导入任何素材');
        return;
      }

      const added = await doImport(files, kw.id);
      // 有视频体积 / 跳过格式之类的说明时，保留 doImport 给的详细提示
      if (added && !state.lastImportNotes) {
        setStatus('已把 ' + added + ' 个素材导入「' + kw.name + '」 · 共 '
          + keywordList.length + ' 个关键词 / ' + indexList.length + ' 个素材', 'ok');
      }
    } catch (e) {
      warn('导入失败', e);
      setStatus('导入失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      unlockBusy();
    }
  }

  /* ---- 按文件夹导入：文件夹名 = 关键词（需要浏览器支持目录授权） ---- */

  function hasDirPicker() {
    return typeof window.showDirectoryPicker === 'function';
  }

  async function collectDirFiles(dirHandle, out, depth) {
    if (depth > 3 || out.length > 3000) return;
    let it;
    try { it = dirHandle.entries(); } catch (e) { return; }
    for await (const entry of it) {
      const handle = entry[1];
      if (!handle) continue;
      if (handle.kind === 'file') {
        try {
          const f = await handle.getFile();
          if (isMediaFile(f)) out.push(f);
        } catch (e) { /* 单个文件读不了就跳过 */ }
      } else if (handle.kind === 'directory') {
        await collectDirFiles(handle, out, depth + 1);
      }
    }
  }

  /** 枚举根目录：每个子文件夹 = 一个关键词；根目录下的散图归到根目录名 */
  async function scanRootDir(root) {
    const groups = [];
    const loose = [];
    let it;
    try { it = root.entries(); } catch (e) { return groups; }
    for await (const entry of it) {
      const name = String(entry[0] || '');
      const handle = entry[1];
      if (!handle) continue;
      if (handle.kind === 'directory') {
        const files = [];
        await collectDirFiles(handle, files, 0);
        const names = splitNames(name);
        if (files.length && names.length) groups.push({ names: names, files: files });
      } else if (handle.kind === 'file') {
        try {
          const f = await handle.getFile();
          if (isMediaFile(f)) loose.push(f);
        } catch (e) { /* ignore */ }
      }
    }
    if (loose.length) {
      const rootNames = splitNames(root.name || '未分组');
      if (rootNames.length) groups.push({ names: rootNames, files: loose });
    }
    return groups;
  }

  /** 同名的分组先合并（例如同时存在 叹气/ 与 叹气|唉声叹气/ 两个文件夹时，把别名并到一起） */
  function mergeSameNameGroups(groups) {
    const map = new Map();
    (groups || []).forEach(function (g) {
      const key = String((g.names && g.names[0]) || '').toLowerCase();
      if (!key || !g.files || !g.files.length) return;
      if (!map.has(key)) map.set(key, { names: (g.names || []).slice(), files: [] });
      const target = map.get(key);
      (g.names || []).forEach(function (n) {
        const k = String(n).toLowerCase();
        if (!target.names.some(function (x) { return String(x).toLowerCase() === k; })) target.names.push(n);
      });
      target.files = target.files.concat(g.files);
    });
    return Array.from(map.values());
  }

  /** 覆盖式导入：先确认有图，再清库，然后按分组建关键词并倒图 */
  async function importGroups(rawGroups) {
    const groups = mergeSameNameGroups(rawGroups);
    let totalFiles = 0;
    groups.forEach(function (g) { totalFiles += g.files.length; });
    if (!totalFiles) {
      setStatus('没找到图片或视频。请把素材放进以关键词命名的子文件夹（例如 根目录/挠头/1.png）', 'err');
      return 0;
    }

    // 先确认扫到了东西，再清库 —— 避免扫到一半把旧数据擦掉
    revertRendered();
    revokeUrls();
    pinned.clear();
    await dbClear(STORE_FILES);
    await dbClear(STORE_META);
    indexList = [];
    keywordList = [];

    let total = 0;
    const agg = { added: 0, vid: 0, vidBytes: 0, big: 0, bigBytes: 0, skipped: [] };
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i];
      const created = await createKeyword(g.names.join('|'));
      const kw = created.ok ? created.keyword : getKeyword(g.names[0]);
      if (!kw) continue;
      setStatus('正在导入「' + kw.name + '」的 ' + g.files.length + ' 个素材…', 'wait');
      total += await doImport(g.files, kw.id);
      const s = state.lastImportStats;                 // 汇总各关键词的说明，最后一起报
      if (s) {
        agg.vid += s.vid; agg.vidBytes += s.vidBytes;
        agg.big += s.big; agg.bigBytes += s.bigBytes;
        (s.skipped || []).forEach(function (n) { if (agg.skipped.length < 8) agg.skipped.push(n); });
      }
    }
    agg.added = total;
    state.lastFolderStats = agg;

    afterLibraryChanged();
    log('按文件夹导入完成：', keywordList.length, '个关键词 /', total, '个素材');
    return total;
  }

  /** 用目录句柄做一次覆盖式同步 */
  async function syncFromRoot(root) {
    setStatus('正在扫描文件夹…', 'wait');
    return importGroups(await scanRootDir(root));
  }

  /** 从文件名猜关键词（没有文件夹信息时的兜底） */
  function namePrefix(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '').trim();
    if (!base) return '';
    const m = base.match(/^(.+?)[\s_\-.#（(．]+/);
    return (m && m[1] ? m[1] : base).trim();
  }

  /** 按相对路径分组：根/关键词/x.png → 关键词；根/x.png → 用根目录名 */
  function groupFilesByFolder(files) {
    const map = new Map();
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const rel = String(f.webkitRelativePath || '').replace(/\\/g, '/');
      const parts = rel.split('/').filter(Boolean);
      let kw = '';
      if (parts.length >= 3) kw = parts[1];               // 根/关键词/…/图
      else if (parts.length === 2) kw = parts[0];         // 根/图 → 用根目录名
      else kw = namePrefix(f.name || '');                 // 没有路径信息时兜底
      const names = splitNames(kw);
      if (!names.length) continue;
      const key = names[0].toLowerCase();
      if (!map.has(key)) map.set(key, { names: names.slice(), files: [] });
      const group = map.get(key);
      names.forEach(function (n) {
        const k = n.toLowerCase();
        if (!group.names.some(function (x) { return String(x).toLowerCase() === k; })) group.names.push(n);
      });
      group.files.push(f);
    }
    return Array.from(map.values());
  }

  /** 目录授权这条路被系统拦下了 —— 记住它，下次直接走「可选文件夹的输入框」那条路 */
  function markDirPickerBlocked(errName, errMsg) {
    state.dirPickerBlocked = true;
    state.lastPickerError = { name: errName || 'Error', message: String(errMsg || ''), at: Date.now() };
    log('已记下：目录授权接口本机不可用（' + errName + '），下次直接走另一条路');
  }

  const DIR_BLOCKED_TIP = '这台设备的系统不允许网页选文件夹，请改用「新建关键词 → 加图」导入图片';

  async function importFromFolder() {
    if (isBusy()) { setStatus('上一次导入还没结束，点这里可以取消等待', 'wait'); return; }
    if (!hasDirPicker() && state.dirPickerBlocked) {
      setStatus(DIR_BLOCKED_TIP, 'err');
      return;
    }
    lockBusy();
    try {
      // ---- 路线 A：真正的目录授权（电脑版 Chrome / 支持该接口的浏览器） ----
      if (hasDirPicker() && !state.dirPickerBlocked) {
        let root = null;
        setStatus('正在打开文件夹选择器…', 'wait');
        try {
          root = await window.showDirectoryPicker({ mode: 'read' });
        } catch (e) {
          const nm = (e && e.name) ? e.name : 'Error';
          if (nm === 'AbortError') {
            setStatus('已取消，没有导入任何图片');
            return;
          }
          // 有的环境接口存在但会被系统直接拒绝，且不弹任何窗口 —— 与"用户取消"区分开，并自动改走路线 B
          warn('目录授权不可用', nm, e);
          markDirPickerBlocked(nm, e && e.message);
          log('目录授权被系统拒绝，改用可选文件夹的输入框继续');
        }
        if (root) {
          const total = await syncFromRoot(root);
          if (!total) return;
          try { await dbPut(STORE_META, [{ key: META_DIRHANDLE, handle: root }]); } catch (e) { /* 记不住就算了 */ }
          try { await dbPut(STORE_META, [{ key: META_SOURCE, info: { folder: root.name, kw: keywordList.length, total: total, ts: Date.now() } }]); } catch (e) { /* ignore */ }
          lastImportInfo = { at: Date.now(), count: total, mode: 'folder', folder: root.name, samples: [] };
          setStatus('按文件夹导入完成：' + keywordList.length + ' 个关键词 · ' + total + ' 张图片', 'ok');
          return;
        }
      }

      // ---- 路线 B：支持相对路径的文件输入框（Chrome / 部分安卓浏览器可用） ----
      setStatus('请在弹出的窗口里选择图片根目录…', 'wait');
      const files = await pickWithInput(true);
      if (!files.length) { setStatus('已取消，没有导入任何图片'); return; }

      const withPath = files.filter(function (f) { return String(f.webkitRelativePath || '').length > 0; });
      if (!withPath.length) {
        setStatus('这次没拿到文件夹信息（这台设备的选择器只给文件）。请改用「新建关键词 → 加图」导入。', 'err');
        return;
      }

      const groups = groupFilesByFolder(files);
      const total = await importGroups(groups);
      if (!total) return;

      const rootName = String(withPath[0].webkitRelativePath || '').split('/')[0] || '文件夹';
      try { await dbPut(STORE_META, [{ key: META_SOURCE, info: { folder: rootName, kw: keywordList.length, total: total, ts: Date.now() } }]); } catch (e) { /* ignore */ }
      lastImportInfo = { at: Date.now(), count: total, mode: 'folder-path', folder: rootName, samples: [] };
      reportImportResult('按文件夹导入完成', rootName, total);
    } catch (e) {
      warn('按文件夹导入失败', e);
      setStatus('按文件夹导入失败：' + (e && e.message ? e.message : e) + '（可改用「加图/视频」多选）', 'err');
    } finally {
      unlockBusy();
    }
  }

  /** 用上次记住的目录句柄再同步一次（不用重新选文件夹） */
  async function resyncFromFolder() {
    if (isBusy()) { setStatus('上一次导入还没结束，点这里可以取消等待', 'wait'); return; }
    if (!hasDirPicker() || state.dirPickerBlocked) {
      setStatus('这台设备没法记住文件夹授权，请直接点上面的「按文件夹导入」', 'err');
      return;
    }
    lockBusy();
    try {
      const rec = await dbGet(STORE_META, META_DIRHANDLE);
      const root = rec ? rec.handle : null;
      if (!root) { setStatus('还没记下文件夹，先点一次「按文件夹导入」', 'err'); return; }

      try {
        if (typeof root.queryPermission === 'function') {
          let perm = await root.queryPermission({ mode: 'read' });
          if (perm !== 'granted' && typeof root.requestPermission === 'function') {
            perm = await root.requestPermission({ mode: 'read' });
          }
          if (perm !== 'granted') {
            setStatus('没有拿到文件夹权限，请重新点「按文件夹导入」', 'err');
            return;
          }
        }
      } catch (e) { warn('目录权限检查失败', e); }

      const total = await syncFromRoot(root);
      if (!total) return;
      lastImportInfo = { at: Date.now(), count: total, mode: 'folder', folder: root.name, samples: [] };
      reportImportResult('已从「' + (root.name || '文件夹') + '」同步', root.name, total);
    } catch (e) {
      warn('重新同步失败', e);
      setStatus('重新同步失败：' + (e && e.message ? e.message : e) + '（可重新点「按文件夹导入」）', 'err');
    } finally {
      unlockBusy();
    }
  }

  /** 启动时载入：关键词 + 图片索引，并顺手做一次旧数据自愈迁移 */
  async function refreshLibrary() {
    try {
      const kwRec = await dbGet(STORE_META, META_KEYWORDS);
      keywordList = (kwRec && Array.isArray(kwRec.list))
        ? kwRec.list.filter(function (k) { return k && k.id && k.name; })
        : [];

      const rec = await dbGet(STORE_META, META_INDEX);
      indexList = (rec && Array.isArray(rec.list)) ? rec.list : [];

      await migrateLegacyIndex();

      buildIndex();
      updateStats();
      applyAll();

      if (state.dbReady) state.dbRetries = 0;
      else scheduleLibraryRetry();      // 库没打开就自动重试，别让用户去刷新网页

      log('图片库已就绪：', keywordList.length, '个关键词 /', indexList.length, '张图');
    } catch (e) {
      warn('读取图片库失败', e);
      scheduleLibraryRetry();
    }
  }

  /** v1.0.0 的索引没有 kwId（关键词来自文件夹名）→ 就地自愈成新模型 */
  async function migrateLegacyIndex() {
    let changed = false;
    const byName = new Map();
    const byId = new Map();
    for (let i = 0; i < keywordList.length; i += 1) {
      byName.set(String(keywordList[i].name).toLowerCase(), keywordList[i]);
      byId.set(keywordList[i].id, keywordList[i]);
    }

    for (let i = 0; i < indexList.length; i += 1) {
      const it = indexList[i];
      if (!it || !it.path) continue;
      if (it.kwId && byId.has(it.kwId)) continue;      // 已是新模型

      const legacyName = normName(it.keyword || '未命名') || '未命名';
      let target = byName.get(legacyName.toLowerCase());
      if (!target) {
        const extra = (it.names || []).map(normName).filter(Boolean);
        target = {
          id: newKeywordId(),
          name: legacyName,
          names: uniqNames(legacyName, extra),
          ts: Date.now(),
        };
        keywordList.push(target);
        byName.set(legacyName.toLowerCase(), target);
        byId.set(target.id, target);
      }
      it.kwId = target.id;
      changed = true;
    }

    if (changed) {
      await saveKeywords();
      await saveIndex();
      log('已把旧版图片数据迁移到新的关键词模型');
    }
  }

  function updateStats() {
    const total = indexList.length;
    const kwCount = keywordList.length;
    renderSummary();               // 收起状态下的一行摘要也要跟着更新
    refreshStorageInfo(false);     // 素材有增减时顺带更新「本机占用」（空库时也要刷新，否则会一直停在「查询中」）
    if (!total && !kwCount) {
      setStatus('还没有关键词。先点上面的「新建关键词」建一个（比如「挠头」），再点它的「加图/视频」按钮导入素材');
      renderKeywordList();
      return;
    }
    let bytes = 0;
    let vids = 0;
    for (let i = 0; i < indexList.length; i += 1) {
      bytes += Number(indexList[i].size) || 0;
      if (recordKind(indexList[i]) === 'video') vids += 1;
    }
    const imgCount = total - vids;
    let parts = imgCount + ' 张图片';
    if (vids) parts += ' · ' + vids + ' 个视频';
    setStatus('已就绪：' + kwCount + ' 个关键词 · ' + parts + ' · 占用 ' + fmtSize(bytes), 'ok');
    renderKeywordList();
  }

  function renderKeywordList() {
    const listEl = document.getElementById(PREFIX + 'kw-list');
    const countEl = document.getElementById(PREFIX + 'kw-count');
    if (!listEl) return;

    if (countEl) countEl.textContent = String(keywordList.length);
    if (!keywordList.length) {
      listEl.innerHTML = '<div class="' + PREFIX + 'kw-empty">还没有关键词。先点上面的「新建关键词」建一个（比如「挠头」），再点它的「加图/视频」按钮导入素材。</div>';
      return;
    }

    listEl.innerHTML = keywordList.map(function (k) {
      const n = kwTotal(k.id);
      const id = esc(k.id);
      const alias = (k.names && k.names.length > 1)
        ? '<span class="' + PREFIX + 'kw-alias">也认：' + k.names.slice(1).map(esc).join(' / ') + '</span>'
        : '';
      return '<div class="' + PREFIX + 'kw-row" data-kw-id="' + id + '">'
        + '<div class="' + PREFIX + 'kw-main">'
        + '<span class="' + PREFIX + 'kw-name">' + esc(k.name) + '</span>'
        + '<span class="' + PREFIX + 'kw-num">' + esc(kwCountText(k.id)) + '</span>'
        + alias
        + '</div>'
        + '<div class="' + PREFIX + 'kw-acts">'
        + '<button class="' + PREFIX + 'mini-btn ' + PREFIX + 'mini-primary" data-lpic-act="kw-add" data-kw-id="' + id + '">' + icon('plus') + '加图/视频</button>'
        + (n ? '<button class="' + PREFIX + 'icon-btn" title="查看素材清单" data-lpic-act="kw-list" data-kw-id="' + id + '">' + icon('eye') + '</button>' : '')
        + '<button class="' + PREFIX + 'icon-btn" title="改名" data-lpic-act="kw-rename" data-kw-id="' + id + '">' + icon('pen') + '</button>'
        + '<button class="' + PREFIX + 'icon-btn ' + PREFIX + 'icon-danger" title="删除" data-lpic-act="kw-del" data-kw-id="' + id + '">' + icon('trash') + '</button>'
        + '</div>'
        + '<div class="' + PREFIX + 'kw-edit" hidden>'
        + '<input class="' + PREFIX + 'input" type="text" data-lpic-kwedit maxlength="60" spellcheck="false" autocomplete="off" placeholder="关键词；多个写法用 | 分隔">'
        + '<button class="' + PREFIX + 'mini-btn ' + PREFIX + 'mini-primary" data-lpic-act="kw-rename-ok" data-kw-id="' + id + '">确定</button>'
        + '<button class="' + PREFIX + 'mini-btn" data-lpic-act="kw-edit-cancel" data-kw-id="' + id + '">取消</button>'
        + '</div>'
        + '<div class="' + PREFIX + 'kw-confirm" hidden></div>'
        + '<div class="' + PREFIX + 'kw-media" hidden></div>'
        + '</div>';
    }).join('');
  }

  /* ---- 关键词：新建 / 改名 / 删除 / 合并 ---- */

  function kwRow(id) {
    try {
      return document.querySelector('.' + PREFIX + 'kw-row[data-kw-id="' + String(id).replace(/"/g, '') + '"]');
    } catch (e) {
      return null;
    }
  }

  function closeRowPanels(id) {
    const row = kwRow(id);
    if (!row) return;
    const edit = row.querySelector('.' + PREFIX + 'kw-edit');
    const conf = row.querySelector('.' + PREFIX + 'kw-confirm');
    if (edit) edit.hidden = true;
    if (conf) { conf.hidden = true; conf.innerHTML = ''; }
  }

  function openNewKeywordRow() {
    const box = document.getElementById(PREFIX + 'newkw');
    if (!box) return;
    box.hidden = false;
    const input = box.querySelector('[data-lpic-newkw]');
    if (input) {
      input.value = '';
      try { input.focus(); } catch (e) { /* ignore */ }
    }
  }

  function closeNewKeywordRow() {
    const box = document.getElementById(PREFIX + 'newkw');
    if (box) box.hidden = true;
  }

  /** 新建关键词（纯逻辑；返回 { ok, keyword, reason }） */
  async function createKeyword(rawNames) {
    const names = splitNames(rawNames);
    if (!names.length) return { ok: false, reason: '关键词不能是空的，先给它起个名字' };
    const primary = names[0];
    if (findKeywordIndex(primary) >= 0) return { ok: false, reason: '已经有「' + primary + '」这个关键词了' };
    const rec = {
      id: newKeywordId(),
      name: primary,
      names: uniqNames(primary, names.slice(1)),
      ts: Date.now(),
    };
    keywordList.push(rec);
    await saveKeywords();
    buildIndex();
    updateStats();
    return { ok: true, keyword: rec };
  }

  async function createKeywordFromUI() {
    const box = document.getElementById(PREFIX + 'newkw');
    const input = box ? box.querySelector('[data-lpic-newkw]') : null;
    const res = await createKeyword(input ? input.value : '');
    if (!res.ok) { setStatus(res.reason, 'err'); return; }
    if (input) input.value = '';
    closeNewKeywordRow();
    setStatus('已新建关键词「' + res.keyword.name + '」，点它的「加图」按钮就能往里面加图片', 'ok');
  }

  function openRenameRow(id) {
    const row = kwRow(id);
    if (!row) return;
    const k = getKeyword(id);
    const edit = row.querySelector('.' + PREFIX + 'kw-edit');
    const input = edit ? edit.querySelector('[data-lpic-kwedit]') : null;
    if (!edit || !input) return;
    input.value = k ? (k.names && k.names.length ? k.names.join('|') : k.name) : '';
    edit.hidden = false;
    try { input.focus(); } catch (e) { /* ignore */ }
  }

  /** 改名（纯逻辑）。若改成一个已存在的名字，则直接合并过去，避免出现重名 */
  async function renameKeyword(id, rawNames) {
    const k = getKeyword(id);
    if (!k) return { ok: false, reason: '这个关键词已经不在了' };
    const names = splitNames(rawNames);
    if (!names.length) return { ok: false, reason: '关键词不能是空的' };

    const primary = names[0];
    const otherIdx = findKeywordIndex(primary);
    if (otherIdx >= 0 && keywordList[otherIdx].id !== k.id) {
      const target = keywordList[otherIdx];
      await mergeKeywordInto(k.id, target.id);
      return { ok: true, merged: true, keyword: target, before: k.name };
    }

    const before = k.name;
    k.name = primary;
    k.names = uniqNames(primary, names.slice(1));
    await saveKeywords();
    buildIndex();
    updateStats();
    rebuildRendered(false);
    return { ok: true, keyword: k, before: before };
  }

  async function confirmRename(id) {
    const row = kwRow(id);
    const input = row ? row.querySelector('[data-lpic-kwedit]') : null;
    const res = await renameKeyword(id, input ? input.value : '');
    if (!res.ok) { setStatus(res.reason, 'err'); return; }
    if (res.merged) return;                    // 合并流程里已经给过提示了
    closeRowPanels(res.keyword.id);
    setStatus('已把「' + res.before + '」改名为「' + res.keyword.name + '」', 'ok');
  }

  function openDeleteConfirm(id) {
    const row = kwRow(id);
    const k = getKeyword(id);
    if (!row || !k) return;
    const box = row.querySelector('.' + PREFIX + 'kw-confirm');
    if (!box) return;

    const n = kwTotal(k.id);
    const others = keywordList.filter(function (x) { return x.id !== k.id; });
    const idAttr = esc(k.id);

    let html = '<span class="' + PREFIX + 'confirm-text">'
      + (n ? ('「' + esc(k.name) + '」下面还有 ' + n + ' 个素材，要如何处理？')
        : ('删除空关键词「' + esc(k.name) + '」？'))
      + '</span><div class="' + PREFIX + 'confirm-acts">';

    if (n) {
      html += '<button class="' + PREFIX + 'mini-btn ' + PREFIX + 'mini-danger" data-lpic-act="kw-del-all" data-kw-id="' + idAttr + '">连图一起删</button>';
      if (others.length) {
        html += '<select class="' + PREFIX + 'select" data-lpic-merge>'
          + others.map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>'; }).join('')
          + '</select>'
          + '<button class="' + PREFIX + 'mini-btn ' + PREFIX + 'mini-primary" data-lpic-act="kw-merge" data-kw-id="' + idAttr + '">合并过去</button>';
      }
    } else {
      html += '<button class="' + PREFIX + 'mini-btn ' + PREFIX + 'mini-danger" data-lpic-act="kw-del-all" data-kw-id="' + idAttr + '">确认删除</button>';
    }
    html += '<button class="' + PREFIX + 'mini-btn" data-lpic-act="kw-edit-cancel" data-kw-id="' + idAttr + '">取消</button></div>';

    box.innerHTML = html;
    box.hidden = false;
  }

  async function deleteKeyword(id) {
    const k = getKeyword(id);
    if (!k) return;
    try {
      const paths = pathsOfKeyword(k.id);
      if (paths.length) {
        const CHUNK = 80;
        for (let i = 0; i < paths.length; i += CHUNK) {
          await dbDelete(STORE_FILES, paths.slice(i, i + CHUNK));
          setStatus('正在删除图片 ' + Math.min(i + CHUNK, paths.length) + ' / ' + paths.length + ' …', 'wait');
          await yieldToUI();
        }
        const gone = new Set(paths);
        indexList = indexList.filter(function (r) { return !gone.has(r.path); });
        await saveIndex();
      }
      keywordList = keywordList.filter(function (x) { return x.id !== k.id; });
      await saveKeywords();
      afterLibraryChanged();
      setStatus('已删除关键词「' + k.name + '」' + (paths.length ? '，连同它的 ' + paths.length + ' 张图片' : ''), 'ok');
    } catch (e) {
      warn('删除关键词失败', e);
      setStatus('删除失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  async function mergeKeywordInto(fromId, toId) {
    const from = getKeyword(fromId);
    const to = getKeyword(toId);
    if (!from || !to || from.id === to.id) return;
    try {
      let moved = 0;
      for (let i = 0; i < indexList.length; i += 1) {
        if (indexList[i] && indexList[i].kwId === from.id) {
          indexList[i].kwId = to.id;   // 图片记录只认 kwId，改一处即可
          moved += 1;
        }
      }
      if (moved) await saveIndex();
      keywordList = keywordList.filter(function (x) { return x.id !== from.id; });
      await saveKeywords();
      afterLibraryChanged();
      setStatus('已把「' + from.name + '」的 ' + moved + ' 张图并到「' + to.name + '」，并删除「' + from.name + '」', 'ok');
    } catch (e) {
      warn('合并关键词失败', e);
      setStatus('合并失败：' + (e && e.message ? e.message : e), 'err');
    }
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
      revertRendered();
      revokeUrls();
      pinned.clear();
      await dbClear(STORE_FILES);
      await dbClear(STORE_META);
      indexList = [];
      keywordList = [];
      buildIndex();
      updateStats();
      setStatus('已清空：关键词和图片都不再记录（原始图片文件不会被删）', 'ok');
      log('图片库已清空');
    } catch (e) {
      warn('清空图片库失败', e);
      setStatus('清空失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  /* ---- 本机存储用量与「持久保存」申请 ----
   * 浏览器给网页的存储配额是按设备剩余空间动态算的（Chrome 系上限约为总容量的 60%），
   * 光看这个数字意义不大，真正要看的是「已经用了多少」。另外磁盘紧张时浏览器会
   * 自动清理这类数据，IndexedDB 还是优先被清的对象 —— 所以这里提供申请持久保存的入口。 */

  function queryStorageEstimate() {
    return new Promise(function (resolve) {
      try {
        const st = window.navigator && window.navigator.storage;
        if (!st || typeof st.estimate !== 'function') { resolve(null); return; }
        st.estimate().then(function (est) {
          resolve(est ? { usage: Number(est.usage) || 0, quota: Number(est.quota) || 0 } : null);
        }).catch(function () { resolve(null); });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function queryPersisted() {
    return new Promise(function (resolve) {
      try {
        const st = window.navigator && window.navigator.storage;
        if (!st || typeof st.persisted !== 'function') { resolve(null); return; }
        st.persisted().then(function (v) { resolve(!!v); }).catch(function () { resolve(null); });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /** 刷新「本机占用」那一行（quiet=true 表示不打断用户，只更新文字） */
  async function refreshStorageInfo(quiet) {
    const el = document.getElementById(PREFIX + 'store');
    if (!el) return;
    let ownBytes = 0;
    for (let i = 0; i < indexList.length; i += 1) ownBytes += Number(indexList[i].size) || 0;

    const est = await queryStorageEstimate();
    if (!est || !est.quota) {
      el.textContent = '本机占用：插件素材 ' + fmtSize(ownBytes) + ' · 本机不支持查询总配额（不影响使用）';
      state.lastStorage = { ownBytes: ownBytes, usage: est ? est.usage : 0, quota: 0, persisted: null, ts: Date.now() };
      if (quiet) setStatus('已刷新：本机不支持查询总配额', 'ok');
      return;
    }

    const persisted = await queryPersisted();
    state.lastStorage = {
      ownBytes: ownBytes,
      usage: est.usage,
      quota: est.quota,
      persisted: persisted,
      ts: Date.now(),
    };
    let text = '本机占用：插件素材 ' + fmtSize(ownBytes)
      + ' · 本机已用 ' + fmtSize(est.usage) + ' / 配额约 ' + fmtSize(est.quota);
    if (persisted === true) text += ' · 已持久保存';
    else if (persisted === false) text += ' · 未持久保存';
    el.textContent = text;

    if (quiet) {
      setStatus('已刷新：本机已用 ' + fmtSize(est.usage) + '，配额约 ' + fmtSize(est.quota), 'ok');
    }
  }

  /** 申请持久保存：磁盘紧张时不被系统优先清理 */
  async function requestPersist() {
    const st = window.navigator && window.navigator.storage;
    if (!st || typeof st.persist !== 'function') {
      setStatus('本机不支持申请持久保存（不影响正常使用）', 'err');
      await refreshStorageInfo(false);
      return;
    }
    try {
      const already = await queryPersisted();
      if (already === true) {
        setStatus('已经是持久保存状态，无需重复申请', 'ok');
        await refreshStorageInfo(false);
        return;
      }
      const granted = await st.persist();
      setStatus(granted
        ? '已获得持久保存：系统清理空间时不会优先动插件数据'
        : '未获得持久保存：本机拒绝了申请（常见于没有把酒馆装成应用/加到主屏幕）。功能不受影响，但请保留原始文件。',
        granted ? 'ok' : 'err');
      log('持久保存申请结果：' + granted);
    } catch (e) {
      warn('申请持久保存失败', e);
      setStatus('申请持久保存失败：' + (e && e.message ? e.message : e), 'err');
    }
    await refreshStorageInfo(false);
  }

  /* ======================= 六、渲染替换（核心） =======================
   * 只改画面，不改数据：把标记所在的文本节点换成图片节点，
   * ctx.chat[i].mes 原封不动 —— 所以点「编辑」看到的仍是纯文本。
   * ================================================================= */

  const pendingEls = new Set();

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 按标签名现建正则（每次新建，避免 /g 的 lastIndex 陷阱）。只认方括号写法 */
  /** 视频标记是否可用：留空、或与图片标记同名（会互相打架）时视为不可用 */
  function videoTagEnabled() {
    const v = clampTag(settings.videoTag);
    if (!v) return false;
    const i = clampTag(settings.tag) || DEFAULT_SETTINGS.tag;
    return v.toLowerCase() !== i.toLowerCase();
  }

  /** 按类别现建正则：kind='img' 用图片标记，kind='video' 用视频标记。
   *  两类各认各的标记，从不混用（[img] 只会出图片，[video] 只会出视频）。 */
  function buildRegex(kind) {
    const isVideo = (kind === 'video');
    if (isVideo && !videoTagEnabled()) return null;
    const raw = isVideo ? settings.videoTag : (clampTag(settings.tag) || DEFAULT_SETTINGS.tag);
    const tag = escapeRe(clampTag(raw) || DEFAULT_SETTINGS.tag);
    return new RegExp('\\[\\s*' + tag + '\\s*\\]([^\\n]{1,60}?)\\[\\s*\\/\\s*' + tag + '\\s*\\]', 'g');
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

  /** 是否正在生成。
   *  只认「真的收到过生成开始事件」这一个信号。
   *  曾经还靠猜 DOM（停止按钮可见 / .mes.streaming）—— 这两种判断在不同酒馆版本里表现不一，
   *  一旦猜错，渲染会被无休止推迟，表现就是「图没了、只剩文字」。宁可不避让，也不能不渲染。 */
  function isGeneratingNow() {
    if (!state.generating) return false;
    if (state.generatingSince && Date.now() - state.generatingSince > 90000) {
      log('生成状态已持续超过 90 秒，判定为卡住，自动清除');
      state.generating = false;
      state.generatingSince = 0;
      return false;
    }
    return true;
  }

  /** 要不要因为「正在生成」而推迟这次渲染？
   *  只在刚开始的几秒内推辞；超过上限就把生成标记一并清掉，
   *  这样同一次扫描里的其它消息不会被轮流推迟（修掉「只有第一条消息出图」的 bug）。 */
  function shouldDeferRender(force) {
    if (force) { state.deferSince = 0; return false; }
    if (!isGeneratingNow()) {
      state.deferSince = 0;
      return false;
    }
    if (!state.deferSince) state.deferSince = Date.now();
    if (Date.now() - state.deferSince > GEN_MAX_DEFER_MS) {
      log('等生成结束已超过上限，判定为卡住：清除生成标记，改由「文字是否还在变」来判断');
      state.generating = false;
      state.generatingSince = 0;
      state.deferSince = 0;
      return false;
    }
    return true;
  }

  /* ------------------ 流式输出保护：正文还在变就先不插图 ------------------
   * 酒馆是流式出字的：每来一个新 token 就会重绘一次正文，我们插进去的图会被冲掉。
   * 如果这时立刻再插一次，画面就会疯狂闪、还一直换图（对眼睛极不友好）。
   * 所以：先给正文算一个「原文签名」，签名变了说明还在输出 —— 那就先不动，
   * 等它安静下来（STREAM_SETTLE_MS 内不再变化）再一次性插图。
   * 签名把「已渲染成图片的位置」按原始标记来算，所以渲染前后签名一致，不会自己触发自己。
   * ---------------------------------------------------------------------- */

  const settleMap = new WeakMap();   // mes_text 元素 -> { sig, since }

  function messageSignature(textEl) {
    let out = '';
    try {
      (function walk(n, depth) {
        if (!n || depth > 60) return;
        const kids = n.childNodes || n.children || [];
        for (let i = 0; i < kids.length; i += 1) {
          const c = kids[i];
          if (!c) continue;
          if (c.nodeType === 3) { out += c.nodeValue || ''; continue; }
          if (c.nodeType !== 1) continue;
          const raw = c.getAttribute ? c.getAttribute('data-lpic-raw') : null;
          if (raw != null) { out += raw; continue; }    // 我们自己插的图：按原标记算，且不往里走
          walk(c, depth + 1);
        }
      })(textEl, 0);
    } catch (e) { /* ignore */ }
    return out;
  }

  /** 正文是否已经「安静」下来了（安静够久才认为本次输出结束） */
  function isSettled(textEl) {
    const sig = messageSignature(textEl);
    const rec = settleMap.get(textEl);
    const now = Date.now();
    if (!rec || rec.sig !== sig) {
      settleMap.set(textEl, { sig: sig, since: now });
      return false;
    }
    return (now - rec.since) >= STREAM_SETTLE_MS;
  }

  /** 正文里是否还有「等着被换成图/视频」的标记（已经换好的不算，避免白白空转） */
  function markerMaybePresent(textEl) {
    try {
      const t = textEl.textContent || '';
      const reImg = buildRegex('img');
      if (reImg && reImg.test(t)) return true;
      const reVid = buildRegex('video');
      if (reVid && reVid.test(t)) return true;
      return false;
    } catch (e) {
      return false;
    }
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

  /** 生成一个素材节点：图片直接显示；视频先显示首帧 + 播放按钮，点了才播 */
  function makeMediaNode(entry, mesId, kw, raw, kind) {
    const isVideo = (kind === 'video');
    const wrap = document.createElement('span');
    wrap.className = PREFIX + (settings.blockMode ? 'block' : 'inline') + (isVideo ? (' ' + PREFIX + 'media-vid') : '');
    wrap.setAttribute('data-lpic-kw', kw);
    wrap.setAttribute('data-lpic-raw', raw);
    wrap.setAttribute('data-lpic-kind', isVideo ? 'video' : 'img');

    let el;
    if (isVideo) {
      el = document.createElement('video');
      el.className = PREFIX + 'vid';
      el.preload = 'metadata';                 // 只读元数据与首帧，不把整个视频拉进来
      el.controls = false;                     // 点了播放才给进度条
      try { el.playsInline = true; } catch (e) { /* ignore */ }
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.setAttribute('preload', 'metadata');
    } else {
      el = document.createElement('img');
      el.className = PREFIX + 'img';
      el.alt = kw;
      el.decoding = 'async';
      el.draggable = false;
    }
    el.style.height = settings.imgHeight + 'px';
    el.style.maxWidth = '100%';
    el.style.cursor = (isVideo || settings.lightbox) ? 'zoom-in' : 'default';
    wrap.appendChild(el);

    if (isVideo) {
      const play = document.createElement('span');
      play.className = PREFIX + 'play';
      play.setAttribute('data-lpic-media', 'play');
      play.setAttribute('role', 'button');
      play.setAttribute('aria-label', '播放视频');
      play.innerHTML = icon('play');
      wrap.appendChild(play);

      const zoom = document.createElement('span');
      zoom.className = PREFIX + 'zoom';
      zoom.setAttribute('data-lpic-media', 'open');
      zoom.setAttribute('role', 'button');
      zoom.setAttribute('aria-label', '放大播放');
      zoom.innerHTML = icon('expand');
      wrap.appendChild(zoom);
    }

    const path = pickPath(entry, mesId, kw, kind);
    if (!path) return document.createTextNode(raw);

    log('插入素材：类型=' + (isVideo ? '视频' : '图片') + ' 关键词=' + kw + ' 文件=' + path);
    getUrl(path).then(function (url) {
      if (!url) {
        state.stats.fails += 1;
        state.stats.lastErr = '素材读取失败：' + path;
        warn('素材读取失败', path);
        toFailText(wrap, raw);
        scheduleFailRetry();
        return;
      }

      el.addEventListener('error', function () {
        state.stats.fails += 1;
        state.stats.lastErr = (isVideo ? '视频无法播放：' : '图片解码失败：') + path;
        warn(isVideo ? '视频无法播放（多半是浏览器不支持的编码格式）' : '图片解码失败', path);
        toFailText(wrap, raw);
        scheduleFailRetry();
      });

      if (isVideo) {
        el.addEventListener('loadedmetadata', function () {
          log('视频已就绪：' + path + ' (' + el.videoWidth + 'x' + el.videoHeight + ')');
          // 少数环境下要挪一下播放位置才会画出首帧
          try { if (!el.videoWidth) el.currentTime = 0.001; } catch (e) { /* ignore */ }
        });
        el.addEventListener('loadeddata', function () { wrap.classList.add(PREFIX + 'ready'); });
        el.addEventListener('ended', function () {          // 放完恢复成「点一下才播」的样子
          wrap.classList.remove(PREFIX + 'playing');
          try { el.controls = false; } catch (e) { /* ignore */ }
        });
      } else {
        el.addEventListener('load', function () {
          wrap.classList.add(PREFIX + 'ready');
          log('插图已加载：' + path + ' (' + el.naturalWidth + 'x' + el.naturalHeight + ')');
        });
      }

      el.src = url;
      if (!isVideo && el.complete && el.naturalWidth) wrap.classList.add(PREFIX + 'ready');

      // 5 秒后自查：素材没出来就把现场状态记进日志（手机上看不到控制台，只能靠这个取证）
      setTimeout(function () {
        try {
          const ok = isVideo ? (el.readyState >= 1 || el.videoWidth > 0) : (el.naturalWidth > 0);
          if (ok) {
            if (!wrap.classList.contains(PREFIX + 'ready')) {
              wrap.classList.add(PREFIX + 'ready');
              log('素材补上 ready 标记（加载事件未触发）：' + path);
            }
            return;
          }
          if (!wrap.parentNode) return;          // 已经被还原成文字了，不用管
          warn('素材自查异常：' + JSON.stringify({
            path: path,
            isVideo: isVideo,
            hasSrc: !!el.getAttribute('src'),
            srcHead: String(el.getAttribute('src') || '').slice(0, 24),
            readyState: el.readyState,
            size: isVideo ? (el.videoWidth + 'x' + el.videoHeight) : (el.naturalWidth + 'x' + el.naturalHeight),
            wrap: wrap.className,
            dbReady: state.dbReady,
            urls: urlCache.size,
          }));
          urlCache.delete(path);               // 丢掉可能失效的缓存，强制重取一次
          getUrl(path).then(function (u2) {
            if (!u2) { warn('素材重取失败：' + path); return; }
            if (u2 !== el.getAttribute('src')) {
              el.src = u2;
              log('素材已重新取回：' + path);
            }
          });
        } catch (e) { /* ignore */ }
      }, 5000);
    });

    return wrap;
  }

  function processTextNode(node, mesId) {
    const text = node.nodeValue;
    if (!text) return;

    // 图片标记与视频标记各扫一遍，再按出现位置合并（这样两种标记可以混在正文任意位置）
    const hits = [];
    ['img', 'video'].forEach(function (kind) {
      const re = buildRegex(kind);
      if (!re) return;
      const ms = Array.from(text.matchAll(re));
      for (let i = 0; i < ms.length; i += 1) hits.push({ kind: kind, m: ms[i] });
    });
    if (!hits.length) return;
    hits.sort(function (a, b) { return a.m.index - b.m.index; });

    const frag = document.createDocumentFragment();
    let last = 0;
    let changed = 0;

    for (let i = 0; i < hits.length; i += 1) {
      const kind = hits[i].kind;
      const m = hits[i].m;
      if (m.index < last) continue;               // 与上一处范围重叠，跳过
      const kw = String(m[1] == null ? '' : m[1]).trim();
      const entry = lookupKeyword(kw, kind);
      if (!entry) continue;                       // 该类素材没有对应的 → 原样保留

      const idx = m.index;
      const raw = m[0];
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      frag.appendChild(makeMediaNode(entry, mesId, kw, raw, kind));
      last = idx + raw.length;
      changed += 1;
    }

    if (!changed) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (!node.parentNode) return;
    state.stats.hits += changed;
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

  function processMesText(textEl, force) {
    try {
      if (!textEl || !textEl.isConnected) return;
      // force=true 时不受「生成中」影响（保命重扫与用户主动操作都用它）
      if (!settings.enabled) return;
      const mesEl = textEl.closest ? textEl.closest('.mes') : null;
      if (mesEl) {
        const role = mesRole(mesEl);
        if (role === 'system') return;
        if (role === 'user' && !settings.applyToUser) return;
      }
      if (!force) {
        if (shouldDeferRender()) {   // 生成中先不动（有很短的时间上限，避免万一卡住就永远不出图）
          state.dirty = true;
          scheduleRetry();
          return;
        }
        // 流式输出保护：正文还在变就先别插 —— 否则会被酒馆的重绘反复冲掉，看着一直闪、还一直换图
        if (markerMaybePresent(textEl) && !isSettled(textEl)) {
          state.stats.skips += 1;
          state.dirty = true;
          scheduleScan(textEl);      // 过一会儿再看一眼，安静下来就插图
          scheduleRetry();
          return;
        }
      }
      processRoot(textEl, getMesId(mesEl));
    } catch (e) {
      state.stats.lastErr = String(e && e.message ? e.message : e);
      warn('处理消息失败', e);
    }
  }

  function applyAll(force) {
    try {
      if (!settings.enabled) return;
      const chat = getChatEl();
      if (!chat) { scheduleStartObserver(); return; }
      const list = chat.querySelectorAll('.mes_text');
      state.stats.scans += 1;
      state.stats.lastScanAt = Date.now();
      for (let i = 0; i < list.length; i += 1) processMesText(list[i], force);
      state.retryCount = 0;
      state.failRetries = 0;
    } catch (e) {
      state.stats.lastErr = String(e && e.message ? e.message : e);
      warn('全量渲染失败', e);
    }
  }

  /** 保命重扫：不管前面发生过什么（事件没来、状态卡住、别人重绘了消息），
   *  最多 ASSURE_SCAN_MS 一定把该显示的图补回来。这是最后一道防线。
   *  注意这里不带 force：流式输出期间照样要守规矩，不然就成了「每 15 秒闪一下」。 */
  function startAssuranceScan() {
    if (state.assureTimer) return;
    state.assureTimer = setInterval(function () {
      try {
        if (!settings.enabled) return;
        applyAll();
      } catch (e) { /* ignore */ }
    }, ASSURE_SCAN_MS);
  }

  /** 把画面上所有插图还原成原文（原文一字未改，所以能完整还原） */
  function revertRendered() {
    try {
      const sel = '.' + PREFIX + 'block, .' + PREFIX + 'inline, .' + PREFIX + 'fail-text';
      const nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
      for (let i = 0; i < nodes.length; i += 1) {
        const n = nodes[i];
        // 视频要先停掉，否则还原成文字后声音可能还在响
        try {
          const v = n.querySelector ? n.querySelector('video') : null;
          if (v) { v.pause(); v.removeAttribute('src'); }
        } catch (e) { /* ignore */ }
        replaceWithText(n, n.getAttribute('data-lpic-raw') || n.textContent || '');
      }
      if (nodes.length) log('已还原', nodes.length, '处插图');
    } catch (e) {
      warn('还原插图失败', e);
    }
  }

  /** 还原后再重画。凡是走这里的都是「明确要渲染一次」的场合（换聊天、改设置、手动重扫），
   *  所以一律强制渲染，不受任何「生成中」状态影响。 */
  function rebuildRendered(clearPins) {
    try {
      revertRendered();
      if (clearPins) pinned.clear();
      applyAll(true);
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
      if (state.retryCount > 150) { state.retryCount = 0; return; }   // 兜底上限（约 3 分钟）
      applyAll();
    }, 1200);
  }

  /** 图片没读出来时补一次重试（有限次，避免死循环） */
  function scheduleFailRetry() {
    state.failRetries += 1;
    if (state.failRetries > 3) return;
    if (state.failTimer) return;
    state.failTimer = setTimeout(function () {
      state.failTimer = 0;
      log('有图片没加载成功，重试一次');
      rebuildRendered(false);
    }, 2500);
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

  /** 聊天容器还没出现时的自动重试（最多约 15 秒，之后交给巡检） */
  function scheduleStartObserver() {
    if (state.observerTimer) return;
    state.observerTimer = setInterval(function () {
      if (startObserver()) {
        clearInterval(state.observerTimer);
        state.observerTimer = 0;
      }
    }, 800);
    setTimeout(function () {
      if (state.observerTimer) {
        clearInterval(state.observerTimer);
        state.observerTimer = 0;
      }
    }, 15000);
  }

  /** 启动后补扫几次：防止消息比插件先渲染好、或首扫时图片库还没就绪 */
  function startScanBurst() {
    SCAN_BURST.forEach(function (d) {
      setTimeout(function () {
        try {
          if (!state.observedEl) startObserver();
          applyAll();
        } catch (e) { /* ignore */ }
      }, d);
    });
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
      const vids = document.querySelectorAll('video.' + PREFIX + 'vid');
      for (let i = 0; i < vids.length; i += 1) {
        vids[i].style.height = settings.imgHeight + 'px';
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
      if (key === 'debug') { publishDebugApi(); return; }   // 开关一改就挂上/卸下控制台探针
      if (key === 'showDiag' || key === 'panelOpen') return; // 纯界面项，不影响渲染
      if (key === 'enabled') {
        if (settings.enabled) rebuildRendered(false);
        else revertRendered();
        return;
      }
      if (!settings.enabled) return;
      if (key === '__all__') { pinned.clear(); rebuildRendered(false); applyDisplay(); return; }
      if (key === 'tag' || key === 'videoTag') { scheduleRebuild(); return; }
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
      // 图片与视频共用一个放大层，按需要显示其中一个
      lb.innerHTML = '<img alt=""><video controls playsinline webkit-playsinline hidden></video>'
        + '<button class="' + PREFIX + 'lb-close" data-lpic-act="lb-close" aria-label="关闭">'
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

  function openLightbox(url, alt, kind) {
    if (!url) return;
    const lb = ensureLightbox();
    if (!lb) return;
    const isVideo = (kind === 'video');
    const img = lb.querySelector('img');
    const vid = lb.querySelector('video');

    if (isVideo) {
      if (img) { img.hidden = true; img.removeAttribute('src'); }
      if (vid) {
        vid.hidden = false;
        vid.src = url;
        try {
          const p = vid.play();
          if (p && typeof p.catch === 'function') p.catch(function () { /* 需要用户再点一次播放 */ });
        } catch (e) { /* ignore */ }
      }
    } else {
      if (vid) {
        try { vid.pause(); } catch (e) { /* ignore */ }
        vid.hidden = true;
        vid.removeAttribute('src');
      }
      if (img) { img.hidden = false; img.src = url; img.alt = alt || ''; }
    }
    lb.classList.add(PREFIX + 'open');
  }

  function closeLightbox() {
    const lb = document.getElementById(PREFIX + 'lb');
    if (!lb) return;
    lb.classList.remove(PREFIX + 'open');
    const img = lb.querySelector('img');
    const vid = lb.querySelector('video');
    if (vid) {
      try { vid.pause(); } catch (e) { /* ignore */ }
    }
    setTimeout(function () {
      try { if (img) img.removeAttribute('src'); } catch (e) { /* ignore */ }
      try { if (vid) vid.removeAttribute('src'); } catch (e) { /* ignore */ }
    }, 220);
  }

  /** 从路径判断这是图片还是视频（预览 / 放大时用） */
  function pathKind(path) {
    const p = String(path || '').toLowerCase();
    const dot = p.lastIndexOf('.');
    const ext = dot >= 0 ? p.slice(dot + 1) : '';
    return (VID_EXT.indexOf(ext) >= 0) ? 'video' : 'img';
  }

  /* ---- 素材清单：列出某个关键词下的全部素材，可逐个查看 / 删除 ---- */

  const MEDIA_PAGE = 40;          // 一次先铺多少个缩略图
  const mediaShown = new Map();   // kwId -> 当前已铺开多少条

  function mediaBox(kwId) {
    const row = kwRow(kwId);
    return row ? row.querySelector('.' + PREFIX + 'kw-media') : null;
  }

  function closeMediaList(kwId) {
    const box = mediaBox(kwId);
    mediaShown.delete(kwId);
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
  }

  function toggleMediaList(kwId) {
    const box = mediaBox(kwId);
    if (!box) return;
    if (!box.hidden) { closeMediaList(kwId); return; }   // 再点一次就收起
    closeRowPanels(kwId);                                // 先关掉同一行里的改名 / 删除确认
    mediaShown.set(kwId, MEDIA_PAGE);
    renderMediaList(kwId);
    box.hidden = false;
  }

  function renderMediaList(kwId) {
    const box = mediaBox(kwId);
    if (!box) return;
    const paths = pathsOfKeyword(kwId);
    const k = getKeyword(kwId);
    if (!paths.length) {
      box.innerHTML = '<div class="' + PREFIX + 'kw-empty">这个关键词下还没有素材。用「加图/视频」加一些吧。</div>';
      return;
    }
    const show = Math.min(mediaShown.get(kwId) || MEDIA_PAGE, paths.length);

    let html = '<div class="' + PREFIX + 'media-head">'
      + '<span>' + esc(k ? k.name : '') + ' · 共 ' + paths.length + ' 个素材</span>'
      + '<button class="' + PREFIX + 'mini-btn" data-lpic-act="media-rand" data-kw-id="' + esc(kwId) + '">随机看一个</button>'
      + '</div>'
      + '<div class="' + PREFIX + 'media-grid">';
    for (let i = 0; i < show; i += 1) {
      const p = paths[i];
      const isV = (pathKind(p) === 'video');
      html += '<div class="' + PREFIX + 'media-cell" data-lpic-act="media-open" data-path="' + esc(p) + '">'
        + '<span class="' + PREFIX + 'media-thumb"></span>'
        + '<span class="' + PREFIX + 'media-del" data-lpic-act="media-del" data-path="' + esc(p)
        + '" data-kw-id="' + esc(kwId) + '" role="button" aria-label="删除这个素材">' + icon('close') + '</span>'
        + (isV ? '<span class="' + PREFIX + 'media-tag">视频</span>' : '')
        + '</div>';
    }
    html += '</div>';
    if (paths.length > show) {
      html += '<button class="' + PREFIX + 'mini-btn ' + PREFIX + 'media-more" data-lpic-act="media-more" data-kw-id="' + esc(kwId) + '">'
        + '再看更多（还有 ' + (paths.length - show) + ' 个）</button>';
    }
    html += '<div class="' + PREFIX + 'hint">点缩略图看大图；点角上的 × 删除这一个（会再确认一次）。删掉的只是插件里的记录，原始文件不会被删。</div>';
    box.innerHTML = html;
    fillMediaThumbs(box, paths.slice(0, show));
  }

  /** 分批读缩略图：一次铺几十个会把手机卡住，所以每 6 个让出一次 */
  async function fillMediaThumbs(box, paths) {
    let cells;
    try {
      cells = Array.prototype.slice.call(box.querySelectorAll('.' + PREFIX + 'media-thumb'));
    } catch (e) {
      return;
    }
    for (let i = 0; i < cells.length && i < paths.length; i += 1) {
      const cell = cells[i];
      const p = paths[i];
      if (!cell || !cell.isConnected) continue;
      try {
        const url = await getUrl(p);
        if (!url || !cell.isConnected) continue;
        let el;
        if (pathKind(p) === 'video') {
          el = document.createElement('video');
          el.className = PREFIX + 'media-v';
          el.preload = 'metadata';          // 清单里只取首帧
          el.muted = true;
          el.setAttribute('playsinline', '');
          el.setAttribute('muted', '');
          try { el.playsInline = true; } catch (e2) { /* ignore */ }
        } else {
          el = document.createElement('img');
          el.className = PREFIX + 'media-i';
          el.alt = '';
          el.decoding = 'async';
        }
        el.src = url;
        cell.appendChild(el);
      } catch (e) { /* 单个失败不影响其它 */ }
      if (i % 6 === 5) await yieldToUI();
    }
  }

  function openMediaItem(hit) {
    const path = hit && hit.getAttribute ? (hit.getAttribute('data-path') || '') : '';
    if (!path) return;
    getUrl(path).then(function (url) {
      if (url) openLightbox(url, '', pathKind(path));
      else setStatus('素材读取失败：' + path, 'err');
    });
  }

  function disarmMediaCell(cell) {
    if (!cell) return;
    cell.classList.remove(PREFIX + 'armed');
    const btn = cell.querySelector('.' + PREFIX + 'media-del');
    if (btn) btn.innerHTML = icon('close');
    const tip = cell.querySelector('.' + PREFIX + 'media-tip');
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
  }

  /** 点 × 一次变成「再点一次确认」，避免误删 */
  function armDeleteMedia(btn) {
    const cell = btn && btn.closest ? btn.closest('.' + PREFIX + 'media-cell') : null;
    if (!cell) return;
    if (cell.classList.contains(PREFIX + 'armed')) {
      deleteMediaItem(btn.getAttribute('data-path') || '', btn.getAttribute('data-kw-id') || '');
      return;
    }
    cell.classList.add(PREFIX + 'armed');
    btn.innerHTML = icon('trash');
    const tip = document.createElement('span');
    tip.className = PREFIX + 'media-tip';
    tip.textContent = '再点一次删除';
    cell.appendChild(tip);
    if (state.armMedia) clearTimeout(state.armMedia);
    state.armMedia = setTimeout(function () {
      state.armMedia = 0;
      disarmMediaCell(cell);
    }, 4000);
  }

  /** 从库里删掉单个素材（连同清单里的位置、画面上的显示一起收拾干净） */
  async function deleteMediaItem(path, kwId) {
    if (!path) return;
    try {
      await dbDelete(STORE_FILES, path);
      indexList = indexList.filter(function (r) { return r && r.path !== path; });
      await saveIndex();

      if (urlCache.has(path)) {
        try { URL.revokeObjectURL(urlCache.get(path)); } catch (e) { /* ignore */ }
        urlCache.delete(path);
      }
      pinned.forEach(function (v, kk) { if (v === path) pinned.delete(kk); });

      buildIndex();
      updateStats();
      rebuildRendered(false);          // 画面里若正显示它，会换成同关键词的另一个（没有就还原成文字）

      const k = getKeyword(kwId);
      const left = k ? kwTotal(kwId) : 0;
      setStatus('已删除 1 个素材' + (k ? ('（「' + k.name + '」还剩 ' + left + ' 个）') : '') + '，原始文件没有被删', 'ok');
      log('删除素材：' + path);

      // 清单保持打开，接着管
      if (!left) { closeMediaList(kwId); return; }
      const box = mediaBox(kwId);
      if (box) { box.hidden = false; renderMediaList(kwId); }
    } catch (e) {
      warn('删除素材失败', e);
      setStatus('删除失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  /** 试看：随机抽一个素材，图片直接放大、视频用播放器打开 */
  function previewKeywordById(id) {
    const k = getKeyword(id);
    if (!k) { setStatus('这个关键词已经不在了', 'err'); return; }
    const paths = pathsOfKeyword(k.id);
    if (!paths.length) { setStatus('「' + k.name + '」下面还没有素材，点「加图/视频」加一些吧', 'err'); return; }
    const path = paths[Math.floor(Math.random() * paths.length)];
    getUrl(path).then(function (url) {
      if (url) openLightbox(url, k.name, pathKind(path));
      else setStatus('素材读取失败：' + path, 'err');
    });
  }

  /** 合并的目标关键词取自同一确认条里的下拉框 */
  async function mergeKeywordFromRow(fromId, btn) {
    const row = kwRow(fromId);
    const sel = row ? row.querySelector('[data-lpic-merge]') : null;
    const toId = sel ? sel.value : '';
    if (!toId) { setStatus('没有可合并的目标关键词', 'err'); return; }
    await mergeKeywordInto(fromId, toId);
  }

  function handleExtraAct(act, btn) {
    const id = btn ? (btn.getAttribute('data-kw-id') || '') : '';
    switch (act) {
      case 'import-folder': importFromFolder(); break;
      case 'resync-folder': resyncFromFolder(); break;
      case 'kw-new': openNewKeywordRow(); break;
      case 'kw-new-cancel': closeNewKeywordRow(); break;
      case 'kw-new-ok': createKeywordFromUI(); break;
      case 'kw-add': importFlow(id); break;
      case 'kw-list': toggleMediaList(id); break;
      case 'kw-preview': previewKeywordById(id); break;
      case 'media-open': openMediaItem(btn); break;
      case 'media-del': armDeleteMedia(btn); break;
      case 'media-rand': previewKeywordById(id); break;
      case 'media-more':
        mediaShown.set(id, (mediaShown.get(id) || MEDIA_PAGE) + MEDIA_PAGE);
        renderMediaList(id);
        break;
      case 'kw-rename': openRenameRow(id); break;
      case 'kw-rename-ok': confirmRename(id); break;
      case 'kw-edit-cancel': closeRowPanels(id); break;
      case 'kw-del': openDeleteConfirm(id); break;
      case 'kw-del-all': deleteKeyword(id); break;
      case 'kw-merge': mergeKeywordFromRow(id, btn); break;
      case 'probe': runEnvProbe(); break;
      case 'probe-copy': copyProbeResult(); break;
      case 'probe-folder': testFolderCapability(); break;
      case 'lb-close': closeLightbox(); break;
      default: break;
    }
  }

  /* ---- 环境探测：用大白话回答「这台设备到底能不能选文件夹」 ---- */

  let probeText = '';

  /** 决定性实测：这台设备到底能不能拿到「文件夹信息」 */
  async function testFolderCapability() {
    if (isBusy()) { setStatus('刚才的操作还没结束，稍等一下再试', 'wait'); return; }
    lockBusy();
    try {
      setStatus('请在弹出的窗口里选一个文件夹（或随便选几张图）…', 'wait');
      const files = await pickWithInput(true);
      const withPath = files.filter(function (f) { return String(f.webkitRelativePath || '').length > 0; });

      const lines = [];
      lines.push('== 文件夹能力实测 ==');
      lines.push('时间：' + new Date().toLocaleString());
      lines.push('拿到的文件数：' + files.length);
      lines.push('其中带文件夹路径的：' + withPath.length);
      files.slice(0, 5).forEach(function (f, i) {
        lines.push('· #' + (i + 1) + ' 名称=' + (f.name || '')
          + ' 类型=' + (f.type || '')
          + ' 大小=' + fmtSize(f.size)
          + ' 相对路径=' + (f.webkitRelativePath || '(空)'));
      });
      lines.push('· 结论：' + (withPath.length
        ? '这台设备能拿到文件夹信息，「文件夹名=关键词」是可行的'
        : '这台设备拿不到文件夹信息（系统选择器只给文件），只能用「新建关键词 → 加图」'));

      state.lastFolderTest = { at: Date.now(), count: files.length, withPath: withPath.length, raw: lines.join('\n') };
      probeText = lines.join('\n');
      const out = document.getElementById(PREFIX + 'probe-out');
      if (out) { out.textContent = probeText; out.hidden = false; }
      setStatus(withPath.length
        ? '实测结果：本机可以读取文件夹信息，可使用「按文件夹导入」'
        : '实测结果：本机无法读取文件夹信息，请用「新建关键词 → 加图」导入',
      withPath.length ? 'ok' : 'err');
      log('文件夹能力实测：文件 ' + files.length + ' 个，带路径 ' + withPath.length + ' 个');
    } catch (e) {
      warn('文件夹能力实测失败', e);
      setStatus('实测失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      unlockBusy();
    }
  }

  function availableEventNames() {
    try {
      const et = getEventTypes();
      if (!et) return [];
      return Object.keys(et).filter(function (k) { return typeof et[k] === 'string'; });
    } catch (e) {
      return [];
    }
  }

  function runEnvProbe() {
    const ua = String((window.navigator && window.navigator.userAgent) || '');
    const isAndroid = /Android/i.test(ua);
    const hasTauri = !!window.__TAURI__;
    const tauriFs = !!(window.__TAURI__ && window.__TAURI__.fs && typeof window.__TAURI__.fs.readDir === 'function');
    const tauriInvoke = !!(window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function');
    const dirPicker = (typeof window.showDirectoryPicker === 'function');
    const dirAttr = (function () {
      try { return ('webkitdirectory' in document.createElement('input')); } catch (e) { return false; }
    })();

    const lines = [];
    lines.push('== 本地插图 · 环境探测 ==');
    lines.push('时间：' + new Date().toLocaleString());
    lines.push('插件版本：v' + VERSION);
    lines.push('平台：' + (isAndroid ? '安卓' : '非安卓'));
    lines.push('UA：' + ua.slice(0, 160));
    lines.push('');
    lines.push('【能不能选文件夹】');
    lines.push('· 网页属性 webkitdirectory：' + (dirAttr ? '存在（但安卓的系统选择器通常给不了文件夹）' : '不存在'));
    lines.push('· showDirectoryPicker 接口：' + (dirPicker ? '浏览器提供了' : '没有提供') + '（注意：接口存在 ≠ 真的能用）');
    lines.push('· 文件夹选择实测：' + (state.lastPickerError
      ? ('被拒绝 · 错误名 ' + state.lastPickerError.name
        + (state.lastPickerError.message ? (' · ' + state.lastPickerError.message) : ''))
      : '本次会话还没试过'));
    lines.push('· webkitdirectory 实测：' + (state.lastFolderTest
      ? ('拿到 ' + state.lastFolderTest.count + ' 个文件，其中带路径的 ' + state.lastFolderTest.withPath + ' 个')
      : '还没测过（可点下面的「测试文件夹能力」）'));
    lines.push('· Tauri 目录接口 __TAURI__.fs.readDir：'
      + (tauriFs ? '发现（有希望按路径读文件夹）' : (hasTauri ? '存在 __TAURI__ 但没有 fs.readDir' : '未发现')));
    lines.push('· Tauri invoke：' + (tauriInvoke ? '发现' : '未发现'));

    let dirVerdict;
    if (state.dirPickerBlocked) dirVerdict = '本机不可用：系统拦截了网页选文件夹，请用「新建关键词 → 加图」导入';
    else if (!dirPicker && !tauriFs) dirVerdict = '本机不可用：没有可用的目录接口，请用「新建关键词 → 加图」导入';
    else dirVerdict = '接口存在，但要点一次才知道能不能真用（点击被拒绝就说明本机不可用）';
    lines.push('· 结论：' + dirVerdict);
    lines.push('');
    lines.push('【最近一次导入拿到的原始文件信息】');
    if (lastImportInfo && lastImportInfo.samples && lastImportInfo.samples.length) {
      lines.push('时间：' + new Date(lastImportInfo.at).toLocaleString() + ' · 共 ' + lastImportInfo.count + ' 个文件');
      lastImportInfo.samples.forEach(function (f, i) {
        lines.push('· #' + (i + 1)
          + ' 名称=' + (f.name || '(空)')
          + ' 类型=' + (f.type || '(空)')
          + ' 大小=' + fmtSize(f.size)
          + ' 相对路径=' + (f.rel || '(空)'));
      });
      if (lastImportInfo.samples.some(function (f) { return f.rel; })) {
        lines.push('· 注意：这批文件带有相对路径，说明目录信息其实拿得到');
      }
    } else {
      lines.push('（还没导入过。先点一次「加图」随便选几张图，再来生成会更全）');
    }
    lines.push('');
    lines.push('【渲染与事件】');
    lines.push('· 图片库连接：' + (state.dbReady ? '正常' : '未打开（正在自动重试）'));
    lines.push('· 渲染统计：扫描 ' + state.stats.scans + ' 次 · 命中 ' + state.stats.hits + ' 处 · 失败 ' + state.stats.fails + ' 处'
      + ' · 因输出未结束而等待 ' + state.stats.skips + ' 次');
    lines.push('· 生成标记：' + (state.generating
      ? ('是（已持续 ' + Math.round((Date.now() - (state.generatingSince || Date.now())) / 1000) + ' 秒）')
      : '否')
      + ' · 推迟中=' + (state.deferSince ? Math.round((Date.now() - state.deferSince) / 1000) + '秒' : '否')
      + ' · 保命重扫=' + (state.assureTimer ? '已开启' : '未开启'));
    lines.push('· 最近一次扫描：' + (state.stats.lastScanAt ? new Date(state.stats.lastScanAt).toLocaleString() : '从未'));
    if (state.stats.lastErr) lines.push('· 最近一次错误：' + state.stats.lastErr);
    const evNames = availableEventNames();
    lines.push('· 可用的酒馆事件：' + (evNames.length ? evNames.join(', ') : '(取不到)'));
    lines.push('· 关键事件是否可用：'
      + ' CHAR_RENDERED=' + (evNames.indexOf('CHARACTER_MESSAGE_RENDERED') >= 0)
      + ' GEN_ENDED=' + (evNames.indexOf('GENERATION_ENDED') >= 0)
      + ' MSG_UPDATED=' + (evNames.indexOf('MESSAGE_UPDATED') >= 0));
    lines.push('');
    lines.push('');
    lines.push('【最近日志（最新在最后，共 ' + LOG_RING.length + ' 条）】');
    if (LOG_RING.length) {
      LOG_RING.slice(-60).forEach(function (s) { lines.push('· ' + s); });
    } else {
      lines.push('（暂无）');
    }
    lines.push('');
    lines.push('【运行环境】');
    let vidsInLib = 0;
    for (let i = 0; i < indexList.length; i += 1) {
      if (recordKind(indexList[i]) === 'video') vidsInLib += 1;
    }
    lines.push('· 关键词 ' + keywordList.length + ' 个 / 图片 ' + (indexList.length - vidsInLib) + ' 张'
      + (vidsInLib ? (' / 视频 ' + vidsInLib + ' 个') : ''));
    const ls2 = state.lastStorage;
    if (ls2) {
      lines.push('· 本机占用：插件素材 ' + fmtSize(ls2.ownBytes) + ' / 本机已用 ' + fmtSize(ls2.usage)
        + (ls2.quota ? (' / 配额约 ' + fmtSize(ls2.quota)) : '')
        + (ls2.persisted === true ? ' · 已持久保存' : (ls2.persisted === false ? ' · 未持久保存' : '')));
    }
    lines.push('· IndexedDB 可用：' + (!!window.indexedDB ? '是' : '否'));
    lines.push('· 酒馆事件系统可用：' + ((getEventSource() && getEventTypes()) ? '是' : '否'));
    lines.push('· 文件夹导入：' + (state.dirPickerBlocked
      ? ('实测不可用（' + (state.lastPickerError ? state.lastPickerError.name : '被拒绝') + '）')
      : (hasDirPicker() ? '接口存在，本次会话尚未实测' : '不支持')));

    probeText = lines.join('\n');
    const out = document.getElementById(PREFIX + 'probe-out');
    if (out) {
      out.textContent = probeText;
      out.hidden = false;
    }
    setStatus('探测完成，结果在下方，可点「复制结果」', 'ok');
    log('环境探测结果\n' + probeText);
    return probeText;
  }

  function copyProbeResult() {
    const text = probeText || '';
    if (!text) { setStatus('还没有探测结果，先点「生成探测结果」', 'err'); return; }
    const out = document.getElementById(PREFIX + 'probe-out');
    let async = false;
    try {
      if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
        async = true;
        window.navigator.clipboard.writeText(text).then(function () {
          setStatus('已复制到剪贴板', 'ok');
        }).catch(function () {
          selectProbeText(out);
        });
      }
    } catch (e) {
      async = false;
    }
    if (!async) selectProbeText(out);
  }

  function selectProbeText(out) {
    try {
      if (!out) { setStatus('复制失败，请手动选中下方文字复制', 'err'); return; }
      out.hidden = false;
      const range = document.createRange();
      range.selectNodeContents(out);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      setStatus('浏览器不允许自动复制，文字已选中，长按手动复制即可', 'err');
    } catch (e) {
      setStatus('复制失败，请手动选中下方文字复制', 'err');
    }
  }

  /** 在面板里直接看最近日志，手机上也用不着开控制台 */
  function showRecentLogs() {
    const out = document.getElementById(PREFIX + 'probe-out');
    if (!out) return;
    const lines = [];
    lines.push('== 最近日志（最新在最后，共 ' + LOG_RING.length + ' 条）==');
    lines.push('时间：' + new Date().toLocaleString() + ' · 插件版本 v' + VERSION);
    lines.push('');
    if (LOG_RING.length) LOG_RING.slice(-120).forEach(function (s) { lines.push('· ' + s); });
    else lines.push('（暂无日志）');
    probeText = lines.join('\n');
    out.textContent = probeText;
    out.hidden = false;
    setStatus('日志已显示在下方，可点「复制」', 'ok');
  }

  /** 点视频上的播放按钮 → 就地播放（带声音、带进度条） */
  function playInlineVideo(hit) {
    const wrap = hit && hit.closest ? hit.closest('.' + PREFIX + 'media-vid') : null;
    const vid = wrap ? wrap.querySelector('video') : null;
    if (!vid) return null;
    wrap.classList.add(PREFIX + 'playing');
    try { vid.controls = true; } catch (e) { /* ignore */ }
    try {
      const p = vid.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () { warn('视频播放被拒绝，可在放大层里手动点播放'); });
      }
    } catch (e) {
      warn('视频播放失败', e);
    }
    return vid;
  }

  /** 页面级委托：点图片放大、点视频播放 / 放大播放 */
  function onDocClick(e) {
    try {
      const t = e.target;
      if (!t || !t.closest) return;

      const playHit = t.closest('[data-lpic-media="play"]');
      if (playHit) {
        playInlineVideo(playHit);
        e.preventDefault();
        return;
      }

      const openHit = t.closest('[data-lpic-media="open"]');
      if (openHit) {
        const wrap = openHit.closest('.' + PREFIX + 'media-vid');
        const vid = wrap ? wrap.querySelector('video') : null;
        const src = vid ? vid.getAttribute('src') : '';
        if (src) {
          try { vid.pause(); } catch (err) { /* ignore */ }   // 就地播放的换到放大层播，避免两处同时响
          openLightbox(src, wrap.getAttribute('data-lpic-kw') || '', 'video');
        }
        e.preventDefault();
        return;
      }

      // 视频本体：没在播放就当成「播放」用；正在播放时交给原生控件
      const vidEl = t.closest('video.' + PREFIX + 'vid');
      if (vidEl) {
        const wrap = vidEl.closest('.' + PREFIX + 'media-vid');
        if (wrap && !wrap.classList.contains(PREFIX + 'playing')) {
          playInlineVideo(vidEl);
          e.preventDefault();
        }
        return;
      }

      const img = t.closest('img.' + PREFIX + 'img');
      if (img && settings.lightbox && img.getAttribute('src')) {
        openLightbox(img.getAttribute('src'), img.getAttribute('alt') || '', 'img');
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

  /** 全量重扫（合并成一次）。force=true 表示「现在已经确定不是在输出中」，可以立刻插图。
   *  合并期间只要有一次是 force，整批就按 force 走。 */
  function scheduleScanAll(force) {
    if (force) state.scanAllForce = true;
    if (state.scanAllTimer) return;
    state.scanAllTimer = setTimeout(function () {
      state.scanAllTimer = 0;
      const f = !!state.scanAllForce;
      state.scanAllForce = false;
      applyAll(f);
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
      // 换聊天是用户主动动作，之前的生成状态一律作废，别让它挡住渲染
      state.generating = false;
      state.generatingSince = 0;
      state.deferSince = 0;
      pinned.clear();
      rebuildRendered(false);
    });

    // 消息被编辑 / 更新 / 切换 swipe：解绑该消息的随机记忆后重新处理
    const mesChanged = function (data) {
      // 编辑正文并确认/取消、消息更新、切换 swipe 都是用户主动动作，
      // 不该被残留的「生成中」状态挡住 —— 否则画面会一直停在纯文字
      state.generating = false;
      state.generatingSince = 0;
      state.deferSince = 0;

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

    on(et.GENERATION_STARTED, function () {
      state.generating = true;
      state.generatingSince = Date.now();
    });
    const genEnd = function () {
      state.generating = false;
      state.generatingSince = 0;
      state.deferSince = 0;
      state.dirty = false;
      state.retryCount = 0;
      // 输出已结束，这时插图最合适：直接强制渲染一次，不用再等「安静」判定
      scheduleScanAll(true);
    };
    on(et.GENERATION_ENDED, genEnd);
    on(et.GENERATION_STOPPED, genEnd);

    on(et.MESSAGE_RECEIVED, function () {
      state.deferSince = 0;
      setTimeout(scheduleScanAll, 120);
    });

    // 额外的渲染触发点：有的壳没有这些事件，取到哪个就挂哪个
    on(et.CHARACTER_MESSAGE_RENDERED, function () { scheduleScanAll(); });
    on(et.USER_MESSAGE_RENDERED, function () { scheduleScanAll(); });
    on(et.MESSAGE_RENDERED, function () { scheduleScanAll(); });

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
          return keywordList.map(function (k) {
            return { id: k.id, name: k.name, names: k.names, count: kwTotal(k.id) };
          });
        },
        lookupTable: function () {
          return Array.from(keywordMap.entries()).map(function (e) {
            return { key: e[0], name: e[1].name, count: e[1].paths.length };
          });
        },
        createKeyword: createKeyword,
        renameKeyword: renameKeyword,
        deleteKeyword: deleteKeyword,
        mergeKeyword: mergeKeywordInto,
        importFiles: doImport,
        importFolder: importFromFolder,
        resyncFolder: resyncFromFolder,
        probe: runEnvProbe,
        testFolder: testFolderCapability,
        dirPicker: function () { return { blocked: state.dirPickerBlocked, lastError: state.lastPickerError, lastTest: state.lastFolderTest }; },
        events: availableEventNames,
        logs: function (n) { return LOG_RING.slice(-(Number(n) || 60)); },
        stats: function () { return Object.assign({}, state.stats); },
        dbReady: function () { return state.dbReady; },
        lastImport: function () { return lastImportInfo; },
        busy: function () { return { busy: state.busy, since: state.busySince, waiting: !!state.cancelPick }; },
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
    if (!startObserver()) scheduleStartObserver();
    startWatchdog();
    bindSTEvents();
    refreshLibrary();
    startScanBurst();
    startAssuranceScan();
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
