// ==UserScript==
// @name         Cookie Clicker 自動購入（Galaxy Tab専用機用）
// @namespace    muse.cookieclicker
// @version      2.3.45
// @downloadURL  https://raw.githubusercontent.com/domo0131/cookie-clicker-auto/main/cookie-clicker-auto.user.js
// @updateURL    https://raw.githubusercontent.com/domo0131/cookie-clicker-auto/main/cookie-clicker-auto.user.js
// @description  回収期間（価格÷実CpS増）順の自動購入、大クッキーの自動クリック、黄金クッキーの自動取得（ホロボア配置時は停止）、セーブのファイル書き出し、状態の定期送信（Googleドライブ経由でMuse側のスペースへ反映）を行うユーザースクリプト。
// @match        https://orteil.dashnet.org/cookieclicker/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      raw.githubusercontent.com
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 設定（ここだけ書き換えれば調整できます） ================= */
  var CONFIG = {
    mode: 'readonly',        // 'readonly' = 読み取り専用（買わずに「次に買うもの」だけ表示） / 'auto' = 自動購入する
    buyIntervalMs: 1000,     // 購入判断の間隔（ミリ秒）（v2.3.21: 2000→1000。購入判定と全評価を分離し、評価は evalIntervalMs 間隔で再利用する）
    evalIntervalMs: 2000,    // 全候補の再評価シミュレーションを行う最小間隔（ミリ秒）。この間は前回評価を使い回す（v2.3.21）
    buyRestMs: 100,          // 購入サイクルの合間の休止（ミリ秒）（v2.3.22: イベント駆動チェーン。クリック処理に枠を譲る）
    maxBatch: 1,             // 1回の判断で買う上限数（安全優先: 1件買って実測検証してから次へ）
    clickPerSecond: 2,       // 大クッキーの自動クリック回数/秒（0で無効）
    clickGolden: true,       // 黄金クッキーを自動でクリックするか（ホロボア配置中は設定に関係なく常に停止）
    saveUpSeconds: 600,      // （v2.0で「A→B／B→Aの順序比較」に置き換えたため未使用。互換のため残置）
    autoBackupHours: 0,      // セーブの自動書き出し間隔（時間）。0 = 自動では書き出さない（パネルのボタンで手動実行）
    logMax: 60,              // パネルに残す購入ログの件数
    reportSecret: '', // （v2.2.0で廃止）合言葉はコードに書かず、パネルの「🔑 合言葉設定」から保存する（公開リポジトリに載せないため）
    reportIntervalMs: 60000,  // 状態送信の間隔（ミリ秒）。送信先URLはパネルの「送信先設定」から保存する
    updateCheckMinutes: 10,   // 新しい版が出ていないか GitHub を確認する間隔（分）。新版があれば保存して再読み込みし、取り込む
    clickBudgetMs: 15        // クリック処理に1回のtickで使う時間の上限（ミリ秒）。ゲーム本体の処理を飢えさせないための制限（v2.3.20: 5→15に拡大して実測クリック速度の改善を試行。設定250/秒に対し実測約27/秒だった）
  };
  /* ====================================================================== */

  var SCRIPT_VERSION = '2.3.45'; // ヘッダーの @version と必ず揃えること（状態送信に含める）

  // 絶対に自動購入しないアップグレード（名前の部分一致、大文字小文字は区別しない）
  var BLOCKED_UPGRADE_WORDS = [
    'one mind', 'communal brainsweep', 'elder pact', 'elder pledge', 'elder covenant',
    'bingo center', 'research facility', 'specialized chocolate chips', 'antimatter condensers',
    'one mind', 'exotic nuts', 'arcane sugar'
  ];
  // ※ 上記は研究系・グランマポカリプス系・危険なものを止めるための保険です。
  //   個別に止めたいものが増えたらここに名前を足してください。

  var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  function gmGet(key, def) {
    try { var v = GM_getValue(key); return (v === undefined || v === null) ? def : v; } catch (e) { return def; }
  }
  function gmSet(key, val) {
    try { GM_setValue(key, val); } catch (e) { /* 保存できなくても動作は続ける */ }
  }

  var state = {
    running: gmGet('ccauto_running', true),
    mode: gmGet('ccauto_mode', CONFIG.mode),
    logs: gmGet('ccauto_logs', []),
    lastAction: gmGet('ccauto_lastAction', ''),
    halted: gmGet('ccauto_halted', 0) === 1, // 異常停止は再読み込みしても維持する（パネルの再開で解除）
    actualNext: null, // 実際に次に買うもの（目標そのもの／合間の先行購入／貯金中の候補）。buyStep が毎回そろえる
    // 第1目標までの間に実際に買った直近のもの（目標が変わるまで保持する）
    lastInterim: (function () { try { var v = gmGet('ccauto_lastInterim', null); return (v && v.label) ? v : null; } catch (e) { return null; } })(),
    startedAt: Date.now()
  };

  // 初めて入れたときだけ、パネルで自動購入を選ぶまで読み取り専用にする。
  // 自動更新で版が上がった場合は、前の版で承認済みなら自動購入を止めない（購入が止まるのが一番の非効率のため）
  if (gmGet('ccauto_approvedVersion', '') !== SCRIPT_VERSION) {
    if (!gmGet('ccauto_approvedVersion', '')) state.mode = 'readonly';
    // 新しい版では効果測定の停止フラグを解除して再挑戦する（直した版で実測を復活させるため）
    try { gmSet('ccauto_bSimDisabled', 0); gmSet('ccauto_simDisabled', 0); gmSet('ccauto_bSimOff', '{}'); } catch (e) { /* ignore */ }
    // v2.3.18: チップ計算の実績化に伴い、計算の一致確認が済むまで自動昇天を一時停止する
    // （購入・クリックは止めない。確認後に有効化する。一度だけ適用）
    try {
      if (!gmGet('ccauto_ascendHold218', 0)) { gmSet('ccauto_autoAscend', '0'); gmSet('ccauto_ascendHold218', 1); }
    } catch (e) { /* ignore */ }
    // v2.3.19: 計算の一致確認と新しい昇天条件（実績+20%）の決定が済んだので自動昇天を再開する（一度だけ適用）
    try {
      if (!gmGet('ccauto_ascendResume219', 0)) { gmSet('ccauto_autoAscend', '1'); gmSet('ccauto_ascendResume219', 1); }
    } catch (e) { /* ignore */ }
  }

  /* ================= 二重タブ防止（v2.3.23） =================
     ゲームのタブが2つ開くと両タブが同じセーブ領域を共有し、古いタブのゲーム本体の
     自動セーブが新しい状態を上書きして巻き戻る事故が起きた（2026-11-14、5回目の昇天が
     取り消された）。対策（ChatGPT相談「対策設計レビュー」）:
     - GM保存領域の「主タブ主張」を取り合う選挙で、自動操作する主タブを1つに決める
     - ゲームの保存（Game.WriteSave の書き込み経路）は、主タブが確定するまで全タブで
       遮断し、従タブでは恒常的に遮断する。自動操作を止めるだけでは、ゲーム本体の
       自動セーブで巻き戻るため。WriteSave(1) は書き込まず文字列を返す書き出し経路
       なので遮断しない（バックアップ取得は従タブでも安全）
     - 従タブは購入・クリック・送信・昇天を行わない。主タブの主張が途絶えたら引き継ぐ
     - タブIDは sessionStorage に保持し、再読み込みでは同じタブとして即座に復帰する */
  var TAB_ID = (function () {
    var fallback = 'tab-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    try {
      var s = sessionStorage.getItem('ccauto_tabId');
      if (s) return s;
      sessionStorage.setItem('ccauto_tabId', fallback);
    } catch (e) { /* ignore */ }
    return fallback;
  })();
  var TAB_STALE_MS = 75000; // 主張がこの時間更新されなければ途絶えたとみなす（背面タブのタイマー抑制が約60秒あるため余裕を持たせる）
  var tabState = { primary: false, decided: false, guardInstalled: false, autosaveOffByUs: false, wasFollower: false, justHandedOver: false, primarySince: 0 };
  // ページ読み込みごとの個体識別子。タブ複製で sessionStorage ごとコピーされ TAB_ID が
  // 重なっても、nonce の違いで別個体と区別できる（v2.3.30、ChatGPTレビューに基づく）
  var TAB_NONCE = 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  var tabIdRegenDone = false;

  function tabClaimRead() {
    var c = null;
    try { c = gmGet('ccauto_tabClaim', null); } catch (e) { c = null; }
    return (c && typeof c.at === 'number' && c.id) ? c : null;
  }
  function tabClaimWrite() {
    try { gmSet('ccauto_tabClaim', { id: TAB_ID, nonce: TAB_NONCE, at: Date.now() }); } catch (e) { /* ignore */ }
  }
  // 「他人の新しい主張」があるか（別タブ、または複製で ID が重なった別個体）
  function claimIsForeignFresh(c) {
    if (!c || (Date.now() - c.at) >= TAB_STALE_MS) return false;
    if (c.id !== TAB_ID) return true;
    if (c.nonce && c.nonce !== TAB_NONCE) return true;
    return false;
  }
  // 経路の切り分け用の足跡（v2.3.40、ChatGPTレビュー）: 起動・選挙・再読み込み・転生の
  // 出来事を GM に最大24件残し、状態送信に載せる。転生後の無操作時間の内訳を特定するため
  function traceEvent(ev) {
    try {
      var tr = gmGet('ccauto_trace', []);
      if (!Array.isArray(tr)) tr = [];
      tr.push({ at: Date.now(), ev: ev });
      if (tr.length > 24) tr = tr.slice(tr.length - 24);
      gmSet('ccauto_trace', tr);
    } catch (e) { /* ignore */ }
  }
  function tabSetRole(primary) {
    var changed = (tabState.primary !== primary) || !tabState.decided;
    // 主タブになった時刻（巻き戻し検知の保留窓の起点。v2.3.35）
    if (primary && changed) tabState.primarySince = Date.now();
    tabState.primary = primary;
    tabState.decided = true;
    // 初回から従タブの場合も含め、従になった履歴は必ず残す（v2.3.32、ChatGPTレビュー）。
    // 履歴がないと、主タブの消滅時に再読み込みなしで昇格し、古いメモリ状態を保存しうる
    if (!primary) tabState.wasFollower = true;
    try {
      var G = W.Game;
      if (G && G.prefs) {
        if (!primary && G.prefs.autosave) { G.prefs.autosave = 0; tabState.autosaveOffByUs = true; }
        if (primary && tabState.autosaveOffByUs) { G.prefs.autosave = 1; tabState.autosaveOffByUs = false; }
      }
    } catch (e) { /* ignore */ }
    if (changed) {
      log(primary ? 'このタブが主タブとして動作します' : '別のタブが主タブのため、このタブは待機します（二重タブ防止）');
      traceEvent(primary ? 'primary' : 'follower');
      try { renderPanel(); } catch (e) { /* ignore */ }
    }
    if (primary) primaryRecovery();
  }
  // 引き継ぎ再読み込みの直後かどうか（記録は1回だけ消費する）
  function handoverTake() {
    var h = null;
    try { h = gmGet('ccauto_handover', null); } catch (e) { h = null; }
    if (h && h.id === TAB_ID && (Date.now() - (h.at || 0)) < 120000) {
      try { gmSet('ccauto_handover', null); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }
  // 従タブから主タブへの引き継ぎ: このタブのゲーム本体は古いメモリ状態のため、
  // 書き込みを許可する前に再読み込みして最新セーブを読み直す（v2.3.30）
  function handoverReload() {
    var last = 0;
    try { last = gmGet('ccauto_handoverReloadAt', 0) || 0; } catch (e) { last = 0; }
    if (Date.now() - last < 30000) { tabSetRole(false); return; } // 間隔ガード中は従タブのまま（書き込みは許可しない）
    try { gmSet('ccauto_handover', { id: TAB_ID, at: Date.now() }); gmSet('ccauto_handoverReloadAt', Date.now()); } catch (e) { /* ignore */ }
    traceEvent('handover-reload');
    log('主タブを引き継ぐため、最新セーブを読み直します（再読み込み）');
    setTimeout(function () { try { location.reload(); } catch (e) { /* ignore */ } }, 300);
  }
  function tabElect() {
    var c = tabClaimRead();
    var now = Date.now();
    // 引き継ぎ再読み込みの直後は、nonce 照合より先に主タブとして復帰する（v2.3.32）。
    // nonce は読み込みのたびに変わるため、照合を先にすると自分の引き継ぎを完了できない。
    // ただし別のタブが既に正当に主なら、引き継ぎ記録は破棄して通常の選挙に戻る
    var hv = null;
    try { hv = gmGet('ccauto_handover', null); } catch (e) { hv = null; }
    if (hv && hv.id === TAB_ID && (now - (hv.at || 0)) < 120000) {
      var otherClaims = !!(c && c.id !== TAB_ID && (now - c.at) < TAB_STALE_MS);
      handoverTake(); // 記録はどちらに転んでも消費する
      if (!otherClaims) { tabState.justHandedOver = true; tabClaimWrite(); tabSetRole(true); return; }
      c = tabClaimRead();
    }
    // 自分と同じ ID で別個体（nonce違い）の新しい主張がある = タブ複製か自分の再読み込み。
    // IDだけ取り直し、既存の主張は他者のものとして尊重して従タブになる（v2.3.32）。
    // 以前は主張を消して即座に横取りしており、複製タブが古い状態のまま主になる穴があった。
    // 再読み込みの場合は相手がもう居ないので、主張が失効した時点で通常の引き継ぎに入る
    if (c && c.id === TAB_ID && c.nonce && c.nonce !== TAB_NONCE && (now - c.at) < TAB_STALE_MS) {
      if (!tabIdRegenDone) {
        tabIdRegenDone = true;
        TAB_ID = 'tab-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
        try { sessionStorage.setItem('ccauto_tabId', TAB_ID); } catch (e) { /* ignore */ }
      }
      tabSetRole(false);
      return;
    }
    if (c && c.id !== TAB_ID && (now - c.at) < TAB_STALE_MS) { tabSetRole(false); return; }
    tabClaimWrite();
    setTimeout(function () {
      var c2 = tabClaimRead();
      if (!(c2 && c2.id === TAB_ID && (!c2.nonce || c2.nonce === TAB_NONCE))) { tabSetRole(false); return; }
      // 引き継ぎ再読み込みの直後なら、その事実をタブ内変数で保持する（v2.3.35、ChatGPTレビュー:
      // 判定材料は消費する場所で確定し、処理は主タブ確定後に行う。共有の handoverReloadAt は
      // 別タブの操作でも残るため、時刻の近さだけでは判定しない）
      var tookHandover = handoverTake();
      if (tookHandover) tabState.justHandedOver = true;
      // 引き継ぎ（従タブだった）場合は、稼働開始の前に最新セーブを読み直す
      if (tabState.wasFollower && !tookHandover) { handoverReload(); return; }
      tabSetRole(true);
    }, 1500);
  }
  // 存在ビーコン（v2.3.32）: 全タブが共有インデックスに自分の {初回検知, 最終観測, 役割}
  // を書き、主タブが状態送信に載せる。「複数タブが開いているか」「どちらが古いか」を
  // 通常の送信データから検知できるようにするため（従タブは状態送信をしないので、
  // これがないと重複に気づけない）。各タブは自分の項目だけを更新する
  function tabBeacon() {
    try {
      var idx = gmGet('ccauto_tabIndex', null);
      if (!idx || typeof idx !== 'object') idx = {};
      var now = Date.now();
      var me = idx[TAB_ID];
      if (!me || typeof me.first !== 'number') { me = { first: now }; idx[TAB_ID] = me; }
      me.last = now;
      me.role = tabState.primary ? 'primary' : (tabState.decided ? 'follower' : 'unknown');
      me.code = TAB_ID.slice(-4);
      for (var k in idx) { if (now - ((idx[k] && idx[k].last) || 0) > 15 * 60 * 1000) delete idx[k]; }
      gmSet('ccauto_tabIndex', idx);
    } catch (e) { /* ignore */ }
  }
  function tabListForPayload() {
    var out = [];
    try {
      var idx = gmGet('ccauto_tabIndex', null);
      if (idx && typeof idx === 'object') {
        for (var k in idx) {
          var e = idx[k];
          if (e && typeof e.first === 'number') out.push({ code: e.code || String(k).slice(-4), first: e.first, last: e.last || 0, role: e.role || 'unknown' });
        }
      }
    } catch (e2) { /* ignore */ }
    out.sort(function (a, b) { return a.first - b.first; });
    return out;
  }

  function tabHeartbeat() {
    if (!tabState.decided) return;
    tabBeacon();
    if (tabState.primary) {
      // 書き込む前に所有者を照合する: 凍結から復帰した旧主タブ等が、より新しい
      // 主張を持つタブへ譲る（v2.3.30）
      if (claimIsForeignFresh(tabClaimRead())) { tabSetRole(false); return; }
      tabClaimWrite();
      return;
    }
    var c = tabClaimRead();
    if (!c || (Date.now() - c.at) >= TAB_STALE_MS || c.id === TAB_ID) tabElect();
  }
  function installSaveGuard() {
    if (tabState.guardInstalled) return true;
    try {
      var G = W.Game;
      if (!G || typeof G.WriteSave !== 'function') return false;
      if (G.WriteSave.__ccautoGuard) { tabState.guardInstalled = true; return true; }
      var orig = G.WriteSave;
      var wrapped = function (type) {
        if (type !== 1) {
          if (!tabState.primary) return undefined; // 書き込みは主タブだけ
          // 書き込みの直前にも所有者を照合する（v2.3.30）: 凍結から復帰した旧主タブの
          // 最初の自動セーブを、ハートビートを待たずその場で遮断する
          var c = tabClaimRead();
          if (claimIsForeignFresh(c)) { try { tabSetRole(false); } catch (e) { /* ignore */ } return undefined; }
          // 自分の主張が読み取れて新鮮なときだけ許可する（v2.3.32: fail-closed）。
          // 主張が消えた・失効した・読めなかった場合は書き込まない（次の自動セーブで再試行される）
          if (!c || c.id !== TAB_ID || (Date.now() - c.at) >= TAB_STALE_MS) return undefined;
        }
        return orig.apply(this, arguments);
      };
      wrapped.__ccautoGuard = true;
      G.WriteSave = wrapped;
      tabState.guardInstalled = true;
      return true;
    } catch (e) { return false; }
  }

  function saveState() {
    if (tabState.decided && !tabState.primary) return; // 従タブは共有状態を書き換えない（v2.3.30）
    gmSet('ccauto_running', state.running);
    gmSet('ccauto_mode', state.mode);
    gmSet('ccauto_logs', state.logs.slice(0, CONFIG.logMax));
    gmSet('ccauto_lastAction', state.lastAction);
  }

  // エラーは止めずに記録し、状態送信に載せて Muse 側からチャットへ報告させる
  function reportError(msg) {
    log('エラー: ' + msg);
    try {
      var errs = gmGet('ccauto_errors', []);
      if (!Array.isArray(errs)) errs = [];
      errs.unshift({ ts: Date.now(), msg: msg });
      if (errs.length > 10) errs.length = 10;
      gmSet('ccauto_errors', errs);
    } catch (e) { /* ignore */ }
  }

  function achievementsWon() {
    var n = 0;
    try {
      var A = W.Game.AchievementsById || [];
      for (var i = 0; i < A.length; i++) if (A[i].won) n++;
    } catch (e) { /* ignore */ }
    return n;
  }

  // 効果（ゴールデンクッキー等）の一覧を文字列化する。購入時と検証時で変わっていたら測定が信用できない
  function buffSignature() {
    try {
      var b = W.Game.buffs || {};
      var names = [];
      for (var k in b) if (b[k] && b[k].time > 0) names.push(k);
      return names.sort().join(',');
    } catch (e) { return ''; }
  }

  // クリック系バフ（Click frenzy 等）が掛かっているか。最中はクリック値が一時的に跳ね上がり、
  // 実測値が恒常的な効率の順位付けに使えないため、全体系の測定を避ける判断に使う
  function clickBuffActive() {
    try {
      var b = W.Game.buffs || {};
      for (var k in b) {
        var bf = b[k];
        if (bf && bf.time > 0 && ((bf.multClick || 1) > 1 || /click/i.test(k))) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // 何らかのバフ（生産系も含む）が掛かっているか。生産バフ中は派生値が倍率ぶん膨らみ、
  // シミュレーションの増分が恒常値とずれるため、全体系の測定を避ける判断に使う
  function anyBuffActive() {
    try {
      var b = W.Game.buffs || {};
      for (var k in b) if (b[k] && b[k].time > 0) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function nowTime() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function log(msg) {
    state.lastAction = nowTime() + ' ' + msg;
    state.logs.unshift(state.lastAction);
    if (state.logs.length > CONFIG.logMax) state.logs.length = CONFIG.logMax;
    saveState();
    requestRender(); // v2.3.36: ログのたびの即時描画はまとめ描画へ（カクつき対策、ChatGPTレビュー）
  }

  function fmtDur(sec) {
  if (!isFinite(sec) || sec <= 0) return 'まもなく';
  if (sec < 90) return '約' + Math.max(1, Math.round(sec)) + '秒';
  if (sec < 3600) return '約' + Math.round(sec / 60) + '分';
  if (sec < 86400) {
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return '約' + h + '時間' + (m ? m + '分' : '');
  }
  return '約' + (sec / 86400).toFixed(1) + '日';
}

function fmt(n) {
    if (n >= 1e42) return (n / 1e42).toFixed(3) + ' TrD';
    if (n >= 1e39) return (n / 1e39).toFixed(3) + ' DoD';
    if (n >= 1e36) return (n / 1e36).toFixed(3) + ' UnD';
    if (n >= 1e33) return (n / 1e33).toFixed(3) + ' Dc';
    if (n >= 1e30) return (n / 1e30).toFixed(3) + ' No';
    if (n >= 1e27) return (n / 1e27).toFixed(3) + ' Oc';
    if (n >= 1e24) return (n / 1e24).toFixed(3) + ' Sp';
    if (n >= 1e21) return (n / 1e21).toFixed(3) + ' Sx';
    if (n >= 1e18) return (n / 1e18).toFixed(3) + ' Qi';
    if (n >= 1e15) return (n / 1e15).toFixed(3) + ' Qa';
    if (n >= 1e12) return (n / 1e12).toFixed(3) + ' T';
    if (n >= 1e9) return (n / 1e9).toFixed(3) + ' B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K';
    return '' + Math.floor(n);
  }

  /* ---------------- ゲーム状態の読み取り ---------------- */

  function gameReady() {
    return typeof W.Game !== 'undefined' && W.Game && W.Game.Objects && W.Game.ready;
  }

  var challengeCache = { at: 0, value: false };
  function isChallengePage() {
    // innerText の取得は重いので、判定結果を5秒キャッシュする
    var now = Date.now();
    if (now - challengeCache.at < 5000) return challengeCache.value;
    var v = false;
    try {
      var t = (document.title || '') + ' ' + (document.body ? document.body.innerText.slice(0, 400) : '');
      v = /just a moment|performing security verification|verify you are human/i.test(t);
    } catch (e) { v = false; }
    challengeCache = { at: now, value: v };
    return v;
  }

  // バフで膨らんでいない素のCpS（建物合計×全体倍率で近似）
  function baseCps() {
    // バフなしCpSを優先する（Frenzy等の一次バフで判断を膨らませない）
    var G = W.Game;
    try {
      if (typeof G.unbuffedCps === 'number' && G.unbuffedCps > 0) return G.unbuffedCps;
      if (typeof G.unbuffedCookiesPs === 'number' && G.unbuffedCookiesPs > 0) return G.unbuffedCookiesPs;
      var sum = 0;
      for (var k in G.Objects) { sum += G.Objects[k].storedTotalCps || 0; }
      var mult = (typeof G.globalCpsMult === 'number' && G.globalCpsMult > 0) ? G.globalCpsMult : 1;
      var v = sum * mult;
      return v > 0 ? v : (G.cookiesPs || 0);
    } catch (e) { return G.cookiesPs || 0; }
  }

  // 測定専用の物差し（v2.2.1で統一）: CalculateGains() がその場で更新する値だけを読む。
  // unbuffedCps はメインループ側の更新で、同期的な再計算の中では追随しないことがある（v2.1.1の診断で判明）。
  // 効果のシミュレーションと購入後検証は、必ずこの同じ物差しで測ること（物差しの混在が異常値の原因だった）。
  // バフ倍率の積（生産倍率とクリック倍率の両方）。クリック値はバフ込みで計算されるため、
  // 予測・購入・検証の物差しを「素のクリック値」にそろえるのに使う
  function buffMultProduct() {
    var m = 1;
    try {
      var buffs = W.Game.buffs || {};
      for (var k in buffs) {
        var b = buffs[k];
        if (!b || !(b.time > 0)) continue;
        if (typeof b.multCpS === 'number' && b.multCpS > 0) m *= b.multCpS;
        if (typeof b.multClick === 'number' && b.multClick > 0) m *= b.multClick;
      }
    } catch (e) { /* ignore */ }
    return m > 0 ? m : 1;
  }

  function readProduction() {
    var G = W.Game;
    var cps = 0, click = 0;
    try { cps = (typeof G.cookiesPsRaw === 'number' && G.cookiesPsRaw > 0) ? G.cookiesPsRaw : baseCps(); } catch (e) { cps = 0; }
    // CpS 側（cookiesPsRaw）はバフなしの値なので、クリック側もバフ倍率で割って素の値にそろえる。
    // そろえないと、長いバフの最中の購入で検証のクリック分だけが倍率ぶん膨らんで誤報になる
    try { click = mouseCps() / buffMultProduct(); } catch (e2) { click = 0; }
    return { cps: cps, click: click };
  }

  function unitCpsOf(obj) {
    // 建物1軒あたりの増産量。再計算済みの storedCps（建物レベル補正込み）を優先する
    try {
      if (typeof obj.storedCps === 'number' && isFinite(obj.storedCps) && obj.storedCps > 0) return obj.storedCps;
      if (typeof obj.cps === 'function') {
        var v = obj.cps(obj);
        if (typeof v === 'number' && isFinite(v) && v > 0) return v;
      }
    } catch (e) { /* fallthrough */ }
    return obj.storedCps || 0;
  }

  function buildingPrice(obj) {
    try { return (typeof obj.getPrice === 'function') ? obj.getPrice() : obj.price; }
    catch (e) { return obj.price; }
  }

  // パンテオンの slot は、ゲームのセーブ復元経路（for…in の文字列キーを slotGod に
  // 渡す）で文字列（"0" 等）になることがある（v2.3.31 実測）。読み取り側でのみ
  // 正規化し、受け付けるのは -1/0/1/2 の数値かその文字列だけ。それ以外
  // （null・空文字・真偽値など）は「判定不能」として null を返す
  // （Number(null) や Number('') が 0 になり、配置済みと誤判定するため）
  function godSlotNum(g) {
    if (!g) return null;
    var s = g.slot;
    if (typeof s === 'number' && (s === -1 || s === 0 || s === 1 || s === 2)) return s;
    if (typeof s === 'string' && (s === '-1' || s === '0' || s === '1' || s === '2')) return Number(s);
    return null;
  }

  function holoboreState() {
    // 'slotted'（配置中）/ 'none'（未配置で確定）/ 'unknown'（判定不能）の3状態。
    // 'none' のときだけ黄金クッキーをクリックしてよい。
    // v2.3.27: パンテオンを直接読む（Game.hasGod の有無に依存しない）
    // v2.3.29: asceticism の slot が実際に読めた場合だけ確定する（読めないのに
    // none と言い切る穴を塞ぐ。ChatGPTレビューに基づく）
    try {
      var tt = W.Game.Objects['Temple'];
      var tmg = tt && tt.minigame;
      if (tmg && tmg.gods) {
        var ascS = godSlotNum(tmg.gods['asceticism']);
        if (ascS !== null) return ascS === -1 ? 'none' : 'slotted';
        // 読めなかった場合は下のフォールバックへ（最終的に unknown 寄りに倒れる）
      }
    } catch (e) { /* fallthrough */ }
    try {
      if (typeof W.Game.hasGod === 'function') {
        var r = W.Game.hasGod('asceticism');
        return (r !== false && r !== -1 && r !== undefined && r !== null) ? 'slotted' : 'none';
      }
    } catch (e) { /* fallthrough */ }
    try {
      var t = W.Game.Objects['Temple'];
      if (t && (t.level || 0) >= 1) return 'unknown'; // パンテオンがあるはずなのに読めない
    } catch (e) { return 'unknown'; }
    return 'none'; // パンテオン未解放なら配置のしようがない
  }

  /* ---------------- 購入候補の評価 ---------------- */

  function isBlockedUpgrade(up) {
    var name = (up.name || '').toLowerCase();
    for (var i = 0; i < BLOCKED_UPGRADE_WORDS.length; i++) {
      if (name.indexOf(BLOCKED_UPGRADE_WORDS[i]) >= 0) return true;
    }
    return false;
  }

  // 候補リストを作る。各候補: {kind, ref, label, price, gain, payback}
  function achievementCount() {
    var n = 0;
    try { for (var k in W.Game.Achievements) { if (W.Game.Achievements[k].won) n++; } } catch (e) { /* ignore */ }
    return n;
  }

  // 全体系の評価対象は「純粋な倍率系」だけに限定する（ホワイトリスト方式）。
  // 卵・研究・天上系など特殊な仕組みを持つものは、名前でも明示的に弾く（二重の安全）。
  // ゴールデンクッキー系の強化（出現頻度・効果時間）。効果は CpS/クリックの再計算では測れないため、
  // 個別指定で候補に入れ、見なし増産で順位付けする（自動でゴールデンクッキーを拾う運用が前提）。
  // 効果を検証できないので、購入後の検証は記録しない（noVerify）。
  var GC_BOOSTER_NAMES = ['lucky day', 'serendipity', 'get lucky'];
  var GC_BOOSTER_GAIN_RATE = 0.25; // 計測が貯まるまでの暫定の見なし増産率（現在の CpS の25%相当）

  /* GC由来収入の計測（v2.3.8。ChatGPT相談に基づくハイブリッド方式）:
     バフによる上乗せ生産と、GCクリック時の即時付与を、その時点の素の CpS で割って
     正規化しながら貯める。評価時は「正規化した収入率 × 現在の素の CpS」で増産に換算する。
     構成（周回数とGC系の所有状況）が変わったら別の区切りとして測り直す。 */
  var gcTel = (function () {
    try {
      var v = gmGet('ccauto_gcTel', null);
      if (v && typeof v.secs === 'number') {
        if (typeof v.buffSolo !== 'number') { v.buffSolo = v.buffNorm || 0; v.buffMulti = 0; } // v2.3.8形式からの移行
        return v;
      }
    } catch (e) { /* ignore */ }
    return { fp: '', secs: 0, buffSolo: 0, buffMulti: 0, instNorm: 0, clicks: 0, announced: 0 };
  })();
  // GC系の所有状況だけを区切りにする（昇天では区切らない: 正規化した収入率は周回をまたいで使える）
  function gcFingerprint(G) {
    var s = '';
    for (var i = 0; i < GC_BOOSTER_NAMES.length; i++) {
      var u = findUpgrade(G, GC_BOOSTER_NAMES[i]);
      s += (u && u.bought) ? '1' : '0';
    }
    return s;
  }
  // 所有状況が変わったら、計測を捨てずに「効果が約2倍/半分になる」分だけ換算して引き継ぐ
  function gcRescale(oldFp, newFp) {
    if (!oldFp || oldFp.length !== newFp.length) return;
    for (var i = 0; i < GC_BOOSTER_NAMES.length; i++) {
      var o = oldFp.charAt(i), n = newFp.charAt(i);
      if (o === n) continue;
      var isDur = (GC_BOOSTER_NAMES[i] === 'get lucky');
      if (n === '1') { // 買った
        if (isDur) { gcTel.buffSolo *= 2; gcTel.buffMulti *= 2; }
        else gcTel.secs = Math.max(1, gcTel.secs / 2);
      } else { // 昇天で失った
        if (isDur) { gcTel.buffSolo /= 2; gcTel.buffMulti /= 2; }
        else gcTel.secs *= 2;
      }
    }
  }
  function sampleGcIncome() {
    var G = W.Game;
    if (!state.running || ascendBusy()) return;
    var fp = gcFingerprint(G);
    if (gcTel.fp !== fp) {
      if (gcTel.secs > 0 && gcTel.fp) { gcRescale(gcTel.fp, fp); gcTel.fp = fp; }
      else gcTel = { fp: fp, secs: 0, buffSolo: 0, buffMulti: 0, instNorm: 0, clicks: 0, announced: 0 };
    }
    var base = 0, finalCps = 0, mc = 1;
    try {
      base = (typeof G.cookiesPsRaw === 'number') ? G.cookiesPsRaw : 0;
      finalCps = (typeof G.cookiesPs === 'number') ? G.cookiesPs : base;
      var buffs = G.buffs || {};
      for (var bn in buffs) { var bf = buffs[bn]; if (bf && typeof bf.multClick === 'number' && bf.multClick > 0) mc *= bf.multClick; }
    } catch (e) { return; }
    if (!(base > 0)) return;
    var clickNow = 0, clickBase = 0;
    try { clickNow = mouseCps(); clickBase = mc > 0 ? clickNow / mc : clickNow; } catch (e) { clickNow = 0; clickBase = 0; }
    var extra = Math.max(0, finalCps - base) + clickRate() * Math.max(0, clickNow - clickBase);
    if (extra > 0) {
      // バフ同士の重なり具合も分かるよう、同時に効いているバフの数で分けて貯める
      var nBuffs = 0;
      try { nBuffs = Object.keys(G.buffs || {}).length; } catch (e) { nBuffs = 1; }
      if (nBuffs >= 2) gcTel.buffMulti += extra / base; else gcTel.buffSolo += extra / base;
    }
    gcTel.secs++;
    if (gcTel.secs % 60 === 0) { try { gmSet('ccauto_gcTel', gcTel); gmSet('ccauto_discTel', discTel); } catch (e) { /* ignore */ } }
    if (!gcTel.announced && gcTel.secs >= 300 && gcTel.clicks >= 5) {
      gcTel.announced = 1;
      log('ゴールデンクッキーの収入計測が貯まったため、GC系の評価を実測に切り替えます');
    }
  }
  function gcEventStart() {
    try {
      var G = W.Game;
      var sh = G.shimmers || [];
      var n = 0;
      for (var i = 0; i < sh.length; i++) { if (sh[i] && sh[i].type === 'golden' && !sh[i].wrath) n++; }
      if (n <= 0) return null;
      return {
        e0: G.cookiesEarned || 0,
        base0: (typeof G.cookiesPsRaw === 'number') ? G.cookiesPsRaw : 0,
        rate0: ((typeof G.cookiesPs === 'number') ? G.cookiesPs : 0) + clickRate() * mouseCps(),
        clicks0: G.goldenClicks || 0,
        fp: gcFingerprint(G)
      };
    } catch (e) { return null; }
  }
  function gcEventFinish(tok) {
    setTimeout(function () {
      try {
        var G = W.Game;
        if (!tok || gcFingerprint(G) !== tok.fp || gcTel.fp !== tok.fp) return;
        var dc = (G.goldenClicks || 0) - tok.clicks0;
        if (dc <= 0) return;
        gcTel.clicks += dc;
        var inst = (G.cookiesEarned || 0) - tok.e0 - tok.rate0 * 0.7;
        if (inst > 0 && tok.base0 > 0) gcTel.instNorm += inst / tok.base0;
        try { gmSet('ccauto_gcTel', gcTel); } catch (e2) { /* ignore */ }
      } catch (e) { /* ignore */ }
    }, 700);
  }
  function gcBoosterGain(up, cpsNow) {
    var isDuration = ((up.name || '').toLowerCase() === 'get lucky');
    if (gcTel.secs >= 300 && gcTel.clicks >= 5 && cpsNow > 0) {
      var buffTotal = (gcTel.buffSolo || 0) + (gcTel.buffMulti || 0);
      var g;
      if (isDuration) {
        // 時間系はバフ由来分が約2倍になる分。さらに、バフ同士が重なっている割合だけ
        // 「重なりやすくなる」利益を上乗せする（重なり中に得た分の割合で見積もる）
        var s = buffTotal > 0 ? (gcTel.buffMulti || 0) / buffTotal : 0;
        g = (buffTotal / gcTel.secs) * (1 + s) * cpsNow;
      } else {
        // 頻度系は GC 由来収入の全体が約2倍になる分
        g = ((buffTotal + (gcTel.instNorm || 0)) / gcTel.secs) * cpsNow;
      }
      if (g > cpsNow * 3) g = cpsNow * 3; // 暴走防止の上限
      if (g > 0) return g;
    }
    return cpsNow * GC_BOOSTER_GAIN_RATE;
  }

  /* 価格割引系の計測と評価（v2.3.9）:
     生産に効かない候補は「買ったことにして他の価格が下がるか」を一度だけ実測し、
     割引があれば、将来の購入費の節約分（収入×支出割合×割引率）を増産とみなして評価する。 */
  var discTel = (function () {
    try { var v = gmGet('ccauto_discTel', null); if (v && typeof v.earned === 'number') return v; } catch (e) { /* ignore */ }
    return { resets: -1, earned: 0, upSpend: 0, bSpend: 0 };
  })();
  var lastEarnedSeen = -1;
  function sampleSpend() {
    var G = W.Game;
    var resets = G.resets || 0;
    if (discTel.resets !== resets) { discTel = { resets: resets, earned: 0, upSpend: 0, bSpend: 0 }; lastEarnedSeen = -1; }
    var e = G.cookiesEarned || 0;
    if (lastEarnedSeen >= 0 && e > lastEarnedSeen) discTel.earned += (e - lastEarnedSeen);
    lastEarnedSeen = e;
  }
  function measureDiscount(G, up) {
    var sampleUp = null, sampleB = null;
    try {
      var store = G.UpgradesInStore || [];
      for (var i = 0; i < store.length; i++) { if (store[i] && store[i] !== up && !store[i].bought) { sampleUp = store[i]; break; } }
      for (var bn in G.Objects) { if (G.Objects[bn]) { sampleB = G.Objects[bn]; break; } }
    } catch (e) { /* ignore */ }
    if (!sampleUp && !sampleB) return null;
    var upBefore = 0, bBefore = 0;
    try { if (sampleUp) upBefore = sampleUp.getPrice(); } catch (e) { upBefore = 0; }
    try { if (sampleB) bBefore = sampleB.getPrice(); } catch (e) { bBefore = 0; }
    var res = { up: 0, b: 0 };
    try {
      up.bought = 1;
      var upAfter = 0, bAfter = 0;
      try { if (sampleUp) upAfter = sampleUp.getPrice(); } catch (e) { upAfter = 0; }
      try { if (sampleB) bAfter = sampleB.getPrice(); } catch (e) { bAfter = 0; }
      up.bought = 0;
      if (upBefore > 0 && upAfter > 0 && upAfter < upBefore) res.up = 1 - upAfter / upBefore;
      if (bBefore > 0 && bAfter > 0 && bAfter < bBefore) res.b = 1 - bAfter / bBefore;
    } catch (e) { try { up.bought = 0; } catch (e2) { /* ignore */ } return null; }
    return res;
  }
  function discountValue(up, cpsNow) {
    var cache = {};
    try { cache = gmGet('ccauto_discountCache', {}) || {}; } catch (e) { cache = {}; }
    var d = cache[up.name];
    if (!d) {
      d = measureDiscount(W.Game, up);
      if (!d) return 0;
      cache[up.name] = d;
      try { gmSet('ccauto_discountCache', cache); } catch (e) { /* ignore */ }
    }
    if (!((d.up || 0) > 0 || (d.b || 0) > 0)) return 0;
    var income = cpsNow + clickRate() * mouseCps(); // 収入/秒の近似（GC収入を含まない保守側）
    if (!(income > 0)) return 0;
    var upShare = 0.25, bShare = 0.75; // 支出割合の計測が貯まるまでの目安
    var totalSpend = (discTel.upSpend || 0) + (discTel.bSpend || 0);
    if (discTel.earned > income * 600 && totalSpend > 0) {
      upShare = discTel.upSpend / totalSpend;
      bShare = discTel.bSpend / totalSpend;
    }
    return income * (upShare * (d.up || 0) + bShare * (d.b || 0));
  }

  // 全体系アップグレードの候補判定。名前のパターンでは判定しない。
  // （名前に "heavenly" と付く通常ショップ品を天上品と誤認し、名声解放の5つを買い逃した事故の教訓。v2.3.6）
  // ふるいはゲーム側の分類（pool）と、危険な仕組みの明示的な禁止リスト（isBlockedUpgrade、先に判定される）だけ。
  // 最終判断はシミュレーション実測に任せ、増産が正のものだけが候補に残る。
  function isGlobalAdmissible(up) {
    var pool = '';
    try { pool = up.pool || ''; } catch (e) { pool = ''; }
    if (pool === 'tech' || pool === 'toggle' || pool === 'prestige' || pool === 'debug') return false;
    var n = (up.name || '').toLowerCase();
    if (/egg/.test(n)) return false; // 卵系は測定できない特殊効果が本体なので対象外のまま
    return true;
  }

  // 全体系アップグレード（子猫・全体％・指/マウス系）の効果を、ゲーム本体の再計算で実測する。
  // bought を一時的に立てて CalculateGains し、元の値へ復元する。復元後は
  // CpS・クリック値・所持金・実績数・所有数・過去最高CpS記録が元通りか照合し、
  // 1つでも合わなければ、このセッションではシミュレーション自体を止める。
  var simDisabled = gmGet('ccauto_simDisabled', 0) === 1; // 一度止めたら再読み込みしても戻さない
  var simFailCount = 0; // 全体系の復元照合の連続失敗数（3回続いたら測定方法を停止する）
  var upGainCache = {}; // name -> {dcps, dclick, at, ach, cps, bOwned, uOwned}（正常に測れた結果だけを入れる。v2.3.38）
  // v2.3.38（ChatGPTレビュー）: 無効化された測定を増産0としてキャッシュすると、その品が候補から
  // 落ち続けて買われなくなる。無効結果は理由と次回試行時刻を分けて持ち、通常評価に便乗して測り直す。
  var upRetry = {}; // name -> {reason, nextAt, ach, bOwned, uOwned, cps}
  var upWildPrev = {}; // name -> {dcps, dclick, at}（異常値の確認待ち: 次回も同程度なら正当な大幅増産として採用する）
  var simInvalidCounts = { wild: 0, ach: 0, drift: 0 }; // 送信周期ごとの無効化件数（collectStatus が読み取ってリセット）
  var simMemoAt = {}; // name|reason -> 最後にメモを出した時刻（同じ品・同じ理由は1時間に1回まで）
  function memoSimInvalid(name, reason, detail) {
    if (typeof simInvalidCounts[reason] === 'number') simInvalidCounts[reason]++;
    var key = name + '|' + reason;
    var now = Date.now();
    if (simMemoAt[key] && now - simMemoAt[key] < 3600000) return;
    simMemoAt[key] = now;
    log('測定メモ: 全体系の実測を無効にしました（' + name + '、' +
        (reason === 'wild' ? '異常値' : (reason === 'ach' ? '実績増加' : '派生値のずれ')) +
        (detail ? '、' + detail : '') + '）');
  }
  function setUpRetry(name, reason, now, ach, bOwned, uOwned, cpsNow) {
    upRetry[name] = { reason: reason, nextAt: now + 60000, ach: ach, bOwned: bOwned, uOwned: uOwned, cps: cpsNow };
  }
  function simulatedUpgradeGain(up, cpsNow) {
    if (simDisabled) return 0;
    var name = up.name;
    var now = Date.now();
    var ach = achievementCount();
    var bOwned = 0, uOwned = 0;
    try { bOwned = W.Game.BuildingsOwned || 0; uOwned = W.Game.UpgradesOwned || 0; } catch (e) { /* ignore */ }
    var c = upGainCache[name];
    if (c && c.ach === ach && c.bOwned === bOwned && c.uOwned === uOwned &&
        (now - c.at) < 60000 && c.cps > 0 && Math.abs(cpsNow - c.cps) / c.cps < 0.2) {
      return c.dcps + c.dclick * measuredClickRate();
    }
    // 無効化の直後はしばらく測り直さない（状態が変われば早める）。この間は「効果なし」ではなく「未測定」として0を返す
    var rt = upRetry[name];
    if (rt && now < rt.nextAt && rt.ach === ach && rt.bOwned === bOwned && rt.uOwned === uOwned &&
        !(rt.cps > 0 && cpsNow > 0 && Math.abs(cpsNow - rt.cps) / rt.cps >= 0.2)) {
      return 0;
    }
    var dcps = 0, dclick = 0;
    try {
      var G = W.Game;
      // バフの最中は派生値（CpS・クリック値）が倍率ぶん膨らみ、増分が恒常値とずれるため、この回は測らない（バフ終了後に再評価される）
      if (anyBuffActive()) return 0;
      // 基準の派生値を現在の実状態に揃えてから測る（古い派生キャッシュが基準だと、復元照合で実害のない不一致になる）
      try { G.CalculateGains(); } catch (e0) { /* ignore */ }
      var prod0 = readProduction();
      var cps0 = prod0.cps, click0 = prod0.click;
      var bank0 = G.cookies, ach0 = achievementCount(), uOwned0 = uOwned;
      var origBought = up.bought;
      var highest0 = (typeof G.cookiesPsRawHighest === 'number') ? G.cookiesPsRawHighest : null;
      var failed = false, wild = false;
      up.bought = 1;
      try {
        G.CalculateGains();
        var prod1 = readProduction();
        dcps = Math.max(0, prod1.cps - cps0);
        dclick = Math.max(0, prod1.click - click0);
        // CpS成分が現在の総生産の2倍を超える増え方は測定の乱れとして無効にする（全体％・子猫の正規の効果はこの範囲に収まる）
        if (dcps > Math.max(1, cps0 * 2)) wild = true;
      } catch (e1) { failed = true; }
      try {
        up.bought = origBought;
        G.CalculateGains();
      } catch (e2) { failed = true; } // 復元側の例外は握りつぶさず失敗として扱う
      // 過去最高CpSの記録は再計算で膨らむことがあるため、元の値に戻す
      if (highest0 !== null) { try { G.cookiesPsRawHighest = highest0; } catch (e3) { /* ignore */ } }
      // 照合は分類して扱う: 実状態の不整合（hardFail）だけを失敗として数える。
      // 実績の増加はミルク経由で派生値が正当に増えた可能性があり、今回の測定だけを無効にする。
      // 派生値だけのずれは、再計算をもう1回かけて収まるか試してから判定する。
      var hardFail = failed, achJump = false, driftFail = false;
      if (!failed) {
        try {
          var tol = Math.max(1, cps0 * 0.001);
          var clickTol = Math.max(0.01, click0 * 0.001);
          var prodR = readProduction();
          var achNowG = achievementCount();
          if (up.bought !== origBought ||
              (highest0 !== null && G.cookiesPsRawHighest !== highest0) ||
              G.cookies !== bank0 || achNowG < ach0 ||
              (G.BuildingsOwned || 0) !== bOwned ||
              (G.UpgradesOwned || 0) !== uOwned0) {
            hardFail = true;
          } else {
            if (achNowG > ach0) achJump = true;
            if (Math.abs(prodR.cps - cps0) > tol || Math.abs(prodR.click - click0) > clickTol) {
              try { G.CalculateGains(); } catch (e5) { /* ignore */ }
              var prodR2 = readProduction();
              if (Math.abs(prodR2.cps - cps0) > tol || Math.abs(prodR2.click - click0) > clickTol) driftFail = true;
            }
          }
        } catch (e4) { hardFail = true; }
      }
      if (hardFail) {
        // 測定方法だけを止め、購入自体は止めない（方針: 止まるのが一番の非効率。異常は報告する）。
        // 1回では止めず、3回続いたら全体系の測定を停止する（建物側と同じ考え方）
        simFailCount++;
        dcps = 0; dclick = 0;
        setUpRetry(name, 'hardfail', now, ach, bOwned, uOwned, cpsNow);
        if (simFailCount >= 3) {
          simDisabled = true;
          gmSet('ccauto_simDisabled', 1);
          upGainCache = {};
          reportError('全体系の効果測定で状態の不一致が続いたため、この測定方法だけを停止しました（購入は継続します）');
        } else {
          log('測定メモ: 全体系の復元照合で不一致（' + simFailCount + '回目）。今回の測定だけ無効にしました');
        }
        return 0;
      } else if (wild && !achJump && !driftFail) {
        // 異常値（総生産の2倍超）: 正当な大幅増産（子猫系など）の可能性もあるため、捨てずに確認待ちにする。
        // 次回の測定でも同程度（3倍以内）で復元も正常なら、正当な増産として採用する（v2.3.38、ChatGPTレビュー）
        var wp = upWildPrev[name];
        if (wp && (now - wp.at) < 600000 && wp.dcps > 0 && dcps > 0 &&
            dcps / wp.dcps >= 1 / 3 && dcps / wp.dcps <= 3) {
          delete upWildPrev[name];
          delete upRetry[name];
          simFailCount = 0;
          upGainCache[name] = { dcps: dcps, dclick: dclick, at: now, ach: ach, cps: cpsNow, bOwned: bOwned, uOwned: uOwned };
          return dcps + dclick * measuredClickRate();
        }
        upWildPrev[name] = { dcps: dcps, dclick: dclick, at: now };
        memoSimInvalid(name, 'wild', '増分 ' + fmt(Math.round(dcps)) + ' / 現在 ' + fmt(Math.round(cps0)));
        setUpRetry(name, 'wild', now, ach, bOwned, uOwned, cpsNow);
        return 0;
      } else if (achJump || driftFail || wild) {
        memoSimInvalid(name, achJump ? 'ach' : 'drift', '');
        setUpRetry(name, achJump ? 'ach' : 'drift', now, ach, bOwned, uOwned, cpsNow);
        return 0;
      } else {
        simFailCount = 0;
      }
    } catch (e) {
      setUpRetry(name, 'error', now, ach, bOwned, uOwned, cpsNow);
      return 0;
    }
    // ここに来るのは正常に測れた場合だけ（増産0の確定も含む）。無効化された測定はキャッシュに入れない
    delete upRetry[name];
    upGainCache[name] = { dcps: dcps, dclick: dclick, at: now, ach: ach, cps: cpsNow, bOwned: bOwned, uOwned: uOwned };
    return dcps + dclick * measuredClickRate();
  }

  // 建物も、1軒増やした状態でゲーム本体に再計算させて「全体の増産」を実測する。
  // 建物同士の相乗効果（他の建物の生産が一緒に増える分）まで含めた正確な増産が得られる。
  // 復元できなければ、この測定方法だけを止めて近似計算に切り替える（購入は止めない）。
  var bSimDisabled = gmGet('ccauto_bSimDisabled', 0) === 1;
  // 建物ごとの測定停止（不一致が続く建物だけを止め、他の建物の実測は続ける）
  var bSimOff = {};
  try { bSimOff = JSON.parse(gmGet('ccauto_bSimOff', '{}') || '{}') || {}; } catch (e) { bSimOff = {}; }
  var bSimFailsBy = {}; // name -> その建物で不一致が連続した回数
  var bGainCache = {}; // name -> {gain, at, ach, cps, bOwned, uOwned}
  function simulatedBuildingGain(obj, cpsNow, cnt, out) {
    var name = obj.name;
    // cnt > 1 はまとめ買い全体の増産実測用（v2.3.17）。キャッシュ・測定停止・報告には触れず、
    // きれいに測れたときだけ値を返し、それ以外は 0（呼び出し側が概算に切り替える）
    var count = (typeof cnt === 'number' && cnt > 1) ? Math.floor(cnt) : 1;
    if (bSimDisabled || bSimOff[name]) return 0;
    var now = Date.now();
    var ach = achievementCount();
    var bOwned = 0, uOwned = 0;
    try { bOwned = W.Game.BuildingsOwned || 0; uOwned = W.Game.UpgradesOwned || 0; } catch (e) { /* ignore */ }
    var c = (count === 1) ? bGainCache[name] : null;
    if (c && c.ach === ach && c.bOwned === bOwned && c.uOwned === uOwned &&
        (now - c.at) < 60000 && c.cps > 0 && Math.abs(cpsNow - c.cps) / c.cps < 0.2) {
      return c.gain;
    }
    var gain = 0;
    try {
      var G = W.Game;
      var bank0 = G.cookies, ach0 = ach, bOwned0 = bOwned;
      var amt0 = obj.amount || 0;
      // 測定前の派生値が古いキャッシュのままだと、復元後の値と基準がずれて実害のない不一致になる。
      // 何も変更しない再計算を1回かけて基準を現在の実状態に揃え、基準側の実績数も取り直す
      try { G.CalculateGains(); } catch (e0) { /* ignore */ }
      ach0 = achievementCount();
      var highest0 = (typeof G.cookiesPsRawHighest === 'number') ? G.cookiesPsRawHighest : null;
      // 増産は「全建物の生産合計（storedTotalCps）の増え方」で測る。
      // 再計算（CalculateGains）が必ず更新する値だけを使うので、メインループ側で管理される値
      // （unbuffedCps や computedMouseCps）の更新タイミングに左右されない。
      // 他の建物の生産が一緒に増える分（相乗効果）も、合計の増え方にそのまま含まれる。
      var storedSum = function () {
        var sm = 0;
        try { for (var k in G.Objects) sm += G.Objects[k].storedTotalCps || 0; } catch (e) { /* ignore */ }
        return sm;
      };
      var sum0 = storedSum();
      // v2.3.30: 検証の物差し（cookiesPsRaw）でも差を取る。全体倍率の推定が不要になる
      var raw0 = 0, rawAfter = 0;
      try { raw0 = (typeof G.cookiesPsRaw === 'number') ? G.cookiesPsRaw : 0; } catch (e) { raw0 = 0; }
      var failed = false, wild = false;
      obj.amount = amt0 + count;
      // 派生カウンタ（所有建物数）も、そのフェーズの値に合わせてから再計算する（Cursor のボーナス計算が参照するため）
      try { G.BuildingsOwned = bOwned0 + count; } catch (e8) { /* ignore */ }
      try {
        G.CalculateGains();
        gain = Math.max(0, storedSum() - sum0);
        try { rawAfter = (typeof G.cookiesPsRaw === 'number') ? G.cookiesPsRaw : 0; } catch (e) { rawAfter = 0; }
        // あり得ない大きさの増え方は測定が乱れたものとして捨てる（判断に使わない）
        var unit0 = 0;
        try { unit0 = unitCpsOf(obj) || 0; } catch (e6) { unit0 = 0; }
        if (gain > Math.max(sum0 * 0.25, unit0 * 30) * count) wild = true;
      } catch (e1) { failed = true; }
      // 復元は「軒数と所有建物数を先に戻してから」再計算する。順序が逆だと、Cursor の
      // Thousand fingers 系ボーナスがずれた値で計算され、stored 値が元に戻らない（v2.2.1の修正）
      try { obj.amount = amt0; G.BuildingsOwned = bOwned0; G.CalculateGains(); } catch (e2) { failed = true; }
      if (highest0 !== null) { try { G.cookiesPsRawHighest = highest0; } catch (e3) { /* ignore */ } }
      try { if ((G.BuildingsOwned || 0) !== bOwned0) G.BuildingsOwned = bOwned0; } catch (e5) { /* ignore */ }
      // どの項目が一致しなかったかを記録する（原因の切り分け用に報告へ含める）
      // 実状態（軒数・所持金・所有数・実績の減少）は厳密に照合する。派生値である storedCps 合計は
      // 段階判定にする: 0.01%以内=正常 / 0.1%以内=再計算でもう1回照合し、収まらなければ今回の測定だけ
      // 無効（概算へ・測定停止や報告はしない）/ 0.1%超=従来通りの不一致として扱う。
      // 実績が増えた場合は、ミルク経由で派生値が正当に増えたものとして、今回の測定だけを無効にする。
      var badFields = [];
      var achJump = false, lightDrift = false;
      if (!failed) {
        try {
          var tolS = Math.max(0.001, sum0 * 0.0001);
          var driftS = Math.abs(storedSum() - sum0);
          if ((obj.amount || 0) !== amt0) badFields.push('amount');
          if (G.cookies !== bank0) badFields.push('cookies');
          var achNowB = achievementCount();
          if (achNowB < ach0) badFields.push('achievements');
          else if (achNowB > ach0) achJump = true;
          if ((G.BuildingsOwned || 0) !== bOwned0) badFields.push('buildingsOwned');
          if (!badFields.length && !achJump && driftS > tolS) {
            if (driftS <= Math.max(0.001, sum0 * 0.001)) {
              try { G.CalculateGains(); } catch (e9) { /* ignore */ }
              if (Math.abs(storedSum() - sum0) > tolS) lightDrift = true;
            } else {
              badFields.push('storedCps');
            }
          }
        } catch (e4) { badFields.push('exception'); }
      }
      if (count > 1) {
        // まとめ買い用の実測はここで確定させる。不一致・実績増加・派生値のずれがあれば使わない
        if (failed || wild || badFields.length || achJump || lightDrift) return 0;
        if (out && rawAfter > raw0) out.rawDelta = rawAfter - raw0;
        return gain;
      }
      if (!failed && !wild && !badFields.length && (achJump || lightDrift)) {
        gain = 0;
        log('測定メモ: ' + name + ' の実測は' + (achJump ? '実績増加' : '派生値のずれ') + 'のため概算に切り替えました');
        bGainCache[name] = { gain: 0, at: now, ach: ach, cps: cpsNow, bOwned: bOwned, uOwned: uOwned };
        return 0;
      }
      if (failed || wild || badFields.length) {
        bSimFailsBy[name] = (bSimFailsBy[name] || 0) + 1;
        gain = 0;
        var parts = badFields.slice();
        if (wild) parts.push('wild');
        if (!parts.length) parts.push('exception');
        var badTxt = parts.join(',');
        if (bSimFailsBy[name] >= 2) {
          bSimOff[name] = 1;
          try { gmSet('ccauto_bSimOff', JSON.stringify(bSimOff)); } catch (e7) { /* ignore */ }
          delete bGainCache[name];
          reportError('建物の効果測定で状態の不一致が続いたため、この建物の測定だけを停止しました（対象: ' + name + '、不一致: ' + badTxt + '、他の建物の測定と購入は継続します）');
        } else {
          reportError('建物の効果測定で状態の不一致を検知しました（対象: ' + name + '、不一致: ' + badTxt + '）。もう一度続くようなら、この建物の測定を停止します（購入は継続します）');
        }
      } else {
        bSimFailsBy[name] = 0;
      }
    } catch (e) { gain = 0; }
    if (count === 1) bGainCache[name] = { gain: gain, at: now, ach: ach, cps: cpsNow, bOwned: bOwned, uOwned: uOwned };
    return gain;
  }

  // 建物1軒の増産: 実測できれば実測値、できなければ従来の近似（単体生産×全体倍率×クリック押し上げ）
  function buildingGainOf(obj, cpsNow, gMult, clickBoost) {
    var sim = simulatedBuildingGain(obj, cpsNow);
    if (sim > 0) return sim * gMult * clickBoost;
    return unitCpsOf(obj) * gMult * clickBoost;
  }

  // クリック押し上げ倍率: マウス系強化1個につき「1クリック = CpSの1%」が実測クリック速度ぶん収入を押し上げる
  function clickBoostNow(rate) {
    var G = W.Game;
    var mouseOwned = 0;
    try { for (var mk in G.Upgrades) { if (G.Upgrades[mk].bought && /mouse/i.test(mk)) mouseOwned++; } } catch (e) { mouseOwned = 0; }
    try { var f104 = G.Upgrades['Fortune #104']; if (f104 && f104.bought) mouseOwned++; } catch (e) { /* ignore */ } // Fortune #104 も同じ+1%
    return 1 + mouseOwned * 0.01 * (rate || 0);
  }

  // 天界チップ解放系（通常ショップの5種）: プレステージ倍率（+1%/レベル）を段階的に解放する。
  // 解放率とプレステージ数が分かれば増産は計算式で正確に出る。実測シミュレーションだと
  // 増分が現CpSの何倍にもなり、異常値ガード（現CpSの2倍超は無効）に引っかかって
  // 永遠に買えなくなるため、この5種だけは式で評価する（GC系・割引系と同じ「特殊な仕組みは別扱い」）。
  var PRESTIGE_UNLOCKERS = [
    { name: 'Heavenly chip secret', to: 0.05 },
    { name: 'Heavenly cookie stand', to: 0.25 },
    { name: 'Heavenly bakery', to: 0.50 },
    { name: 'Heavenly confectionery', to: 0.75 },
    { name: 'Heavenly key', to: 1.00 }
  ];
  function prestigeUnlockerGain(up, cpsNow) {
    var G = W.Game;
    var prestige = 0;
    try { prestige = G.prestige || 0; } catch (e) { prestige = 0; }
    if (!(prestige > 0) || !(cpsNow > 0)) return 0;
    var step = null, cur = 0;
    for (var i = 0; i < PRESTIGE_UNLOCKERS.length; i++) {
      if (PRESTIGE_UNLOCKERS[i].name === up.name) step = PRESTIGE_UNLOCKERS[i];
      var pu = findUpgrade(G, PRESTIGE_UNLOCKERS[i].name);
      if (pu && pu.bought) cur = PRESTIGE_UNLOCKERS[i].to; // 解放率は所有済みの最も進んだ段階まで
    }
    if (!step || step.to <= cur) return 0; // 対象外、または前の段階が先（店頭には順番どおりに並ぶ）
    // 現在のCpSは解放率curの倍率を含んだ値なので、差分は割り戻して計算する
    var dcps = cpsNow * prestige * (step.to - cur) / (1 + prestige * cur);
    if (!(dcps > 0)) return 0;
    return dcps * clickBoostNow(measuredClickRate());
  }

  function evaluateCandidates() {
    var G = W.Game;
    var out = [];
    var cpsNow = baseCps();
    // 建物系の増産（全体倍率の適用前）と全体系の増産（適用後の実測）を同じ物差しに揃えるため、
    // 現在効いている全体倍率（バフなしCpS ÷ 建物生産の単純合計）を建物系の gain に掛ける
    var rawSum = 0;
    try { for (var rk in G.Objects) { rawSum += G.Objects[rk].storedTotalCps || 0; } } catch (e) { rawSum = 0; }
    // 特殊な卵（"egg"）は建物合計に含まれない固定+9 CpSを持つため、分母に足して倍率を正す
    var flatCps = 0;
    try { if (G.Has && (G.Has('egg') || G.Has('"egg"'))) flatCps = 9; } catch (e) { flatCps = 0; }
    var gMult = (rawSum + flatCps) > 0 ? cpsNow / (rawSum + flatCps) : 1;
    if (!(gMult > 0) || !isFinite(gMult)) gMult = 1;
    // マウス系強化（1クリックにCpSの1%ずつ）は建物系の増産でクリック収入も押し上げるため、その分を gain に含める
    var clickBoost = clickBoostNow(measuredClickRate());

    // 建物
    for (var key in G.Objects) {
      var obj = G.Objects[key];
      if (!obj || obj.locked) continue;
      var gain = buildingGainOf(obj, cpsNow, gMult, clickBoost);
      if (!(gain > 0)) continue;
      var price = buildingPrice(obj);
      var nextCount = (obj.amount || 0) + 1;
      out.push({
        kind: 'building', ref: obj, label: obj.name + '（' + nextCount + '軒目）',
        price: price, gain: gain, payback: price / gain
      });
    }

    // アップグレード（店頭にあるものだけ。建物ひも付き倍率系＋全体系を自動購入する）
    var store = G.UpgradesInStore || [];
    for (var i = 0; i < store.length; i++) {
      var up = store[i];
      if (!up || up.bought) continue;
      if (isBlockedUpgrade(up)) continue;
      // スイッチ類（pool 'toggle'）は全経路で自動購入の対象外（v2.3.39、仕様として明示。ChatGPTレビュー）
      var poolChk = '';
      try { poolChk = up.pool || ''; } catch (e) { poolChk = ''; }
      if (poolChk === 'toggle') continue;
      var tie = up.buildingTie1 || null;
      if (up.buildingTie2) continue; // シナジーは計算式が別（所有数比例）なので、過大評価を避けて対象外
      if (!tie) {
        // 全体系は、ゲーム側の分類で対象外のものを除き、ゲーム本体の再計算で実測して評価する
        if (!isGlobalAdmissible(up)) continue;
        // ゴールデンクッキー系は再計算で測れないので、見なし増産で回収順位に混ぜる
        if (GC_BOOSTER_NAMES.indexOf((up.name || '').toLowerCase()) >= 0) {
          var gbGain = gcBoosterGain(up, cpsNow);
          if (!(gbGain > 0)) continue;
          var gbPrice = (typeof up.getPrice === 'function') ? up.getPrice() : up.basePrice;
          out.push({
            kind: 'upgrade', ref: up, label: up.name,
            price: gbPrice, gain: gbGain, payback: gbPrice / gbGain, noVerify: true
          });
          continue;
        }
        // 天界チップ解放系は計算式で評価する（シミュレーションの異常値ガードに引っかかる大きさのため）
        var puGain = prestigeUnlockerGain(up, cpsNow);
        if (puGain > 0) {
          var puPrice = (typeof up.getPrice === 'function') ? up.getPrice() : up.basePrice;
          out.push({
            kind: 'upgrade', ref: up, label: up.name,
            price: puPrice, gain: puGain, payback: puPrice / puGain, noVerify: true
          });
          continue;
        }
        var gGain = simulatedUpgradeGain(up, cpsNow);
        if (!(gGain > 0)) {
          // 生産に効かないものは、価格割引の効果が無いか実測し、あれば節約分を増産とみなして混ぜる
          var dvGain = discountValue(up, cpsNow);
          if (!(dvGain > 0)) continue; // 生産・クリック値・価格のどれにも効かないもの（研究解放など）は買わない
          var dvPrice = (typeof up.getPrice === 'function') ? up.getPrice() : up.basePrice;
          out.push({
            kind: 'upgrade', ref: up, label: up.name,
            price: dvPrice, gain: dvGain, payback: dvPrice / dvGain, noVerify: true
          });
          continue;
        }
        var gPrice = (typeof up.getPrice === 'function') ? up.getPrice() : up.basePrice;
        out.push({
          kind: 'upgrade', ref: up, label: up.name,
          price: gPrice, gain: gGain, payback: gPrice / gGain
        });
        continue;
      }
      if (typeof up.tier !== 'number') continue; // ティア（×2）強化だけを対象にする（指系などは効果が異なる）
      // 倍率アップグレードも、買った状態で再計算して全体の増産を実測する（相乗効果込み）。測れない場合は従来の近似に切り替える
      var tiedTotal = simulatedUpgradeGain(up, cpsNow);
      if (!(tiedTotal > 0)) tiedTotal = (tie.storedTotalCps || 0) * gMult * clickBoost;
      if (!(tiedTotal > 0)) continue;
      var uPrice = (typeof up.getPrice === 'function') ? up.getPrice() : up.basePrice;
      out.push({
        kind: 'upgrade', ref: up, label: up.name,
        price: uPrice, gain: tiedTotal, payback: uPrice / tiedTotal
      });
    }

    // 先読み: まだ解放されていない「建物×2」ティア強化を、
    // 解放に必要な軒数分の建物とセットで評価する（ショップに出る前に予想する）
    var TIERS = [1, 5, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600];
    var lockedByBuilding = {};
    for (var uname in G.Upgrades) {
      var lu = G.Upgrades[uname];
      if (!lu || lu.bought || lu.unlocked) continue;
      if (isBlockedUpgrade(lu)) continue;
      var lt = null;
      try { lt = lu.buildingTie1 || null; } catch (e) { lt = null; }
      if (!lt || !lt.name) continue;
      if (typeof lu.tier !== 'number' || lu.tier < 1) continue; // ティア強化だけを対象にする
      if (!lockedByBuilding[lt.name]) lockedByBuilding[lt.name] = [];
      lockedByBuilding[lt.name].push(lu);
    }
    for (var bkey in G.Objects) {
      var bobj = G.Objects[bkey];
      if (!bobj || bobj.locked) continue;
      var amt = bobj.amount || 0;
      if (amt < 1) continue;
      var ups = lockedByBuilding[bobj.name];
      if (!ups || !ups.length) {
        // 建物側にティア強化の一覧がある場合はそちらも使う
        ups = [];
        try {
          if (bobj.tieredUpgrades) {
            for (var tk in bobj.tieredUpgrades) {
              var tu = bobj.tieredUpgrades[tk];
              if (tu && typeof tu === 'object' && !tu.bought && !tu.unlocked) ups.push(tu);
            }
          }
        } catch (e) { ups = []; }
        if (!ups.length) continue;
      }
      ups.sort(function (a, b) {
        var ta = (typeof a.tier === 'number') ? a.tier : 999;
        var tb = (typeof b.tier === 'number') ? b.tier : 999;
        if (ta !== tb) return ta - tb;
        return (a.basePrice || 0) - (b.basePrice || 0);
      });
      var nextUp = ups[0];
      var threshold = 0;
      // 解放軒数はゲーム内部の定義（Game.Tiers）を最優先で参照する
      try {
        var gt = (G.Tiers && typeof nextUp.tier === 'number') ? G.Tiers[nextUp.tier] : null;
        if (gt && typeof gt.unlock === 'number') threshold = gt.unlock;
      } catch (e) { threshold = 0; }
      if (!threshold && typeof nextUp.tier === 'number' && nextUp.tier >= 1 && nextUp.tier <= TIERS.length) {
        threshold = TIERS[nextUp.tier - 1];
      }
      if (!threshold) {
        for (var ti = 0; ti < TIERS.length; ti++) { if (TIERS[ti] > amt) { threshold = TIERS[ti]; break; } }
      }
      if (!threshold || threshold <= amt) continue;
      var need = threshold - amt;
      if (need > 100) continue;
      var simUnit = buildingGainOf(bobj, cpsNow, gMult, clickBoost);
      if (!(simUnit > 0)) continue;
      var unitPrice = buildingPrice(bobj);
      var setPrice = unitPrice * (Math.pow(1.15, need) - 1) / 0.15 +
        ((typeof nextUp.getPrice === 'function') ? nextUp.getPrice() : (nextUp.basePrice || 0));
      // セット完成後のその建物の寄与は (amt+need) 軒×2倍。現在は amt 軒ぶん
      var setGain = ((amt + need) * 2 - amt) * simUnit;
      if (!(setGain > 0)) continue;
      out.push({
        kind: 'set', ref: nextUp, buildingRef: bobj,
        label: bobj.name + ' ' + threshold + '軒セット（倍強化込み）',
        price: setPrice, gain: setGain, payback: setPrice / setGain,
        setAmt: amt, setNeed: threshold // セット目標の達成率は軒数ベースで計算する
      });
    }

    out.sort(function (a, b) { return a.payback - b.payback; });
    return { list: out, cpsNow: cpsNow, gMult: gMult, clickBoost: clickBoost };
  }

  /* ---------------- 購入の実行 ---------------- */

  // n個まとめ買いの合計価格。ゲーム側の合計価格関数があればそれを使い、無ければ等比級数で近似する
  function sumPriceFor(obj, unitPrice, n) {
    try {
      if (typeof obj.getSumPrice === 'function') {
        var sp = obj.getSumPrice(n);
        if (sp > 0 && isFinite(sp)) return sp;
      }
    } catch (e) { /* ignore */ }
    return unitPrice * (Math.pow(1.15, n) - 1) / 0.15;
  }

  // まとめ買い（v2.3.17）の個数を決める。返り値は 100 / 10 / 1 のいずれか
  // （節目まで10個未満しか残っていない場合だけ、その残り個数をそのまま返す）。
  // 線引き: (1) ティア解放の節目（25/50/100…）は絶対に超えない (2) 最後の1個の限界回収期間
  // （価格×1.15^k ÷ 単位増産）が次善候補の回収期間を超えない (3) 合計価格が所持金に収まる。
  // capSet > 0 のときはセット目標の残り必要軒数も上限にする（その場合は次善比較を使わない）。
  function bulkQtyFor(obj, unitPrice, unitPayback, nextBestPayback, capSet, bank) {
    var amt = obj.amount || 0;
    var cap = 100;
    var TIERS = [1, 5, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600];
    for (var i = 0; i < TIERS.length; i++) {
      if (TIERS[i] > amt) { cap = Math.min(cap, TIERS[i] - amt); break; }
    }
    if (capSet && capSet > 0) cap = Math.min(cap, Math.floor(capSet));
    if (!(capSet && capSet > 0) && unitPayback > 0 && isFinite(nextBestPayback)) {
      if (nextBestPayback <= unitPayback) return 1;
      var run = Math.floor(Math.log(nextBestPayback / unitPayback) / Math.log(1.15)) + 1;
      cap = Math.min(cap, Math.max(1, run));
    }
    if (!(cap > 1)) return 1;
    // 上限の範囲で買える最大個数をそのまま1回で買う（v2.3.21、ChatGPT相談）。
    // 以前は ×100 / ×10 に丸めていたため、端数ぶんが次の判断に持ち越されて購入回数が増えていた。
    var lo = 1, hi = Math.floor(cap), best = 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (sumPriceFor(obj, unitPrice, mid) <= bank) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  // 建物を qty 個買う。買えた個数を返す（0 = 買えなかった）。
  // buy(個数) はゲーム本体の一括購入（価格は等比級数の合計）。Game.buyBulk には触れない
  // （プレイヤーの店舗設定そのものなので、書き換えると表示や手動操作と競合するため）。
  // 売却モード（buyMode !== 1）のときは誤って売却しないよう買わない。
  // 予定より少なく買えた場合は追わず、実個数を返す（次の判断で再評価される）。
  function buyBuildingUnits(obj, qty) {
    var G = W.Game;
    try { if (typeof G.buyMode === 'number' && G.buyMode !== 1) return 0; } catch (e) { /* ignore */ }
    var before = obj.amount || 0;
    try { obj.buy(qty); } catch (e) { /* ignore */ }
    var got = (obj.amount || 0) - before;
    return got > 0 ? got : 0;
  }

  function doBuy(cand, quiet) {
    // v2.3.39: ショップ購入OFFの間は、どの呼び出し経路からも買わない（実行側の二重の門。
    // 昇天フローの天上購入は doBuy を使わないため、この門では止まらない）
    if (gmGet('ccauto_shopBuy', '1') !== '1') return false;
    var G = W.Game;
    var bankBefore = G.cookies;
    // 購入後検証の物差しを固定するため、購入時点の予測内訳（全体系のみ）とクリック実測速度を控える。
    // キャッシュは購入直後に捨てられるので、買う前に読むこと
    var preParts = null;
    try {
      if (cand.kind === 'upgrade' && cand.ref && upGainCache[cand.ref.name]) {
        var uc0 = upGainCache[cand.ref.name];
        if (typeof uc0.dcps === 'number' && typeof uc0.dclick === 'number' && (uc0.dcps > 0 || uc0.dclick > 0)) {
          preParts = { cps: uc0.dcps, click: uc0.dclick };
        }
      }
    } catch (eP) { preParts = null; }
    var preRate = 0;
    try { var mr = measuredClickRate(); if (isFinite(mr) && mr > 0) preRate = mr; } catch (eR) { preRate = 0; }
    // 建物・セットの gain はクリック押し上げ込みの「収入」ベースだが、検証は CpS 分だけで比べる。
    // 購入時点の clickBoost で割って、CpS 分だけの予測を検証用に持つ（v2.3.5）
    if (!preParts && (cand.kind === 'building' || cand.kind === 'set') && (cand.gain || 0) > 0) {
      try {
        var cbNow = clickBoostNow(preRate);
        if (cbNow > 0 && isFinite(cbNow)) preParts = { cps: cand.gain / cbNow, click: 0 };
      } catch (eB) { /* ignore */ }
    }
    // まとめ買い（v2.3.17）: バッチ全体の増産を実測し、検証用の予測にする。
    // 実測できなければ単位予測×個数の概算に切り替える（購入自体は止めない）
    var bulkQty = (cand.kind === 'building' && typeof cand.qty === 'number' && cand.qty > 1) ? Math.floor(cand.qty) : 1;
    var bulkPredCps = null;
    if (bulkQty > 1) {
      var bSimGain = 0;
      var simOut = {};
      try { bSimGain = simulatedBuildingGain(cand.ref, baseCps(), bulkQty, simOut); } catch (eS) { bSimGain = 0; }
      // v2.3.30: 予測は検証と同じ物差し（cookiesPsRaw の差）を優先する。
      // 従来の storedTotalCps 合計の差は全体倍率の適用前で、実測とずれる
      if (typeof simOut.rawDelta === 'number' && simOut.rawDelta > 0) bulkPredCps = simOut.rawDelta;
      else if (bSimGain > 0) bulkPredCps = bSimGain;
      else if (preParts && preParts.cps > 0) bulkPredCps = preParts.cps * bulkQty;
    }
    // 購入後検証の物差しは readProduction() に統一する（シミュレーションと同じ読み方）
    var prodBefore = null;
    try { prodBefore = readProduction(); } catch (e) { /* ignore */ }
    var cpsBefore = prodBefore ? prodBefore.cps : 0;
    var clickBefore = prodBefore ? prodBefore.click : 0;
    // 検証の物差し（実績・バフ・パンテオンの署名）も購入前に揃える（v2.3.40、ChatGPTレビュー）。
    // 購入後に取ると、購入自体が起こした実績解禁などを「変化なし」として扱ってしまい、
    // 検証の切り分け（条件変化ならSKIP）が働かない
    var achBeforeBuy = null, buffsBeforeBuy = null, pantheonBeforeBuy = null;
    try { achBeforeBuy = achievementsWon(); } catch (e) { /* ignore */ }
    try { buffsBeforeBuy = buffSignature(); } catch (e) { /* ignore */ }
    try { pantheonBeforeBuy = pantheonSignature(); } catch (e) { /* ignore */ }
    var writeVerify = !cand.noVerify; // 効果を再計算で検証できない購入（ゴールデンクッキー系）は検証を記録しない
    try {
      if (cand.kind === 'building') {
        var gotQty = buyBuildingUnits(cand.ref, bulkQty);
        if (gotQty > 0) {
          // 割引系の評価用に支出を記録する（まとめ買いは実際の所持金減少で数える）
          discTel.bSpend += (bulkQty > 1) ? Math.max(0, bankBefore - G.cookies) : (cand.price || 0);
          upGainCache = {}; bGainCache = {}; // 購入が入ったら効果測定のキャッシュは捨て直す
          if (bulkQty > 1 && gotQty < bulkQty) {
            log('まとめ買いメモ: ' + cand.ref.name + ' は ' + bulkQty + ' 個の予定で ' + gotQty + ' 個になりました（残りは次の判断で再評価します）');
          }
          if (writeVerify) {
            var pvLabel = cand.label, pvGain = cand.gain || 0;
            var pvPredCps = preParts ? preParts.cps : null, pvPredClick = preParts ? preParts.click : null;
            var pvPartial = false;
            if (bulkQty > 1) {
              pvLabel = cand.ref.name + ' ×' + gotQty;
              // 予定個数まで買えなかった回は、比例換算では節目・相乗効果を取りこぼすため
              // 検証を判定せず記録だけ残す（v2.3.30、ChatGPTレビューに基づく）
              pvPartial = gotQty < bulkQty;
              if (bulkPredCps !== null) {
                pvPredCps = bulkPredCps;
                var cbB = 1;
                try { cbB = clickBoostNow(preRate); if (!(cbB > 0) || !isFinite(cbB)) cbB = 1; } catch (eCB) { cbB = 1; }
                pvGain = pvPredCps * cbB;
                pvPredClick = 0;
              } else {
                pvGain = (cand.gain || 0) * gotQty;
              }
            }
            state.pendingVerify = { at: Date.now(), label: pvLabel, kind: cand.kind, gain: pvGain, cpsBefore: cpsBefore, clickBefore: clickBefore, achBefore: achBeforeBuy, buffs: buffsBeforeBuy, rateAtBuy: preRate, predCps: pvPredCps, predClick: pvPredClick, pantheon: pantheonBeforeBuy, partial: pvPartial };
            gmSet('ccauto_pendingVerify', state.pendingVerify); // 再読み込みで検証を飛ばさないよう永続化
          }
          if (!quiet) {
            log('購入: ' + cand.label + ' / ' + fmt(cand.price) + ' / 回収約' + Math.round(cand.payback / 360) / 10 + '時間');
            // v2.3.30: 購入ごとの即時送信はやめ、1分周期の送信に集約する（タブの負荷軽減）
          }
          recordEvent({ k: 'b', name: cand.ref.name, qty: gotQty, target: (cand.ref.amount || 0), src: (cand.__src || 'normal') });
          return gotQty;
        }
      } else {
        cand.ref.buy();
        if (cand.ref.bought) { // アップグレード系は常に1件（doBuy の返り値は購入個数）
          if (cand.kind === 'upgrade') discTel.upSpend += cand.price || 0; else discTel.bSpend += cand.price || 0; // 割引系の評価用に支出を記録する
          upGainCache = {}; bGainCache = {}; // 購入が入ったら効果測定のキャッシュは捨て直す
          if (writeVerify) {
            state.pendingVerify = { at: Date.now(), label: cand.label, kind: cand.kind, gain: cand.gain || 0, cpsBefore: cpsBefore, clickBefore: clickBefore, achBefore: achBeforeBuy, buffs: buffsBeforeBuy, rateAtBuy: preRate, predCps: preParts ? preParts.cps : null, predClick: preParts ? preParts.click : null, pantheon: pantheonBeforeBuy, partial: false };
            gmSet('ccauto_pendingVerify', state.pendingVerify); // 再読み込みで検証を飛ばさないよう永続化
          }
          if (!quiet) {
            log('購入: ' + cand.label + ' / ' + fmt(cand.price) + ' / 回収約' + Math.round(cand.payback / 360) / 10 + '時間');
            // v2.3.30: 購入ごとの即時送信はやめ、1分周期の送信に集約する（タブの負荷軽減）
          }
          recordEvent({ k: 'u', name: cand.ref.name, src: (cand.__src || 'normal') });
          return 1;
        }
      }
    } catch (e) { /* 失敗しても次周期で再評価 */ }
    if (G.cookies < bankBefore - cand.price * 1.5) {
      // 想定外の支出があったら記録だけ残す
      log('注意: 購入検証に失敗（' + cand.label + '）');
    }
    return false;
  }

  // 実際にゲームへ登録されたクリック速度の実測（直近30秒のクリック数の伸びから算出）
  var clickSamples = [];
  var clickResetsSeen = -1;
  function sampleClicks() {
    try {
      if (!gameReady()) return;
      var now = Date.now();
      // 転生をまたいだ標本は切り捨てる（同じ文書で転生するとクリック数が0に戻り、実測が壊れる。v2.3.40、ChatGPTレビュー）
      var rsNow = W.Game.resets || 0;
      var ckNow = W.Game.cookieClicks || 0;
      if (clickResetsSeen !== -1 && rsNow !== clickResetsSeen) clickSamples = [];
      clickResetsSeen = rsNow;
      if (clickSamples.length && ckNow < clickSamples[clickSamples.length - 1][1]) clickSamples = [];
      clickSamples.push([now, ckNow]);
      while (clickSamples.length > 2 && now - clickSamples[0][0] > 30000) clickSamples.shift();
      try { sampleGcIncome(); } catch (e2) { /* ignore */ }
      try { sampleSpend(); } catch (e3) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }
  function measuredClickRate() {
    // 実測が十分に溜まるまでは設定値で代用する（起動直後の数十秒だけ）
    if (clickSamples.length >= 2) {
      var first = clickSamples[0], last = clickSamples[clickSamples.length - 1];
      var dt = (last[0] - first[0]) / 1000;
      if (dt >= 3) return Math.max(0, (last[1] - first[1]) / dt);
    }
    return clickRate();
  }

  function totalIncome(cpsNow) {
    // 生産（CpS）＋クリック収入の合計。クリックは設定値ではなく実測の登録速度で見積もる
    return cpsNow + measuredClickRate() * mouseCps();
  }

  // 第1目標・第2目標の達成率。通常は所持÷価格、セット目標は軒数ベース（現在÷必要軒数）
  function goalPctOf(cand, bank) {
    if (!cand) return 0;
    if (cand.kind === 'set' && cand.setNeed > 0) {
      return Math.min(100, Math.floor((cand.setAmt || 0) / cand.setNeed * 100));
    }
    if (!(cand.price > 0)) return 0;
    return Math.min(100, Math.floor(bank / cand.price * 100));
  }

  function goalInfo(cand, bank, inc) {
    if (!cand) return null;
    var eta = (inc > 0 && cand.price > bank) ? Math.round((cand.price - bank) / inc) : 0;
    var info = { label: cand.label, price: Math.round(cand.price), pct: goalPctOf(cand, bank), etaSec: eta, kind: cand.kind, active: false };
    if (cand.kind === 'set') { info.setAmt = cand.setAmt || 0; info.setNeed = cand.setNeed || 0; if (cand.buildingRef) info.building = cand.buildingRef.name; }
    return info;
  }

  // 第1目標（効率1位）と第2目標（その間に実際に買うもの。貯金中は null）の表示状態をそろえる
  // ===== 購入リストの再生と学習（v2.3.41、ユーザー提案＋ChatGPTレビュー） =====
  // 各周回で実際に買ったものを doBuy の成功地点で記録し、自動昇天の完了時に
  // 「正常に終わった周回の実績」を次回の再生リストとして採用する（学習）。
  // 次の周回では序盤にそのリストを検証なしで最速再生し、使い切るか詰まったら
  // 通常の評価＋検証つき購入に戻る。救済購入で買った品は採用から外す。
  var runRecord = null; // {run, startedAt, events:[], dirty, overflow, tainted}
  var replayMem = { waitIdx: -1, waitSince: 0, retryIdx: -1, retries: 0 };
  var replayStateCache = null;
  var replayListCache = undefined; // undefined = 未読込
  function recordEnsure() {
    var G = W.Game; if (!G) return null;
    var runNo = (G.resets || 0) + 1;
    if (runRecord && runRecord.run === runNo) return runRecord;
    var saved = null;
    try { saved = gmGet('ccauto_runRecord', null); } catch (e) { saved = null; }
    if (saved && saved.run === runNo && Array.isArray(saved.events)) {
      runRecord = saved;
    } else {
      runRecord = { run: runNo, startedAt: Date.now(), events: [], dirty: 0, overflow: false, tainted: false };
    }
    return runRecord;
  }
  function recordFlush() {
    if (!runRecord) return;
    try { gmSet('ccauto_runRecord', runRecord); runRecord.dirty = 0; } catch (e) { /* ignore */ }
  }
  function recordEvent(ev) {
    try {
      var rec = recordEnsure(); if (!rec) return;
      if (rec.overflow) return;
      if (rec.events.length >= 1000) { rec.overflow = true; recordFlush(); return; }
      ev.t = Math.max(0, Math.round((Date.now() - (rec.startedAt || Date.now())) / 1000));
      rec.events.push(ev);
      rec.dirty = (rec.dirty || 0) + 1;
      if (rec.dirty >= 10) recordFlush();
    } catch (e) { /* ignore */ }
  }
  function replayGetList() {
    if (replayListCache !== undefined) return replayListCache;
    var l = null;
    try { l = gmGet('ccauto_replayList', null); } catch (e) { l = null; }
    replayListCache = l;
    return l;
  }
  function replayLoadState(runNo) {
    if (replayStateCache && replayStateCache.run === runNo) return replayStateCache;
    var st = null;
    try { st = gmGet('ccauto_replayState', null); } catch (e) { st = null; }
    if (!st || st.run !== runNo || typeof st.idx !== 'number') st = { run: runNo, idx: 0, done: false, abort: '' };
    replayStateCache = st;
    return st;
  }
  function replaySaveState(st) {
    replayStateCache = st;
    try { gmSet('ccauto_replayState', st); } catch (e) { /* ignore */ }
  }
  function replayAbort(st, reason) {
    st.done = true; st.abort = reason;
    replaySaveState(st);
    state.replayInfo = null;
    log('購入リストの再生を終了します（' + reason + '）。通常の購入に切り替えます');
    try { traceEvent('replay-abort'); } catch (e) { /* ignore */ }
    evalCache = null;
    return 'off';
  }
  // 戻り値: 'active' = 再生がこの回を担当（購入した/待っている）/ 'off' = 通常購入へ
  function replayStep() {
    var G = W.Game; if (!G) return 'off';
    var runNo = (G.resets || 0) + 1;
    var list = replayGetList();
    if (!list || !Array.isArray(list.events) || !list.events.length) { state.replayInfo = null; return 'off'; }
    var st = replayLoadState(runNo);
    if (st.done) { state.replayInfo = null; return 'off'; }
    var events = list.events;
    // 既に満たした項目を飛ばす（再読み込みをまたいでも冪等に再開できる）
    var idxBefore = st.idx;
    while (st.idx < events.length) {
      var e0 = events[st.idx];
      if (e0.k === 'u') {
        var u0 = findUpgrade(G, e0.name);
        if (u0 && u0.bought) { st.idx++; continue; }
      } else if (e0.k === 'b') {
        var b0 = G.Objects[e0.name];
        if (b0 && (b0.amount || 0) >= (e0.target || 0)) { st.idx++; continue; }
      }
      break;
    }
    if (st.idx !== idxBefore) replaySaveState(st);
    if (st.idx >= events.length) {
      st.done = true; replaySaveState(st);
      state.replayInfo = null;
      log('購入リストの再生が完了しました（' + events.length + ' 件）。通常の購入に切り替えます');
      try { traceEvent('replay-done'); } catch (e) { /* ignore */ }
      evalCache = null;
      return 'off';
    }
    var ev = events[st.idx];
    var bank = G.cookies || 0;
    var price = 0;
    if (ev.k === 'b') {
      var b = G.Objects[ev.name];
      if (!b) return replayAbort(st, '記録の建物が見つかりません: ' + ev.name);
      var need = (ev.target || 0) - (b.amount || 0);
      if (need <= 0) { st.idx++; replaySaveState(st); return 'active'; }
      var labelB = ev.name + ' ×' + Math.min(need, 100);
      state.replayInfo = { idx: st.idx, total: events.length, label: labelB };
      state.actualNext = { label: labelB, price: Math.round(buildingPrice(b)), kind: 'building', mode: 'candidate' };
      if (G.recalculateGains) { buyDelayHint = 150; return 'active'; }
      var unit = buildingPrice(b);
      var capQ = Math.min(need, 100);
      var lo = 0, hi = capQ;
      while (lo < hi) { var mid = Math.ceil((lo + hi) / 2); if (sumPriceFor(b, unit, mid) <= bank) lo = mid; else hi = mid - 1; }
      if (lo > 0) {
        replayMem.waitIdx = -1; replayMem.waitSince = 0;
        var bankB = bank, amtB = b.amount || 0;
        var got = buyBuildingUnits(b, lo);
        if (got > 0) {
          recordEvent({ k: 'b', name: ev.name, qty: got, target: (b.amount || 0), src: 'replay' });
          log('購入: ' + ev.name + (got > 1 ? ' ×' + got : '') + '（' + fmt(Math.max(0, bankB - (G.cookies || 0))) + '）');
          if ((b.amount || 0) >= (ev.target || 0)) { st.idx++; replaySaveState(st); }
          buyDelayHint = CONFIG.buyRestMs;
          return 'active';
        }
        if ((b.amount || 0) !== amtB || (G.cookies || 0) !== bankB) return replayAbort(st, '購入の反映が想定と違いました: ' + ev.name);
        if (replayMem.retryIdx === st.idx && replayMem.retries >= 1) return replayAbort(st, '購入が反映されませんでした: ' + ev.name);
        replayMem.retryIdx = st.idx; replayMem.retries++;
        buyDelayHint = 300;
        return 'active';
      }
      price = sumPriceFor(b, unit, 1); // 1軒分でも買える見込みで待つか判断する
    } else {
      var up = findUpgrade(G, ev.name);
      if (!up) return replayAbort(st, '記録のアップグレードが見つかりません: ' + ev.name);
      if (up.bought) { st.idx++; replaySaveState(st); return 'active'; }
      // 禁止・対象外チェック（記録は通常購入の実績なので通常は該当しない。二重の安全弁）
      var pool = '';
      try { pool = up.pool || ''; } catch (e) { pool = ''; }
      if (isBlockedUpgrade(up) || pool === 'toggle' || pool === 'tech' || pool === 'prestige' || pool === 'debug' || up.buildingTie2 || /egg/i.test(up.name || '')) {
        return replayAbort(st, '対象外の品が記録にありました: ' + ev.name);
      }
      try { price = up.getPrice(); } catch (e) { price = 0; }
      state.replayInfo = { idx: st.idx, total: events.length, label: ev.name };
      state.actualNext = { label: ev.name, price: Math.round(price || 0), kind: 'upgrade', mode: 'candidate' };
      if (G.recalculateGains) { buyDelayHint = 150; return 'active'; }
      var inStore = false;
      try { var sa = G.UpgradesInStore || []; for (var si = 0; si < sa.length; si++) if (sa[si] === up) { inStore = true; break; } } catch (e) { inStore = false; }
      if (inStore && price > 0 && bank >= price) {
        replayMem.waitIdx = -1; replayMem.waitSince = 0;
        var bankU = bank;
        try { up.buy(); } catch (e) { /* ignore */ }
        if (up.bought) {
          recordEvent({ k: 'u', name: ev.name, src: 'replay' });
          log('購入: ' + ev.name + '（' + fmt(Math.max(0, bankU - (G.cookies || 0))) + '）');
          st.idx++; replaySaveState(st);
          buyDelayHint = CONFIG.buyRestMs;
          return 'active';
        }
        if ((G.cookies || 0) !== bankU) return replayAbort(st, '購入の反映が想定と違いました: ' + ev.name);
        if (replayMem.retryIdx === st.idx && replayMem.retries >= 1) return replayAbort(st, '購入が反映されませんでした: ' + ev.name);
        replayMem.retryIdx = st.idx; replayMem.retries++;
        buyDelayHint = 300;
        return 'active';
      }
      if (!inStore) {
        // 店頭に無い: 短時間だけ待ち、それでも出なければ通常購入へ
        if (replayMem.waitIdx !== st.idx) { replayMem.waitIdx = st.idx; replayMem.waitSince = Date.now(); }
        if (Date.now() - replayMem.waitSince > 2000) return replayAbort(st, '店頭に出ていない品がありました: ' + ev.name);
        buyDelayHint = 250;
        return 'active';
      }
      if (!(price > 0)) return replayAbort(st, '価格が読めませんでした: ' + ev.name);
    }
    // 資金待ち（建物・アップグレード共通）: 見込み時間が短いときだけ待つ
    if (replayMem.waitIdx !== st.idx) { replayMem.waitIdx = st.idx; replayMem.waitSince = Date.now(); }
    var income = 0;
    try { income = totalIncome(baseCps()); } catch (e) { income = 0; }
    var eta = (income > 0 && isFinite(income)) ? (price - bank) / income : Infinity;
    if (!(eta <= 10) || Date.now() - replayMem.waitSince > 60000) {
      return replayAbort(st, '買える見込みが遠い品がありました: ' + ev.name);
    }
    buyDelayHint = 250;
    return 'active';
  }

  function setGoals(top, second, active, saving, bank, inc) {
    state.goal1 = goalInfo(top, bank, inc);
    state.goal2 = goalInfo(second, bank, inc);
    state.goalActive = active;
    state.goalSaving = !!saving;
    if (state.goal1) state.goal1.active = active === 1;
    if (state.goal2) state.goal2.active = active === 2;
  }

  function setSaveTarget(top, cpsNow, saving) {
    var inc = totalIncome(cpsNow);
    var bank = W.Game.cookies;
    state.nextTarget = top.label;
    state.nextDetail = (saving ? '貯金中、あと ' : '目標、あと ') + fmt(top.price - bank) +
      (inc > 0 ? '、' + fmtDur((top.price - bank) / inc) : '');
    state.targetPrice = top.price;
  }

  // 評価の再利用とイベント駆動購入（v2.3.22、ChatGPT相談「購入プラン拡張・高速化」）:
  // 全候補の再計算シミュレーションは最も重い処理のため、全面評価は前回から evalIntervalMs 以上空ける。
  // その間は前回の評価を使い回し、購入と検証は間隔を空けずに回す（buyStep の戻り値が次の実行までの待ちを決める）。
  // キャッシュが無効になる条件: バフ変化・実績変化・新品目の解禁（店頭の品揃え変化）・アップグレード購入（相乗効果が変わる）。
  // 建物の購入では捨てない（買った建物の価格だけ、その場で実価格に直して使い続ける）。古すぎる評価（30秒超）も捨て直す。
  var evalCache = null;
  var lastEvalAt = 0;
  var evalWaitMs = 0;
  // 負荷の計測（v2.3.36、ChatGPTレビューに基づく）: 1分ごとの集計だけを payload に載せ、
  // 「どの経路に何msの最大値が出たか」でカクつきの原因を切り分ける。collectStatus で読み取り＆リセット。
  var perf = { evalCount: 0, evalMs: 0, evalMaxMs: 0, clickMs: 0, clickTicks: 0, longFrames: 0, maxFrameMs: 0 };
  var frameLastT = 0;
  function frameWatch(t) {
    if (frameLastT) {
      var d = t - frameLastT;
      if (d < 1000) { // 1000ms超はタブ非表示などによる停止として数えない
        if (d > 100) perf.longFrames++;
        if (d > perf.maxFrameMs) perf.maxFrameMs = Math.round(d);
      }
    }
    frameLastT = t;
    try { requestAnimationFrame(frameWatch); } catch (e) { /* ignore */ }
  }
  function evalSignature() {
    var G = W.Game;
    var storeN = -1;
    try { storeN = G.UpgradesInStore ? G.UpgradesInStore.length : -1; } catch (e) { /* ignore */ }
    return buffSignature() + '|' + achievementsWon() + '|' + storeN;
  }
  // 序盤スプリント（v2.3.40、ChatGPTレビュー）: 立て直しの間だけ全面評価の最小間隔を
  // 2秒→1秒に縮める。検証は1件ずつのまま変えない。条件を1つでも欠いたら通常間隔に戻る。
  // 起点は ccauto_runCurrent.startedAt（主タブとして立て直しを始めた時刻）で、
  // ページの再読み込みでは作り直さない（runCurrent は GM に残る）。
  var SPRINT_EVAL_MS = 1000;
  var SPRINT_WINDOW_MS = 180000; // 初期値（実測で調整する）
  function sprintActive() {
    try {
      if (!tabState.primary) return false;
      if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return false;
      if (gmGet('ccauto_shopBuy', '1') !== '1') return false;
      if (buffSignature() !== '') return false;
      if (state.goalSaving) return false;
      var rc = null;
      try { rc = gmGet('ccauto_runCurrent', null); } catch (e) { rc = null; }
      if (!rc || typeof rc.startedAt !== 'number' || typeof rc.run !== 'number') return false;
      var G = W.Game;
      if (!G || (G.resets || 0) !== rc.run - 1) return false; // 周回がずれていたら対象外
      var now = Date.now();
      if (now - rc.startedAt < 0 || now - rc.startedAt > SPRINT_WINDOW_MS) return false;
      // 第1候補が「素のCpSの2秒分」以下の間だけ（前回評価の先頭で判定。セットは総額が読みにくいので対象外）
      if (evalCache && evalCache.ev && evalCache.ev.list && evalCache.ev.list.length) {
        var top = evalCache.ev.list[0];
        if (!top || top.kind === 'set') return false;
        var bc = baseCps();
        if (!(bc > 0) || !(top.price <= 2 * bc)) return false;
      }
      return true;
    } catch (e) { return false; }
  }
  function getEvaluation() {
    var now = Date.now();
    if (evalCache && (now - evalCache.at) < 30000 && evalCache.sig === evalSignature()) {
      evalWaitMs = 0;
      return evalCache.ev;
    }
    var intervalMs = sprintActive() ? SPRINT_EVAL_MS : CONFIG.evalIntervalMs;
    if (lastEvalAt && (now - lastEvalAt) < intervalMs) {
      evalWaitMs = intervalMs - (now - lastEvalAt);
      return null; // 全面評価の間隔がまだ空いていない。今回は買わずに待つ
    }
    lastEvalAt = now;
    var evT0 = performance.now();
    var ev = evaluateCandidates();
    var evMs = performance.now() - evT0;
    perf.evalCount++; perf.evalMs += evMs; if (evMs > perf.evalMaxMs) perf.evalMaxMs = evMs;
    evalCache = { at: now, ev: ev, sig: evalSignature() };
    evalWaitMs = 0;
    return ev;
  }

  // イベント駆動チェーン（v2.3.22）: buyStep は「次の実行までの待ち時間（ミリ秒）」を返す。
  // 購入できるときは検証が閉じ次第すぐ次へ進み、貯金中は買える見込みまでの時間を眠る。
  var buyDelayHint = 1000;
  // 店頭滞留の少額アップグレード救済（v2.3.38、ChatGPTレビューに基づく案4）。
  // 実測が無効化され続ける品や、順序比較で後回しにされ続ける品が、価格の割に
  // 大きな効果を持ったまま残る事故（29周目の Lindworms 等）への最後の受け皿。
  // 見なし増産で回収順位には混ぜず、条件を満たした品を通常の購入経路で1件だけ買う。
  var storePresence = {}; // name -> {since, price}（店頭に初めて見えた時刻）
  var rescueLastAt = 0;
  var rescueSpend = []; // {at, price}（直近1時間の救済支出）
  var rescueCount = 0; // 送信周期ごとの救済購入件数（collectStatus が読み取ってリセット）
  var rescueLastLabel = '';
  function updateStorePresence() {
    try {
      var store = W.Game.UpgradesInStore || [];
      var seen = {};
      for (var i = 0; i < store.length; i++) {
        var up = store[i];
        if (!up || up.bought) continue;
        seen[up.name] = true;
        var price = (typeof up.getPrice === 'function') ? up.getPrice() : up.basePrice;
        var p = storePresence[up.name];
        if (!p) storePresence[up.name] = { since: Date.now(), price: price };
        else p.price = price;
      }
      for (var n in storePresence) if (!seen[n]) delete storePresence[n];
    } catch (e) { /* ignore */ }
  }
  function rescueEligible(up, cpsNow) {
    if (!up || up.bought) return false;
    if (isBlockedUpgrade(up)) return false; // 研究・One Mind 等の禁止リストは候補評価と同じ
    var pool = '';
    try { pool = up.pool || ''; } catch (e) { pool = ''; }
    if (pool === 'tech' || pool === 'toggle' || pool === 'prestige' || pool === 'debug') return false;
    if (up.buildingTie2) return false; // シナジーは候補評価でも対象外
    var nm = (up.name || '').toLowerCase();
    if (/egg/.test(nm)) return false;
    if (GC_BOOSTER_NAMES.indexOf(nm) >= 0) return false; // 専用の見なし評価で候補に入る
    var tie = null;
    try { tie = up.buildingTie1 || null; } catch (e) { tie = null; }
    if (tie) {
      if (typeof up.tier !== 'number') return false; // ティア（×2）強化だけ
      if (!((tie.amount || 0) > 0)) return false; // 建物が0軒では効かない
    } else {
      if (!isGlobalAdmissible(up)) return false;
      // 正常に測れて増産ゼロだった品は、割引効果も無い場合だけ「効果なし」として救済しない
      var c = upGainCache[up.name];
      if (c && !(c.dcps > 0) && !(c.dclick > 0) && !(discountValue(up, cpsNow) > 0)) return false;
    }
    return true;
  }
  function tryRescueBuy(ev) {
    try {
      if (anyBuffActive()) return false; // バフ中は通常評価が止まるだけなので救済しない
      var now = Date.now();
      if (now - rescueLastAt < 60000) return false; // 1分に1件まで
      var G = W.Game;
      var bank = G.cookies;
      var income = totalIncome(ev.cpsNow);
      if (!(income > 0) || !(bank > 0)) return false;
      rescueSpend = rescueSpend.filter(function (s) { return now - s.at < 3600000; });
      var spentSum = 0;
      for (var si = 0; si < rescueSpend.length; si++) spentSum += rescueSpend[si].price;
      if (spentSum >= income * 10) return false; // 1時間の救済支出は収入の10秒分まで
      var store = G.UpgradesInStore || [];
      for (var i = 0; i < store.length; i++) {
        var up = store[i];
        if (!up || up.bought) continue;
        var pres = storePresence[up.name];
        if (!pres || now - pres.since < 120000) continue; // 店頭に2分以上残っている
        if (!rescueEligible(up, ev.cpsNow)) continue;
        var price = (typeof up.getPrice === 'function') ? up.getPrice() : up.basePrice;
        if (!(price > 0) || price > bank) continue;
        if (price > income) continue; // 収入の1秒分以下
        if (price > bank * 0.001) continue; // 残高の0.1%以下
        if (spentSum + price > income * 10) continue;
        var cand = { kind: 'upgrade', ref: up, label: up.name, price: price, gain: 0, payback: Infinity, noVerify: true, __src: 'rescue' };
        var n = doBuy(cand, true);
        if (n) {
          rescueLastAt = now;
          rescueSpend.push({ at: now, price: price });
          rescueCount++;
          rescueLastLabel = up.name;
          delete storePresence[up.name];
          evalCache = null; // アップグレード購入後は評価を作り直す（通常購入と同じ）
          log('購入: ' + up.name + '（' + fmt(price) + '）');
          log('救済メモ: ' + up.name + ' は店頭に長く残っていた少額品のため購入しました');
          return true;
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function buyStep() {
    buyDelayHint = 1000;
    try { buyStepInner(); } catch (e) { /* チェーンを止めない */ }
    return buyDelayHint;
  }
  function buyStepInner() {
    if (!tabState.primary) return; // 二重タブ防止: 従タブは購入しない
    if (!state.running || state.mode !== 'auto') return;
    if (!gameReady() || isChallengePage()) return;
    if (ascendBusy()) return; // 自動昇天の実行中は通常の購入を止める
    // 検証の前に、ゲーム本体の再計算が終わっていることを確認する（v2.3.21、ChatGPT相談）。
    // 再計算フラグが立っている間は測定がぶれるため、短時間だけ検証を持ち越す。
    // 4秒待っても終わらなければ判定せずに記録を閉じる（購入は止めない）。
    if (state.pendingVerify) {
      if (!state.pendingVerify.at) state.pendingVerify.at = Date.now();
      var recalcOn = false;
      try { recalcOn = !!W.Game.recalculateGains; } catch (e) { recalcOn = false; } // v2.3.29: 真偽値で立つ経路も拾う
      if (recalcOn) {
        if (Date.now() - state.pendingVerify.at < 4000) { buyDelayHint = 75; requestRender(); return; }
        log('検証メモ: ' + state.pendingVerify.label + ' は再計算が終わらないため判定しませんでした');
        state.pendingVerify = null;
        gmSet('ccauto_pendingVerify', '');
        state.anomalies = 0;
      }
    }
    // 前回購入の実測検証（ゲーム側の再計算が済んだこのタイミングで照合する）
    if (state.pendingVerify) {
      var pv = state.pendingVerify;
      // 検証の物差しは購入時点で固定する: クリック増分の換算には購入時の実測速度 (rateAtBuy) を使い、
      // 予測側も内訳 (predCps/predClick) があれば同じ速度で組み立て直す。検証時点の速度で測り直すと
      // 端末負荷などの変動だけで乖離が出る（v2.2.8: ChatGPT相談に基づく PASS/FAIL/SKIP 分類方式）
      var rateV = (pv && isFinite(pv.rateAtBuy) && pv.rateAtBuy > 0) ? pv.rateAtBuy : 0;
      // 建物・セットの予測は生産（CpS）分のみで、クリック値の増分は含まない。検証でもクリック分を
      // 足すと、買うたびに「実測が約5倍」で誤判定になるため、建物系は CpS 分だけで比べる (v2.2.9)
      var isBuildingKind = pv && (pv.kind === 'building' || pv.kind === 'set');
      var measured = null;
      var measParts = null;
      try {
        var prodNow = readProduction();
        var dCpsPart = prodNow.cps - pv.cpsBefore;
        var dClickPart = isBuildingKind ? 0 : Math.max(0, prodNow.click - (pv.clickBefore || 0)) * (rateV > 0 ? rateV : measuredClickRate());
        measured = dCpsPart + dClickPart;
        measParts = { dCps: dCpsPart, dClick: dClickPart };
      } catch (e) { measured = null; }
      // 検証の計算が最後まで済んでから記録を消す（途中で例外が出たら未検証として停止する）
      state.pendingVerify = null;
      gmSet('ccauto_pendingVerify', '');
      if (measured === null) {
        reportError('購入後の検証でエラーが出ました（購入は継続します）');
      } else if (pv.gain > 0) {
        // 予測値: 内訳があれば購入時速度で組み立て直したもの、なければ購入時に使った gain そのもの
        var predV = pv.gain;
        if (typeof pv.predCps === 'number' && typeof pv.predClick === 'number' && (rateV > 0 || isBuildingKind)) {
          if (isBuildingKind) {
            // 建物・セットは予測も CpS 分のみで比べる（クリック速度に依存しない）
            predV = pv.predCps;
          } else if (rateV > 0) {
            // アップグレード: クリック値の増分は「CpS増分 × 購入時のクリック比率」でも必ず発生する
            // （クリック値が CpS 連動のため）。シミュレーションの dclick が取りこぼす場合に備え、
            // 解析的に求まる分を下限として予測のクリック分に使う（v2.3.5）
            var predClickEff = pv.predClick;
            if (pv.predCps > 0 && pv.cpsBefore > 0) {
              var analyticClick = (pv.clickBefore || 0) / pv.cpsBefore * pv.predCps;
              if (analyticClick > predClickEff) predClickEff = analyticClick;
            }
            predV = pv.predCps + predClickEff * rateV;
          }
        }
        // 購入と検証のあいだにゴールデンクッキー等の効果が始まった/終わった場合は、測定が信用できないため判定しない
        var buffChanged = pv.buffs != null && buffSignature() !== pv.buffs;
        // クリック系バフ（Click frenzy 等）が購入時・検証時のどちらかに掛かっていたら、クリック値の実測が大きく振れるため判定しない
        if (/click/i.test(pv.buffs || '') || /click/i.test(buffSignature() || '')) buffChanged = true;
        // 実績の増減は比較条件の変化として扱う（増加=ミルク経由の伸びが予測に入らない、減少=状態変化）。判定はせず数値をメモに残す
        var achNowV = null;
        try { achNowV = achievementsWon(); } catch (eA) { achNowV = null; }
        var achChanged = pv.achBefore != null && achNowV != null && achNowV !== pv.achBefore;
        // パンテオンの配置が購入と検証の間に変わっていたら、効果の増減が混ざるため比較条件の変化として扱う（v2.3.30）
        var pantheonChanged = pv.pantheon != null && pantheonSignature() !== pv.pantheon;
        // 予測自体が購入前の総生産の3倍を超える場合は、測定条件が崩れた値なので判定しない（記録のみ）
        var predictionInvalid = pv.cpsBefore > 0 && predV > pv.cpsBefore * 3;
        var partsTxt = measParts ? (isBuildingKind ? '［CpS分 ' + fmt(Math.round(measParts.dCps)) + '］' : '［CpS分 ' + fmt(Math.round(measParts.dCps)) + '、クリック分 ' + fmt(Math.round(measParts.dClick)) + '］') : '';
        if (typeof pv.predCps === 'number' && typeof pv.predClick === 'number') {
          partsTxt += '［予測内訳 CpS ' + fmt(Math.round(pv.predCps)) + '、クリック ' + fmt(Math.round(pv.predClick)) + '］';
        }
        if (rateV <= 0 && !(isBuildingKind && typeof pv.predCps === 'number')) {
          // 購入時速度が記録されていない（旧版からの持ち越し等）場合は判定せず、数値だけ残す
          log('検証メモ: ' + pv.label + ' は購入時のクリック速度が無いため判定しませんでした（予測 ' + fmt(Math.round(predV)) + ' → 実測 ' + fmt(Math.round(measured)) + partsTxt + '）');
          state.anomalies = 0;
        } else if (predictionInvalid) {
          log('検証メモ: ' + pv.label + ' の予測が大きすぎるため判定しませんでした');
          state.anomalies = 0;
        } else if (pv.partial) {
          log('検証メモ: ' + pv.label + ' は予定個数未満のまとめ買いのため判定しませんでした（予測 ' + fmt(Math.round(predV)) + ' → 実測 ' + fmt(Math.round(measured)) + partsTxt + '）');
          state.anomalies = 0;
        } else if (buffChanged || achChanged || pantheonChanged) {
          log('検証メモ: ' + pv.label + ' は比較条件の変化（' + (buffChanged ? 'バフ変化' : (pantheonChanged ? 'パンテオン変化' : '実績変化')) + '）のため判定しませんでした（予測 ' + fmt(Math.round(predV)) + ' → 実測 ' + fmt(Math.round(measured)) + partsTxt + '）');
          state.anomalies = 0;
        } else {
          var tooLow = measured < predV * 0.5;
          // 増えすぎ側は、予測に入らない相乗効果などで普通に起こるため、本当に極端な場合だけ報告する
          var tooHigh = measured > predV * 3 + pv.cpsBefore * 0.05;
          if (tooLow || tooHigh) {
            state.anomalies = (state.anomalies || 0) + 1;
            reportError('購入後の増産が予測と大きく違います（' + pv.label + '、予測 ' + fmt(Math.round(predV)) + ' → 実測 ' + fmt(Math.round(measured)) + partsTxt + '、購入は継続します）');
          } else {
            // エラーにはしないが、±25%を超えるずれは診断用に残す
            if (Math.abs(measured - predV) > predV * 0.25) {
              log('検証メモ: ' + pv.label + ' の増産が予測とややずれました（予測 ' + fmt(Math.round(predV)) + ' → 実測 ' + fmt(Math.round(measured)) + partsTxt + '）');
            }
            state.anomalies = 0;
          }
        }
      } else {
        state.anomalies = 0;
      }
    }
    if (state.halted) { renderPanel(); return; }
    // v2.3.39: ショップ購入OFFの間は、購入も候補評価も店頭滞留の観測も止める
    // （前回購入の検証は上の処理で通常どおり済ませる。クリック等は別の経路で継続）
    if (gmGet('ccauto_shopBuy', '1') !== '1') { requestRender(); return; }
    // v2.3.41: 前回の購入リストの再生（検証なし・最速）。再生が担当する間は通常購入に入らない
    if (replayStep() === 'active') { requestRender(); return; }
    updateStorePresence(); // v2.3.38: 店頭滞留の記録（救済購入の判定材料）
    var G = W.Game;
    var boughtCounts = {};
    var boughtTotal = 0;
    // 1回の判断で、回収効率を毎回判定し直しながら最大 maxBatch 個までまとめ買いする
    for (var step = 0; step < CONFIG.maxBatch; step++) {
      var ev = getEvaluation();
      if (!ev) { buyDelayHint = Math.max(60, evalWaitMs || 200); break; } // 全面評価の間隔待ち。空転せず眠る
      if (state.halted) break; // 評価中に異常停止が立ったら、その回の候補では買わない
      if (!ev.list.length) break;
      var bank = G.cookies;
      var top = ev.list[0];
      var pick = null;
      if (top.price <= bank) {
        pick = top; // 効率1位が買えるなら、それを買う
      } else {
        // 効率1位Aが買えない間は、買える候補Bそれぞれについて「A→B」と「B→A」の
        // 両方が揃うまでの時間を比べ、Bを先に買う方が速い場合だけBを買う。
        // それ以外はAのために貯金する（固定の貯金時間ルールは v2.0 で廃止）
        var R = totalIncome(ev.cpsNow);
        var bestB = null, bestTBA = Infinity;
        // watchB: 順序比較で「次に割り込む可能性が最も高い」買える候補。貯金中でも表示して、実際に何を買うつもりかを見えるようにする
        var watchB = null, watchTBA = Infinity;
        if (R > 0 && top.gain > 0) {
          var tA = (top.price - bank) / R;
          for (var ci = 1; ci < ev.list.length; ci++) {
            var B = ev.list[ci];
            if (B.price > bank || !(B.gain > 0)) continue;
            // Aがセットの場合、その建物を買うことはセット自体を進めることなので常に対象にする
            if (top.kind === 'set' && B.kind === 'building' && top.buildingRef && B.ref === top.buildingRef) { bestB = B; bestTBA = 0; break; }
            var tAB = tA + B.price / (R + top.gain); // Aを買った直後の残高は0として計算する
            var tBA = (top.price - (bank - B.price)) / (R + B.gain);
            if (tBA < watchTBA) { watchB = B; watchTBA = tBA; }
            if (tBA < tAB && tBA < bestTBA) { bestB = B; bestTBA = tBA; }
          }
        }
        if (bestB) {
          pick = bestB;
        } else {
          // 貯金中でも「実際に次に買う可能性があるもの」を状態に残す（買える候補が無いときは null = 本当に貯金だけ）
          state.actualNext = watchB ? { label: watchB.label, price: Math.round(watchB.price), kind: watchB.kind, mode: 'candidate' } : null;
          if (boughtTotal === 0) { setSaveTarget(top, ev.cpsNow, true); state.goalTarget = ''; state.goalDetail = ''; setGoals(top, null, 1, true, bank, totalIncome(ev.cpsNow)); }
          // v2.3.38: 貯金で手が空く間、店頭に長く残った少額アップグレードを1件だけ救済購入する
          if (tryRescueBuy(ev)) { buyDelayHint = CONFIG.buyRestMs; break; }
          // 貯金中は「買える見込みまで」の時間を眠る（上限2秒。下限150ミリ秒）。収入が上振れしても2秒以内に追従できる
          buyDelayHint = (R > 0 && top.price > bank) ? Math.max(150, Math.min(2000, Math.round((top.price - bank) / R * 1000))) : 1000;
          break;
        }
      }
      // 実際に次に買うもの（目標そのものか、目標より先に買う合間の品か）を状態に残す
      state.actualNext = (pick === top)
        ? { label: top.label, price: Math.round(top.price), kind: top.kind, mode: 'goal' }
        : { label: pick.label, price: Math.round(pick.price), kind: pick.kind, mode: 'interim' };
      state.nextTarget = pick.label;
      state.nextDetail = (pick.kind === 'set') ? '倍強化まで買い進め中' : '';
      state.targetPrice = 0;
      // 効率1位が別のものなら、「目標」として分けて表示する
      if (top.label !== pick.label) {
        var incP = totalIncome(ev.cpsNow);
        state.goalTarget = top.label;
        state.goalDetail = 'あと ' + fmt(top.price - bank) + (incP > 0 ? '、' + fmtDur((top.price - bank) / incP) : '');
      } else { state.goalTarget = ''; state.goalDetail = ''; }
      // 第1目標・第2目標の表示状態もそろえる
      var incG = totalIncome(ev.cpsNow);
      if (pick === top) setGoals(top, ev.list[1] || null, 1, false, bank, incG);
      else setGoals(top, pick, 2, false, bank, incG);
      var bankB = G.cookies;
      var buyCand = pick;
      var countKey = pick.label;
      if (pick.kind === 'set') {
        var bRef = pick.buildingRef;
        buyCand = { kind: 'building', ref: bRef, label: bRef.name, price: buildingPrice(bRef), gain: buildingGainOf(bRef, ev.cpsNow, ev.gMult || 1, ev.clickBoost || 1) };
        countKey = bRef.name;
      } else if (pick.kind === 'building') {
        countKey = pick.ref.name;
      }
      // まとめ買い（v2.3.17）: 建物は条件が合えば ×100 / ×10 で一気に買う。
      // 対象は「効率1位の建物がそのまま買える場合」と「セット目標の買い進め」だけ。
      // 順序比較で割り込む合間の候補は、Aを買うタイミングの計算がずれるため従来通り1個ずつ
      if (buyCand.kind === 'building') {
        var bQty = 1;
        if (pick.kind === 'set') {
          bQty = bulkQtyFor(buyCand.ref, buyCand.price, 0, Infinity, (pick.setNeed || 0) - (buyCand.ref.amount || 0), bank);
        } else if (pick === top) {
          var nbPay = (ev.list.length > 1 && ev.list[1]) ? ev.list[1].payback : Infinity;
          bQty = bulkQtyFor(buyCand.ref, buyCand.price, pick.payback, nbPay, 0, bank);
        } else if (top.kind === 'set' && top.buildingRef && pick.ref === top.buildingRef) {
          bQty = bulkQtyFor(buyCand.ref, buyCand.price, 0, Infinity, (top.setNeed || 0) - (buyCand.ref.amount || 0), bank);
        }
        if (bQty > 1) {
          var unitPriceB = buyCand.price;
          buyCand = { kind: 'building', ref: buyCand.ref, label: buyCand.label, gain: buyCand.gain, payback: buyCand.payback, qty: bQty, price: sumPriceFor(buyCand.ref, unitPriceB, bQty) };
        }
      }
      var boughtN = doBuy(buyCand, true);
      if (!boughtN) break;
      if (buyCand.kind === 'upgrade') {
        evalCache = null; // アップグレード購入は相乗効果や解禁が変わるため評価を捨て直す
      } else if (evalCache && buyCand.ref) {
        // 建物購入では評価を使い回し、買った建物の価格だけ実価格に直す（v2.3.22）
        try {
          for (var ei = 0; ei < evalCache.ev.list.length; ei++) {
            var ent = evalCache.ev.list[ei];
            if (ent.kind === 'building' && ent.ref === buyCand.ref) ent.price = buildingPrice(buyCand.ref);
          }
        } catch (e) { /* ignore */ }
      }
      // 第1目標とは違うものを買ったら「目標までの間に買ったもの」として残す（目標そのものを買ったら消す）
      if (pick.label !== top.label) {
        state.lastInterim = { label: (pick.kind === 'set' ? buyCand.label : pick.label), price: Math.round(buyCand.price), at: Date.now(), goal: top.label };
        try { gmSet('ccauto_lastInterim', state.lastInterim); } catch (e) { /* ignore */ }
      } else if (state.lastInterim) {
        state.lastInterim = null;
        try { gmSet('ccauto_lastInterim', ''); } catch (e) { /* ignore */ }
      }
      boughtTotal++;
      if (!boughtCounts[countKey]) boughtCounts[countKey] = { n: 0, spent: 0 };
      boughtCounts[countKey].n += boughtN;
      boughtCounts[countKey].spent += Math.max(0, bankB - G.cookies);
    }
    if (boughtTotal > 0) {
      var parts = [];
      for (var k in boughtCounts) {
        parts.push(k + (boughtCounts[k].n > 1 ? ' ×' + boughtCounts[k].n : '') + '（' + fmt(boughtCounts[k].spent) + '）');
      }
      log('購入: ' + parts.join(' / '));
      // v2.3.36: 購入ごとの即時送信はやめ、60秒周期の送信に載せる（ChatGPTレビュー）。
      // 購入直後は候補キャッシュが空で、送信の組み立てが全面評価を直呼びして
      // ロングタスク化するのがカクつきの主容疑だったため。昇天バックアップ等の送信は別経路で維持。
    }
    if (boughtTotal > 0) buyDelayHint = CONFIG.buyRestMs; // 買えた直後は短い休止だけ入れて次へ（検証は次サイクル冒頭で閉じる）
    requestRender();
  }

  /* ---------------- クリック ---------------- */

  function clickRate() {
    var v = parseFloat(gmGet('ccauto_clickRate', ''));
    if (isNaN(v)) v = CONFIG.clickPerSecond;
    if (v < 0) v = 0;
    if (v > 250) v = 250; // ゲーム側のクリック計数上限が約250/秒のため
    return v;
  }
  // クリックの時間予算（v2.3.36）: GMキーで切り替えて比較できるようにした（既定は従来どおり15ms）
  function clickBudgetMs() {
    var v = parseFloat(gmGet('ccauto_clickBudgetMs', ''));
    if (isNaN(v)) v = CONFIG.clickBudgetMs;
    if (v < 2) v = 2;
    if (v > 50) v = 50;
    return v;
  }
  // 画面クリック（数字ポップアップつき）の毎秒回数（v2.3.36）: GMキーで調整可能、既定は従来どおり4
  function visualCps() {
    var v = parseFloat(gmGet('ccauto_visualCps', ''));
    if (isNaN(v)) v = VISUAL_CLICKS_PER_SEC;
    if (v < 0) v = 0;
    if (v > 10) v = 10;
    return v;
  }

  var clickTimer = null;
  function scheduleClicks() {
    if (clickTimer) { clearInterval(clickTimer); clickTimer = null; }
    if (clickRate() <= 0) return;
    clickTimer = setInterval(clickStep, 15);
  }

  var clickAcc = 0;
  function mouseCps() {
    try { return W.Game.computedMouseCps || 0; } catch (e) { return 0; }
  }

  // 演出（粒子・高画質表示）は処理が重く実測のクリック速度を下げるためオフのままにする。
  // 浮かぶ数字だけは、クリック位置が画面で分かるようにオンにする（ユーザー指示 2026-11-14）。
  var lightPrefsApplied = false;
  function applyLightPrefs() {
    if (lightPrefsApplied) return;
    try {
      var p = W.Game.prefs;
      if (p) {
        var changed = [];
        if (p.particles) { p.particles = 0; changed.push('粒子オフ'); }
        if (!p.numbers) { p.numbers = 1; changed.push('数字オン'); }
        if (p.fancy) { p.fancy = 0; changed.push('高画質表示オフ'); }
        if (changed.length) log('表示設定を調整しました（' + changed.join('・') + '）');
      }
      lightPrefsApplied = true;
    } catch (e) { /* ignore */ }
  }

  // 画面左の大きなクッキーを、座標つきのマウスイベントで実際にクリックする。
  // APIを直接呼ぶ場合と違い、押した場所に数字ポップアップが出て、押下の見た目も本物どおりになる。
  // イベントが効いていないと見張りが検知したら、そのセッションはAPIクリックに戻す。
  var bigCookieEl = null;
  var domClickMode = true;
  // 画面クリックは1回ごとの描画が重く、全部を画面クリックにすると実測が数回/秒まで落ちた。
  // 数字つきで位置が見える画面クリックは毎秒数回だけにし、残りはAPIクリックで補う（ハイブリッド）
  var VISUAL_CLICKS_PER_SEC = 4;
  var visualAcc = 0;
  function clickBigCookie() {
    var G = W.Game;
    if (!domClickMode) { try { G.ClickCookie(); } catch (e) { /* ignore */ } return; }
    try {
      if (!bigCookieEl || !bigCookieEl.isConnected) bigCookieEl = document.getElementById('bigCookie');
      var el = bigCookieEl;
      if (el && typeof MouseEvent === 'function') {
        var r = el.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
          var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          var rad = Math.min(r.width, r.height) * 0.2; // 中心付近（半径の2割以内）を毎回少しずらす
          var opts = {
            bubbles: true, cancelable: true, view: window,
            clientX: cx + (Math.random() * 2 - 1) * rad,
            clientY: cy + (Math.random() * 2 - 1) * rad
          };
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
          return;
        }
      }
    } catch (e) { /* フォールバックへ */ }
    try { G.ClickCookie(); } catch (e2) { /* ignore */ }
  }

  var clickLastAt = 0;
  function clickStep() {
    if (!tabState.primary) return; // 二重タブ防止: 従タブはクリックしない
    if (!state.running) return;
    if (!gameReady() || isChallengePage()) return;
    if (ascendBusy()) return; // 自動昇天の実行中はクリックも止める
    var r = clickRate();
    if (r <= 0) return;
    applyLightPrefs();
    // 前回tickからの実経過時間ぶんを蓄積する（タイマーのブレや処理の遅れに追随させる）
    var now = Date.now();
    var elapsedMs = clickLastAt > 0 ? (now - clickLastAt) : 0;
    if (elapsedMs > 0) {
      clickAcc += r * elapsedMs / 1000;
      var vc = visualCps();
      visualAcc = Math.min(Math.max(2, vc * 2), visualAcc + vc * elapsedMs / 1000);
    }
    clickLastAt = now;
    if (clickAcc > r) clickAcc = r; // v2.3.36: 蓄積の上限はループに入る前に適用（長い停止後の初回tickで一気に叩かない）
    var n = Math.floor(clickAcc);
    if (n <= 0) return;
    // 1tickあたりの時間予算の中でまとめて叩く。予算を超えたら残りは次tickへ回し、
    // ゲーム本体（生産・描画・保存）の処理を飢えさせない。
    // v2.3.36: 予算チェックを4回ごと→毎回に変更し、上限を厳密にした（ChatGPTレビュー）
    var budget = clickBudgetMs();
    var t0 = performance.now();
    var done = 0;
    while (done < n) {
      try {
        // 一部だけ画面クリック（数字が見える）、残りはAPIで補って全体の速度を保つ
        if (visualAcc >= 1) { clickBigCookie(); visualAcc -= 1; }
        else { W.Game.ClickCookie(); }
      } catch (e) { break; }
      done++;
      if (performance.now() - t0 >= budget) break;
    }
    perf.clickMs += performance.now() - t0; perf.clickTicks++;
    clickAcc -= done;
    if (clickAcc > r) clickAcc = r; // 溜め込みは最大で設定値の1秒ぶんまで
    if (clickAcc < 0) clickAcc = 0;
  }

  // クリックの見張り: 再読み込みなどでタイマーが止まったままになっていたら張り直す
  var clickWatchLast = -1, clickWatchFlatAt = 0;
  function clickWatchdog() {
    if (!tabState.primary) { clickWatchLast = -1; clickWatchFlatAt = 0; return; } // 従タブはクリックしないのが正常
    if (!state.running || clickRate() <= 0) { clickWatchLast = -1; clickWatchFlatAt = 0; return; }
    if (!clickTimer) { scheduleClicks(); if (clickTimer) log('クリックのタイマーが止まっていたため再設定しました'); return; }
    if (!gameReady() || isChallengePage() || ascendBusy()) { clickWatchLast = -1; clickWatchFlatAt = 0; return; }
    var c = 0;
    try { c = W.Game.cookieClicks || 0; } catch (e) { return; }
    if (clickWatchLast >= 0 && c <= clickWatchLast) {
      if (!clickWatchFlatAt) clickWatchFlatAt = Date.now();
      if (Date.now() - clickWatchFlatAt >= 30000) {
        if (domClickMode) {
          domClickMode = false;
          log('画面クリックが効いていないため、APIクリックに戻しました');
        }
        clickAcc = 0; clickLastAt = 0;
        scheduleClicks();
        clickWatchFlatAt = 0;
        log('クリックが止まっていたため再設定しました');
      }
    } else {
      clickWatchFlatAt = 0;
    }
    clickWatchLast = c;
  }

  function goldenStep() {
    if (!tabState.primary) return; // 二重タブ防止: 従タブは触らない
    if (!state.running || !CONFIG.clickGolden) return;
    if (!gameReady() || isChallengePage()) return;
    if (ascendBusy()) return; // 自動昇天の実行中は黄金クッキーも触らない
    // ホロボア配置中・判定不能のときは黄金クッキーを触らない
    if (holoboreState() !== 'none') return;
    try {
      var shimmers = W.Game.shimmers || [];
      var gcTok = gcEventStart();
      for (var i = 0; i < shimmers.length; i++) {
        var s = shimmers[i];
        if (s.type === 'golden' && !s.wrath) {
          s.pop();
          log('黄金クッキーをクリック');
          setTimeout(function () {
            try {
              var names = Object.keys(W.Game.buffs || {});
              if (names.length) log('効果: ' + names.join(', '));
            } catch (e) { /* ignore */ }
          }, 500);
        }
      }
      if (gcTok) gcEventFinish(gcTok);
    } catch (e) { /* ignore */ }
  }

  /* ---------------- グリモア（運命の手）とパンテオン（v2.3.27） ----------------
     塔Lv1でグリモア、寺院Lv1でパンテオンが開く（レベルは昇天しても残る）。
     運命の手: Frenzy中に画面にクッキーが無く魔力が足りるときだけ撃ち、
     Click Frenzyとの重なりを狙う。出た憤怒は goldenStep が元々触らない。
     パンテオン: ダイヤ=Muridal（クリック強化）、ヒスイ=Mokalsium、ルビーは空。
     配置・付け替えで生産が変わるため、付け替え時は購入評価のキャッシュを捨てる。 */
  var spellState = { lastCastKey: '', lastAttempt: 0, pantheonAt: 0, lastSkip: '', lastCost: null };

  // 魔力の上限は mg.magicM（v2.3.29: ChatGPTが公開実装と照合して確定。
  // computeMagicM() は magicM を更新する関数で、戻り値は上限ではない）
  function grimoireMagicMax(mg) {
    try { if (mg && typeof mg.magicM === 'number' && mg.magicM > 0) return mg.magicM; } catch (e) { /* ignore */ }
    try {
      if (mg && typeof mg.computeMagicM === 'function') {
        mg.computeMagicM();
        if (typeof mg.magicM === 'number' && mg.magicM > 0) return mg.magicM;
      }
    } catch (e) { /* ignore */ }
    try { if (mg && typeof mg.magicMax === 'number' && mg.magicMax > 0) return mg.magicMax; } catch (e) { /* ignore */ }
    return 0;
  }

  // 呪文コストは mg.getSpellCost(spell) が正（無ければ旧候補、それも無ければ null）
  function spellCostOf(mg, spell) {
    try { if (mg && typeof mg.getSpellCost === 'function') { var c = mg.getSpellCost(spell); if (typeof c === 'number' && c > 0) return c; } } catch (e) { /* ignore */ }
    try { if (mg && typeof mg.computeSpellCost === 'function') { var c2 = mg.computeSpellCost(spell); if (typeof c2 === 'number' && c2 > 0) return c2; } } catch (e) { /* ignore */ }
    return null;
  }

  function spellStats() {
    try { return JSON.parse(gmGet('ccauto_spellStats', '') || '{}'); } catch (e) { return {}; }
  }
  function spellStatsBump(key) {
    try {
      var s = spellStats();
      s[key] = (s[key] || 0) + 1;
      gmSet('ccauto_spellStats', JSON.stringify(s));
    } catch (e) { /* ignore */ }
  }

  function pantheonMaintain(G) {
    var t = G.Objects['Temple'];
    var mg = t && t.minigame;
    if (!mg || !mg.gods || typeof mg.slotGod !== 'function') return;
    // v2.3.29: 照合は表示名ではなく gods のキー（id）で行う。日本語版では表示名が
    // 日本語化されており、英語名の部分一致では永遠に一致しなかった（実測で判明）。
    // labor = Muridal（クリック強化）、mother = Mokalsium。最終形は [labor, 空, mother]。
    var targets = [{ id: 'labor', slot: 0, label: 'ダイヤ' }, { id: 'mother', slot: 2, label: 'ヒスイ' }];
    var changed = false;
    function tryPlace(god, slot) {
      if (!god || godSlotNum(god) === slot) return false; // 配置済み（文字列の "2" 等も含む）なら何もしない
      if (typeof mg.swaps === 'number' && mg.swaps < 1) return false; // 付け替え回数が無い
      var swapsBefore = (typeof mg.swaps === 'number') ? mg.swaps : null;
      try { mg.slotGod(god, slot); } catch (e) { return false; }
      if (godSlotNum(god) !== slot) {
        try { gmSet('ccauto_pantheonDebug', 'slotGod(' + (god.name || '?') + ',' + slot + ') called but slot=' + god.slot + ' swaps=' + mg.swaps); } catch (e) { /* ignore */ }
        return false;
      }
      // slotGod は交換回数を消費しない（通常の配置経路は別途 useSwap を呼ぶ）ため、
      // 消費されていなければ通常経路に合わせて1回分消費する（ChatGPTレビューに基づく）
      if (swapsBefore !== null && mg.swaps === swapsBefore && typeof mg.useSwap === 'function') {
        try { mg.useSwap(1); } catch (e) { /* ignore */ }
      }
      return true;
    }
    for (var i = 0; i < targets.length; i++) {
      var tg = targets[i];
      var god = null;
      try { god = mg.gods[tg.id]; } catch (e) { god = null; }
      if (tryPlace(god, tg.slot)) {
        changed = true;
        log('パンテオン配置: ' + (god.name || tg.id) + ' → ' + tg.label);
      }
    }
    // ルビー（slot 1）は空にする: 対象外の神が入っていたら外す
    try {
      for (var gid in mg.gods) {
        var g2 = mg.gods[gid];
        if (g2 && godSlotNum(g2) === 1) {
          if (tryPlace(g2, -1)) { changed = true; log('パンテオン配置: ルビーを空けました（' + (g2.name || gid) + ' を外しました）'); }
        }
      }
    } catch (e) { /* ignore */ }
    if (changed) {
      try { evalCache = null; upGainCache = {}; bGainCache = {}; } catch (e) { /* ignore */ }
    }
    // 配置が揃ったら周回ごとに1回だけ記録する（3枠すべてを確認）
    try {
      var m1 = mg.gods['labor'], m2 = mg.gods['mother'];
      var rubyEmpty = true;
      for (var gid2 in mg.gods) { if (mg.gods[gid2] && godSlotNum(mg.gods[gid2]) === 1) rubyEmpty = false; }
      if (godSlotNum(m1) === 0 && godSlotNum(m2) === 2 && rubyEmpty) {
        var rk = 'r' + (G.resets || 0);
        if (gmGet('ccauto_pantheonRun', '') !== rk) {
          gmSet('ccauto_pantheonRun', rk);
          log('パンテオン配置完了: ダイヤ=Muridal（クリック強化）, ヒスイ=Mokalsium, ルビー=空');
        }
      }
    } catch (e) { /* ignore */ }
  }

  function spellStep() {
    if (!tabState.primary) return;
    if (!state.running) return;
    if (!gameReady() || isChallengePage()) return;
    if (ascendBusy()) return;
    var G = W.Game;
    // パンテオンの配置維持（30秒に1回まで）
    if (Date.now() - spellState.pantheonAt > 30000) {
      spellState.pantheonAt = Date.now();
      try { pantheonMaintain(G); } catch (e) { /* ignore */ }
    }
    // 運命の手（Force the Hand of Fate）
    try {
      var tower = G.Objects['Wizard tower'];
      var mg = tower && tower.minigame;
      if (!mg || !mg.spells) { spellState.lastSkip = 'noGrimoire'; return; }
      var spell = mg.spells['hand of fate'];
      if (!spell) { spellState.lastSkip = 'noSpell'; return; }
      // Holobore配置中（または判定不能）は黄金を回収できないので魔力を使わない
      if (holoboreState() !== 'none') { spellState.lastSkip = 'holobore'; return; }
      var frenzy = (G.buffs || {})['Frenzy'];
      if (!frenzy) { spellState.lastSkip = 'noFrenzy'; return; }
      var fps = G.fps || 30;
      var remainSec = (frenzy.time || 0) / fps;
      if (remainSec < 15) { spellState.lastSkip = 'shortFrenzy'; return; } // 残り短いFrenzyでは撃たない
      // 画面に黄金系が出ている間は撃たない（トナカイ等は対象外）
      var shNow = G.shimmers || [];
      var goldenOut = false;
      for (var shi = 0; shi < shNow.length; shi++) { if (shNow[shi] && shNow[shi].type === 'golden') { goldenOut = true; break; } }
      if (goldenOut) { spellState.lastSkip = 'shimmerOut'; return; }
      var key = 'fz' + Math.round((Date.now() + remainSec * 1000) / 1000);
      if (spellState.lastCastKey === key) { spellState.lastSkip = 'sameFrenzy'; return; } // 同じFrenzyでは1回だけ
      if (Date.now() - spellState.lastAttempt < 60000) { spellState.lastSkip = 'cooldown'; return; }
      if (Date.now() - (gmGet('ccauto_lastCastAt', 0) || 0) < 90000) { spellState.lastSkip = 'castGuard'; return; } // 再読み込みをまたいでも連射しない
      var max = grimoireMagicMax(mg);
      var magic = (typeof mg.magic === 'number') ? mg.magic : 0;
      if (max <= 0) { spellState.lastSkip = 'noMax'; return; }
      var cost = spellCostOf(mg, spell);
      spellState.lastCost = cost;
      if (cost === null) { spellState.lastSkip = 'costUnknown'; return; } // コストが取れない場合は撃たない（ChatGPTレビュー）
      if (magic < cost) { spellState.lastSkip = 'lowMagic'; return; }
      spellState.lastAttempt = Date.now();
      spellState.lastCastKey = key;
      spellState.lastSkip = '';
      // 成否は同期で判定する（召喚も魔力消費も同期処理のため。v2.3.29で400ms遅延判定を廃止）
      var totalBefore = (typeof mg.spellsCastTotal === 'number') ? mg.spellsCastTotal : null;
      var magicBefore = magic;
      var beforeSet = (G.shimmers || []).slice();
      var ret = null;
      try { ret = mg.castSpell(spell); } catch (e) { ret = null; }
      var magicAfter = (typeof mg.magic === 'number') ? mg.magic : magicBefore;
      var totalAfter = (typeof mg.spellsCastTotal === 'number') ? mg.spellsCastTotal : null;
      var fresh = null;
      var arrA = G.shimmers || [];
      for (var ai2 = 0; ai2 < arrA.length; ai2++) { if (beforeSet.indexOf(arrA[ai2]) < 0) { fresh = arrA[ai2]; break; } }
      var success = (ret === true) ||
        (totalBefore !== null && totalAfter !== null && totalAfter > totalBefore) ||
        (magicBefore - magicAfter >= 1);
      spellStatsBump('casts');
      log('グリモア: 運命の手を詠唱（Frenzy残り約' + Math.round(remainSec) + '秒、コスト ' + Math.floor(cost) + '）');
      if (success) {
        spellStatsBump('success');
        try { gmSet('ccauto_lastCastAt', Date.now()); } catch (e) { /* ignore */ }
        if (fresh && fresh.wrath) { spellStatsBump('wrath'); log('運命の手: 逆発動で憤怒クッキーが出現（触りません）'); }
        else if (fresh) { spellStatsBump('golden'); log('運命の手: 黄金クッキーが出現'); }
        else { log('運命の手: 詠唱成立（出現は未確認）'); }
      } else {
        spellStatsBump('failed');
        log('運命の手: 詠唱できませんでした');
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------------- セーブの書き出し ---------------- */

  function exportSave(manual) {
    if (!gameReady()) { if (manual) log('バックアップ失敗: ゲーム未準備'); return; }
    try {
      var code = W.Game.WriteSave(1);
      if (!code || typeof code !== 'string' || code.length < 20) {
        if (manual) log('バックアップ失敗: コードが取得できませんでした');
        return;
      }
      var d = new Date();
      function p(n) { return (n < 10 ? '0' : '') + n; }
      var fname = 'cookie-save-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.txt';
      var blob = new Blob([code], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      gmSet('ccauto_lastBackup', Date.now());
      log('セーブを書き出しました: ' + fname);
    } catch (e) {
      if (manual) log('バックアップ失敗: ' + e);
    }
  }

  /* ---------------- 状態の送信（Muse側で見るため） ---------------- */

  // 周回（昇天）ごとの記録。昇天回数・獲得チップ・所要時間・最高CpSを周回ごとに残し、
  // スペースの「周回ごとの効率」グラフの元データとして状態送信に載せる
  // 累計クッキーからプレステージレベルを求める（ゲームの換算と同じ三乗根。境界の検証・予備用）
  function prestigeLevelFor(totalCookies) {
    return Math.floor(Math.cbrt(Math.max(0, totalCookies || 0) / 1e12));
  }

  function trackRun(G, cpsNow, totalEarned) {
    var resets = 0;
    try { resets = G.resets || 0; } catch (e) { resets = 0; }
    var now = Date.now();
    var tr = null;
    try { tr = gmGet('ccauto_runTrack', null); } catch (e) { tr = null; }
    if (!tr || typeof tr.resets !== 'number') {
      tr = { resets: resets, startedAt: now, peakCps: 0, lastTotal: 0 };
    }
    // 一回限りの補正（v2.2.7）: v2.2.6 で記録を始めた1周目の開始時刻はスクリプト導入時刻
    // （2026-11-12 17:01 JST）になっており、本当の開始（Tabセットアップ完了 = 2026-11-11 14:28 JST）
    // より約26.6時間遅れている。周回の所要時間と効率表示が歪むため、正しい時刻へ直す
    try {
      if (!gmGet('ccauto_runStartFix1', 0) && resets === 0 && (tr.startedAt || 0) >= 1794470400000) {
        var existingLog = gmGet('ccauto_runLog', []);
        if (!Array.isArray(existingLog) || existingLog.length === 0) {
          tr.startedAt = 1794374880000; // 2026-11-11T14:28:00+09:00
        }
        gmSet('ccauto_runStartFix1', 1);
      }
    } catch (e) { /* ignore */ }
    // 巻き戻し対策（v2.3.23）: 記録側（tr.resets）がゲーム（resets）より先に進んでいるのは、
    // 二重タブ等でセーブが巻き戻った証拠。そのままでは再昇天しても記録されなくなるため、
    // 完了扱いの記録を取り消し、記録をゲームの実態に合わせて巻き戻す
    if (tr.resets > resets) {
      var logR = [];
      try { logR = gmGet('ccauto_runLog', []); } catch (e) { logR = []; }
      if (!Array.isArray(logR)) logR = [];
      var dropped = null;
      var keptR = [];
      for (var ri = 0; ri < logR.length; ri++) {
        if ((logR[ri].run || 0) > resets) { if (!dropped) dropped = logR[ri]; }
        else keptR.push(logR[ri]);
      }
      if (keptR.length !== logR.length) { try { gmSet('ccauto_runLog', keptR); } catch (e) { /* ignore */ } }
      // 到達済みチェックポイントを、取り消した記録から復元する（巻き戻し検知の基準にする）
      try {
        var cpSeed = gmGet('ccauto_checkpoint', null);
        if (dropped && (!cpSeed || typeof cpSeed.resets !== 'number')) {
          var cumSeed = 0;
          for (var si4 = 0; si4 < keptR.length; si4++) cumSeed += (keptR[si4].totalEarned || 0);
          gmSet('ccauto_checkpoint', { resets: dropped.run || resets, prestige: prestigeLevelFor(cumSeed + (dropped.totalEarned || 0)), at: now });
        }
      } catch (e) { /* ignore */ }
      var origStart = dropped ? Math.max(0, (dropped.endedAt || now) - (dropped.durationSec || 0) * 1000) : now;
      tr = { resets: resets, startedAt: origStart || now, peakCps: Math.max(dropped ? (dropped.peakCps || 0) : 0, cpsNow || 0), lastTotal: totalEarned || 0 };
      try { gmSet('ccauto_runTrack', tr); } catch (e) { /* ignore */ }
      if (runRecord) runRecord.tainted = true; // v2.3.41: 巻き戻しのあった周回の購入記録は学習に採用しない
      reportError('セーブの巻き戻しを検知し、周回記録を実態に合わせて修正しました（購入は継続します）');
    }
    // チェックポイント（v2.3.23）: 到達済みの (resets, prestige) の最大値を保持し、それを下回る
    // 状態は巻き戻しとして一度だけ報告する。購入・クリック・昇天は止めない（巻き戻し先で
    // 再昇天して追いつくのが復旧経路のため）。追いついたら自動でフラグを下ろす
    try {
      var prestigeNow = 0;
      try { prestigeNow = Math.floor(G.prestige || 0); } catch (e) { prestigeNow = 0; }
      // 全期間累計（リセット分＋今周回分）は正しい進行では単調増加するので、
      // 同一周回内の巻き戻し（建物・クッキーの消失）の検知にも使う（v2.3.32）
      var allTimeNow = 0;
      try { allTimeNow = (G.cookiesReset || 0) + (G.cookiesEarned || 0); } catch (e) { allTimeNow = 0; }
      var cp = null;
      try { cp = gmGet('ccauto_checkpoint', null); } catch (e) { cp = null; }
      if (!cp || typeof cp.resets !== 'number') {
        try { gmSet('ccauto_checkpoint', { resets: resets, prestige: prestigeNow, allTime: allTimeNow, at: now }); } catch (e) { /* ignore */ }
      } else if (resets === 0 && prestigeNow === 0 && cp.resets > 0) {
        // セーブの初期化（ワイプ・新規開始）は新しい系列として扱い、巻き戻しとはみなさない
        try { gmSet('ccauto_checkpoint', { resets: 0, prestige: 0, allTime: 0, at: now }); } catch (e) { /* ignore */ }
        try { gmSet('ccauto_rollbackSeen', 0); } catch (e) { /* ignore */ }
      } else {
        // v2.3.35（ChatGPTレビュー）: 判定を脚ごとに分ける。resets / prestige の後退は従来どおり
        // 即時報告（保留は適用しない）。allTime だけの差は、引き継ぎ直後の古いセーブ読み直しでも
        // 起きる（実例: 更新リロード時、約195秒分の生産量が 0.1% 閾値を超えて誤検知した）ため、
        // 引き継ぎ直後で resets・prestige が到達済みと一致する場合に限り、主タブ復帰から5分間は
        // 報告を保留する。checkpoint の高値は保持し、下方への再基準化はしない（同じ resets・
        // prestige のまま起きる本物の巻き戻しを吸収してしまわないため）。保留中に累計がさらに
        // 明確に下がった場合と、保留期限を過ぎても差が残る場合は一度だけ報告する。保留の期限は
        // 主タブ復帰時刻から数え、再起動のたびに延長しない（GM に保持した期限を使い回す）
        var legResets = resets < cp.resets;
        var legPrestige = (resets === cp.resets && prestigeNow < cp.prestige);
        var legAllTime = (typeof cp.allTime === 'number' && isFinite(cp.allTime) && isFinite(allTimeNow) &&
                          allTimeNow > 0 && allTimeNow < cp.allTime * 0.999);
        var rbReport = function () {
          if (gmGet('ccauto_rollbackSeen', 0) !== 1) {
            gmSet('ccauto_rollbackSeen', 1);
            reportError('セーブの巻き戻しを検知しました（到達済み: 昇天 ' + cp.resets + ' 回／プレステージ ' + cp.prestige + '）。再昇天で追いつくまで記録を保護します（購入は継続します）');
          }
        };
        if (legResets || legPrestige) {
          try { gmSet('ccauto_rbGrace', null); } catch (e) { /* ignore */ }
          rbReport();
        } else if (legAllTime) {
          var grace = null;
          try { grace = gmGet('ccauto_rbGrace', null); } catch (e) { grace = null; }
          var graceMatches = !!(grace && grace.cpAllTime === cp.allTime && grace.resets === resets && grace.prestige === prestigeNow);
          if (!graceMatches && tabState.justHandedOver && tabState.primarySince && (now - tabState.primarySince) < 5 * 60 * 1000) {
            grace = { until: tabState.primarySince + 5 * 60 * 1000, cpAllTime: cp.allTime, firstAllTime: allTimeNow, resets: resets, prestige: prestigeNow };
            try { gmSet('ccauto_rbGrace', grace); } catch (e) { /* ignore */ }
            try { log('検証メモ: 引き継ぎ直後のため巻き戻し判定を保留しました（古いセーブの読み直しの可能性。5分間様子を見ます）'); } catch (e) { /* ignore */ }
            graceMatches = true;
          }
          if (!graceMatches) {
            rbReport();
          } else if (allTimeNow < grace.firstAllTime * 0.999) {
            // 保留中にさらに明確に後退した = 本物の巻き戻しの疑いが強いので即時報告する
            try { gmSet('ccauto_rbGrace', null); } catch (e) { /* ignore */ }
            rbReport();
          } else if (now > (grace.until || 0)) {
            try { gmSet('ccauto_rbGrace', null); } catch (e) { /* ignore */ }
            rbReport();
          }
          // それ以外は保留中: rollbackSeen も checkpoint も触らない
        } else {
          try {
            if (gmGet('ccauto_rbGrace', null)) {
              gmSet('ccauto_rbGrace', null);
              log('巻き戻し判定の保留は解消しました（累計が到達済みに追いつきました）');
            }
          } catch (e) { /* ignore */ }
          if (gmGet('ccauto_rollbackSeen', 0) === 1) {
            gmSet('ccauto_rollbackSeen', 0);
            log('巻き戻しから回復しました（記録が到達済みに追いつきました）');
          }
          if (resets > cp.resets || prestigeNow > cp.prestige || allTimeNow > (cp.allTime || 0)) {
            try { gmSet('ccauto_checkpoint', { resets: resets, prestige: prestigeNow, allTime: allTimeNow, at: now }); } catch (e) { /* ignore */ }
          }
        }
      }
    } catch (e) { /* ignore */ }
    if (resets > tr.resets) {
      // 昇天があった: 前の周回を確定して記録する（複数回まとめて起きた場合は合算の1件として残す）
      var logArr = [];
      try { logArr = gmGet('ccauto_runLog', []); } catch (e) { logArr = []; }
      if (!Array.isArray(logArr)) logArr = [];
      // chips は「その周回で実際に増えたプレステージ」= 累計レベルの増加分（v2.3.18で実績化。
      // 旧方式の周回単独の三乗根は legacyChips に残す）
      var cumBefore = 0;
      for (var ci = 0; ci < logArr.length; ci++) cumBefore += (logArr[ci].totalEarned || 0);
      var chipsRecon = Math.max(0, prestigeLevelFor(cumBefore + (tr.lastTotal || 0)) - prestigeLevelFor(cumBefore));
      // v2.3.29: 昇天フローが記録した確定獲得チップ（天界購入前の実測差分）があればそれを正とする
      var chips = chipsRecon;
      try {
        var gainRec = gmGet('ccauto_lastGain', null);
        if (gainRec && gainRec.run === tr.resets + 1 && typeof gainRec.gain === 'number' && gainRec.gain >= 0) chips = gainRec.gain;
      } catch (e) { /* ignore */ }
      logArr.push({
        run: tr.resets + 1,
        chips: chips,
        reconChips: chipsRecon,
        legacyChips: Math.floor(Math.cbrt(Math.max(0, tr.lastTotal || 0) / 1e12)),
        durationSec: Math.max(0, Math.round((now - (tr.startedAt || now)) / 1000)),
        peakCps: Math.round(tr.peakCps || 0),
        totalEarned: Math.round(tr.lastTotal || 0),
        endedAt: now
      });
      if (logArr.length > 50) logArr = logArr.slice(logArr.length - 50);
      try { gmSet('ccauto_runLog', logArr); } catch (e) { /* ignore */ }
      // 効率判定（v2.3.25）用: 完了した周回の生産カーブを保存する（開始時プレステージは
      // この周回の開始時点の累計レベル = prestigeLevelFor(cumBefore)）
      try { archiveRunCurve(tr.resets + 1, prestigeLevelFor(cumBefore)); } catch (e) { /* ignore */ }
      tr = { resets: resets, startedAt: now, peakCps: 0, lastTotal: 0 };
    }
    if (cpsNow > (tr.peakCps || 0)) tr.peakCps = cpsNow;
    if (totalEarned > 0) tr.lastTotal = totalEarned;
    try { gmSet('ccauto_runTrack', tr); } catch (e) { /* ignore */ }
    // 一回限りの補正（v2.3.18）: 過去の周回記録の chips を実績（累計レベルの増加分）へ直す。
    // 旧値は legacyChips に残す。合計がゲームの prestige と小さくずれる場合は最後の周回で吸収する
    try {
      if (!gmGet('ccauto_chipsFix218', 0)) {
        var fixArr = [];
        try { fixArr = gmGet('ccauto_runLog', []); } catch (e) { fixArr = []; }
        if (Array.isArray(fixArr) && fixArr.length) {
          var cumF = 0, sumF = 0;
          for (var fi = 0; fi < fixArr.length; fi++) {
            var recF = fixArr[fi];
            if (typeof recF.legacyChips !== 'number') recF.legacyChips = recF.chips;
            recF.chips = Math.max(0, prestigeLevelFor(cumF + (recF.totalEarned || 0)) - prestigeLevelFor(cumF));
            cumF += (recF.totalEarned || 0);
            sumF += recF.chips;
          }
          var pgF = 0;
          try { pgF = Math.floor(G.prestige || 0); } catch (e) { pgF = 0; }
          if (pgF > 0 && sumF !== pgF) {
            var diffF = pgF - sumF;
            if (Math.abs(diffF) <= 10) { fixArr[fixArr.length - 1].chips += diffF; }
            else { reportError('チップ記録の補正: 合計とプレステージが大きくずれています（差 ' + diffF + '）'); }
          }
          try { gmSet('ccauto_runLog', fixArr); } catch (e) { /* ignore */ }
        }
        try { gmSet('ccauto_chipSamples', []); } catch (e) { /* ignore */ }
        gmSet('ccauto_chipsFix218', 1);
      }
    } catch (e) { /* ignore */ }
    // 一回限りの補正（v2.3.29）: 6周目の chips は旧方式の記録（17,699）だが、
    // 実際の prestige 増分（57,226 → 75,354 = 18,128）が確認できているため直す
    try {
      if (!gmGet('ccauto_gainFix229', 0)) {
        var fixArr2 = [];
        try { fixArr2 = gmGet('ccauto_runLog', []); } catch (e) { fixArr2 = []; }
        if (Array.isArray(fixArr2)) {
          for (var fi2 = 0; fi2 < fixArr2.length; fi2++) {
            if (fixArr2[fi2].run === 6 && fixArr2[fi2].chips === 17699) { fixArr2[fi2].chips = 18128; fixArr2[fi2].reconChips = 17699; }
          }
          try { gmSet('ccauto_runLog', fixArr2); } catch (e) { /* ignore */ }
        }
        gmSet('ccauto_gainFix229', 1);
      }
    } catch (e) { /* ignore */ }
    var runLogArr = [];
    try { runLogArr = gmGet('ccauto_runLog', []); } catch (e) { runLogArr = []; }
    return {
      resets: resets,
      runs: Array.isArray(runLogArr) ? runLogArr : [],
      current: {
        run: resets + 1,
        startedAt: tr.startedAt || now,
        peakCps: Math.round(tr.peakCps || 0),
        chipsNow: pendingChips(G)
      }
    };
  }

  function collectStatus() {
    var G = W.Game;
    var buildings = [];
    for (var k in G.Objects) {
      var o = G.Objects[k];
      buildings.push({
        name: o.name, count: o.amount || 0, level: (typeof o.level === 'number') ? o.level : 0,
        unitCps: Math.round(o.storedCps || 0), totalCps: Math.round(o.storedTotalCps || 0),
        nextPrice: Math.round(buildingPrice(o) || 0)
      });
    }
    var ach = 0;
    for (var ai in G.Achievements) { if (G.Achievements[ai].won) ach++; }
    var ups = [];
    for (var ui in G.Upgrades) { if (G.Upgrades[ui].bought) ups.push(G.Upgrades[ui].name); }
    var status = {
      v: 1, ts: Date.now(), source: 'galaxy-tab',
      bank: Math.floor(G.cookies), cps: Math.round(baseCps()), cpsRaw: Math.round(G.cookiesPs || 0),
      totalEarned: Math.floor(G.cookiesEarned || 0),
      clicks: G.cookieClicks || 0, clickValue: Math.round(G.computedMouseCps || 0),
      achievements: ach, upgradesOwned: ups,
      buildings: buildings,
      lumps: (typeof G.lumps === 'number') ? G.lumps : 0,
      heavenlyChips: (typeof G.heavenlyChips === 'number') ? Math.floor(G.heavenlyChips) : 0,
      prestige: (typeof G.prestige === 'number') ? Math.floor(G.prestige) : 0,
      mode: state.mode, running: state.running, lastAction: state.lastAction || '',
      recentLogs: (state.logs || []).slice(0, 15)
    };
    status.scriptVersion = SCRIPT_VERSION;
    try { status.autoAscend = (gmGet('ccauto_autoAscend', '1') === '1'); } catch (e) { status.autoAscend = false; }
    try { status.shopBuy = (gmGet('ccauto_shopBuy', '1') === '1'); } catch (e) { status.shopBuy = true; }
    try { status.trace = gmGet('ccauto_trace', []); } catch (e) { /* ignore */ }
    try { status.tabRole = tabState.primary ? 'primary' : 'follower'; } catch (e) { /* ignore */ }
    try { status.tabCode = TAB_ID.slice(-4); status.tabs = tabListForPayload(); } catch (e) { /* ignore */ }
    try { status.heavenLog = gmGet('ccauto_heavenLog', []); } catch (e) { /* ignore */ }
    try { status.ascendLast = gmGet('ccauto_ascendLast', null); } catch (e) { /* ignore */ }
    try { status.ascendEval = effCache ? effCache.data : null; } catch (e) { /* ignore */ }
    // rolledBack は trackRun() の判定後に読む（v2.3.35、ChatGPTレビュー: 判定前に読むと
    // 新規エラーと rolledBack が同じ送信内で食い違うため）。下の trackRun 呼び出し後に設定する
    // 永久スロットの中身（v2.3.26: 遠隔確認用。IDをゲーム内定義と照合して名前で載せる）
    try {
      var slotNames = [];
      var nSl = slotCountOwned(G);
      for (var sli = 0; sli < nSl; sli++) {
        var pid2 = G.permanentUpgrades ? G.permanentUpgrades[sli] : 0;
        var nm2 = null;
        if (pid2 && G.UpgradesById && G.UpgradesById[pid2]) nm2 = G.UpgradesById[pid2].name || null;
        slotNames.push(nm2);
      }
      status.permanentSlots = slotNames;
    } catch (e) { /* ignore */ }
    // 黄金スイッチの状態（v2.3.26）: ONだと黄金クッキーが止まるため、検知したら一度だけ知らせる。
    // 自動で戻すのは切り替えに費用がかかる場合があるため見送り（ChatGPT相談に基づく）
    try {
      // v2.3.29: 判定は所有フラグが正（ChatGPTが公開実装と照合）。
      // 'Golden switch [off]' を所持している状態が「スイッチON」で、自然出現が止まる。
      // 名前の存在検索は両定義に当たって誤判定するため使わない
      var gsState = 'unknown';
      var upOff = G.Upgrades ? G.Upgrades['Golden switch [off]'] : null;
      var upOn = G.Upgrades ? G.Upgrades['Golden switch [on]'] : null;
      if (upOff && upOff.bought) gsState = 'on';
      else if (upOn && upOn.bought) gsState = 'off';
      else if (typeof G.Has === 'function' && !G.Has('Golden switch')) gsState = 'none';
      else if (upOff || upOn) gsState = 'off'; // 解放済みでどちらも未所持なら初期状態=OFF
      else if (typeof G.switchGolden === 'number') gsState = G.switchGolden ? 'on' : 'off';
      else if (typeof G.switchGolden === 'boolean') gsState = G.switchGolden ? 'on' : 'off';
      status.goldenSwitch = gsState;
      if (gsState === 'on') {
        if (gmGet('ccauto_gsWarned', 0) !== 1) {
          gmSet('ccauto_gsWarned', 1);
          reportError('黄金スイッチがONになっています（黄金クッキーが出現しません）。OFFに戻すことをおすすめします');
        }
      } else if (gsState === 'off') {
        if (gmGet('ccauto_gsWarned', 0) === 1) gmSet('ccauto_gsWarned', 0);
      }
    } catch (e) { /* ignore */ }
    // ドラゴンの状態（v2.3.26: オーラ自動化の前段として遠隔確認用）
    try {
      var auraName = function (idx) {
        try {
          var a = (G.dragonAuras && typeof idx === 'number') ? G.dragonAuras[idx] : null;
          return a ? (a.name || null) : null;
        } catch (e) { return null; }
      };
      status.dragon = {
        level: (typeof G.dragonLevel === 'number') ? G.dragonLevel : null,
        aura1: auraName(G.dragonAura), aura2: auraName(G.dragonAura2)
      };
    } catch (e) { /* ignore */ }
    // グリモアとパンテオンの状態（v2.3.27: 遠隔確認用）
    try {
      var tw = G.Objects['Wizard tower'];
      var gmg = tw && tw.minigame;
      if (gmg) {
        var ss = spellStats();
        status.grimoire = {
          magic: Math.floor(gmg.magic || 0), magicMax: Math.floor(grimoireMagicMax(gmg)),
          casts: ss.casts || 0, success: ss.success || 0, golden: ss.golden || 0, wrath: ss.wrath || 0, failed: ss.failed || 0
        };
        // 遠隔の切り分け用（v2.3.29）: 直近の見送り理由とAPIの型
        try {
          var hf = (G.Objects['Wizard tower'] || {});
          status.grimoireDebug = {
            lastSkip: spellState.lastSkip || '', lastCost: spellState.lastCost,
            getSpellCost: typeof gmg.getSpellCost, castSpell: typeof gmg.castSpell,
            towerCount: hf.amount || 0, towerLevel: hf.level || 0,
            gameVersion: (typeof G.version !== 'undefined') ? G.version : null
          };
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    try {
      var tp = G.Objects['Temple'];
      var pmg = tp && tp.minigame;
      if (pmg && pmg.gods) {
        var slots = [null, null, null];
        for (var gid2 in pmg.gods) {
          var gg2 = pmg.gods[gid2];
          var gsN = godSlotNum(gg2);
          if (gsN !== null && gsN >= 0 && gsN <= 2) slots[gsN] = gg2.name || null;
        }
        status.pantheon = slots;
        status.pantheonSwaps = (typeof pmg.swaps === 'number') ? Math.floor(pmg.swaps) : null;
        // 配置できない原因の切り分け用（v2.3.28）
        try {
          var gdb = [];
          for (var gid3 in pmg.gods) { var gg3 = pmg.gods[gid3]; if (gg3) gdb.push({ id: gid3, name: gg3.name || '', slot: gg3.slot }); }
          status.pantheonDebug = { slotGod: typeof pmg.slotGod, gods: gdb, note: gmGet('ccauto_pantheonDebug', '') || '' };
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    // 周回（昇天）の記録: 昇天回数・完了した周回の一覧・進行中の周回の状態
    try {
      var runInfo = trackRun(G, status.cps || status.cpsRaw || 0, status.totalEarned || 0);
      status.resets = runInfo.resets;
      status.runs = runInfo.runs;
      status.runCurrent = runInfo.current;
    } catch (e) { /* ignore */ }
    try { status.rolledBack = gmGet('ccauto_rollbackSeen', 0) === 1; } catch (e) { /* ignore */ }
    try {
      // v2.3.36: 送信の組み立てでは全面評価を直呼びしない（ChatGPTレビュー）。
      // 最後に完了した評価（キャッシュ）だけを参照し、無ければ空として送る（目標類は state 側が保持）。
      var evD = (evalCache && evalCache.ev) ? evalCache.ev : { list: [], cpsNow: baseCps() };
      var topD = evD.list.length ? evD.list[0] : null;
      status.diag = {
        top: topD ? topD.label : '',
        topPrice: topD ? Math.round(topD.price) : 0,
        income: Math.round(totalIncome(evD.cpsNow)),
        target: state.nextTarget || '',
        goal: state.goalTarget || '',
        detail: state.nextDetail || '',
        goalDetail: state.goalDetail || '',
        goal1: state.goal1 || null,
        goal2: state.goal2 || null,
        // 実際に次に買うもの（next）と、目標までの間に実際に買った直近のもの（last。目標が変わっていたら null）
        actual: {
          // 購入OFFの間は「次に買う」を送らない（買わないものを次と表示しないため。v2.3.39）
          next: (gmGet('ccauto_shopBuy', '1') !== '1') ? null : (state.actualNext || null),
          last: (state.lastInterim && topD && state.lastInterim.goal === topD.label) ? state.lastInterim : null
        },
        // 購入リスト再生の進み具合（v2.3.41）
        replay: state.replayInfo ? { idx: state.replayInfo.idx, total: state.replayInfo.total, label: state.replayInfo.label } : null
      };
    } catch (e) { /* ignore */ }
    // 画面ズームの診断（v2.3.44）: 主要要素の矩形とビューポート寸法を載せ、
    // ショップ列が画面外に出る原因を実測で切り分ける
    try {
      var rectOf = function (id) {
        var el = document.getElementById(id);
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      };
      var vv = W.visualViewport;
      status.geo = {
        iw: W.innerWidth, ih: W.innerHeight,
        cw: document.documentElement ? document.documentElement.clientWidth : 0,
        vv: vv ? [Math.round(vv.width), Math.round(vv.height), Math.round(vv.offsetLeft), Math.round(vv.offsetTop), Math.round(vv.scale * 100) / 100] : null,
        zoom: document.documentElement ? (document.documentElement.style.zoom || '') : '', comp: zoomComp,
        game: rectOf('game'), left: rectOf('sectionLeft'), mid: rectOf('sectionMiddle'), right: rectOf('sectionRight'), store: rectOf('store'), panel: rectOf('ccauto-panel')
      };
    } catch (e) { /* ignore */ }
    // エラー記録（新しい順・最大10件）を状態に載せる。Muse側のチェッカーが新しいものをチャットへ報告する
    try { status.errors = gmGet('ccauto_errors', []); } catch (e) { /* ignore */ }
    // 自動昇天の状態（実行中・停止中だけ載せる。Muse側で完了や停止に気づくため）
    try {
      var af = gmGet('ccauto_ascendFlow', null);
      if (af && af.phase && af.phase !== 'done') {
        status.ascend = { phase: af.phase, run: af.run, bought: (af.bought || []).length, failed: af.failed || [], skipped: af.skipped || [] };
      }
    } catch (e) { /* ignore */ }
    // 30分に1回、セーブコードを状態に同梱する（Drive経由でMuse側に保管される）。
    // 送信成功が確認できるまで pending として保持し、毎回の送信に同梱し続ける
    try {
      var pendingSave = gmGet('ccauto_pendingSave', '');
      if (!pendingSave && Date.now() - gmGet('ccauto_lastSaveRep', 0) >= 30 * 60 * 1000) {
        var sc = W.Game.WriteSave(1);
        if (sc && typeof sc === 'string' && sc.length >= 20) {
          pendingSave = sc;
          gmSet('ccauto_pendingSave', sc);
        }
      }
      if (pendingSave) { status.saveBackup = pendingSave; lastSentSave = pendingSave; }
    } catch (e) { /* ignore */ }
    // 負荷の計測（v2.3.36）: 前回送信からの集計を載せてリセットする
    try {
      status.perf = {
        evalCount: perf.evalCount, evalMs: Math.round(perf.evalMs), evalMaxMs: Math.round(perf.evalMaxMs),
        clickMs: Math.round(perf.clickMs), longFrames: perf.longFrames, maxFrameMs: perf.maxFrameMs
      };
      perf.evalCount = 0; perf.evalMs = 0; perf.evalMaxMs = 0;
      perf.clickMs = 0; perf.clickTicks = 0; perf.longFrames = 0; perf.maxFrameMs = 0;
    } catch (e) { /* ignore */ }
    // 全体系実測の無効化件数と救済購入の集計（v2.3.38）: 前回送信からの分を載せてリセットする
    try {
      status.simInvalid = { wild: simInvalidCounts.wild, ach: simInvalidCounts.ach, drift: simInvalidCounts.drift };
      simInvalidCounts.wild = 0; simInvalidCounts.ach = 0; simInvalidCounts.drift = 0;
      status.rescue = { count: rescueCount, last: rescueLastLabel };
      rescueCount = 0;
    } catch (e) { /* ignore */ }
    return status;
  }

  function reportSecret() { return gmGet('ccauto_reportSecret', ''); }

  var lastSentSave = '';
  var reportInFlight = false;
  var reportWanted = false;
  // 通信の完了時に呼ばれる。通信中に来た送信要求（昇天バックアップ等）は消さずに
  // 保持し、完了直後に送る（v2.3.30、ChatGPTレビューに基づく）
  function reportDone() {
    reportInFlight = false;
    if (reportWanted) {
      reportWanted = false;
      setTimeout(function () { try { reportStep(); } catch (e) { /* ignore */ } }, 100);
    }
  }
  function reportStep() {
    if (!tabState.primary) return; // 二重タブ防止: 従タブは送信しない（同じ状態の二重送信を防ぐ）
    if (reportInFlight) { reportWanted = true; return; } // 通信中は重ねて送らないが、要求は保持する
    if (!gameReady() || isChallengePage()) return;
    if (typeof GM_xmlhttpRequest !== 'function') return;
    var url = gmGet('ccauto_reportUrl', '');
    if (!url) return; // 送信先URLが未設定なら何もしない（パネルから設定する）
    if (!reportSecret()) return; // 合言葉が未設定なら送らない（パネルの🔑から設定する）
    // v2.3.34: heavenLog の復元を collectStatus の直前に試す。主タブ確定済み（この関数の冒頭で
    // 判定）に加え、所有権を再確認し、昇天フロー進行中は次回へ延期する（heavenLog は共有保存のため）
    try {
      var fl34 = gmGet('ccauto_ascendFlow', null);
      var cl34 = tabClaimRead();
      if (tabState.primary && cl34 && cl34.id === TAB_ID && !claimIsForeignFresh(cl34) && !(fl34 && fl34.phase && fl34.phase !== 'done')) heavenLogBackfill();
    } catch (e) { /* ignore */ }
    reportInFlight = true;
    try {
      lastSentSave = '';
      var payload = JSON.stringify({ secret: reportSecret(), status: collectStatus() });
      // このリクエストが送ったセーブは、応答側でローカルに保持して照合する（共有変数経由にしない）
      var sentSave = lastSentSave;
      GM_xmlhttpRequest({
        method: 'POST',
        url: url,
        headers: { 'Content-Type': 'text/plain' },
        data: payload,
        timeout: 20000,
        onload: function (res) {
          reportDone();
          if (res && res.status === 200 && typeof res.responseText === 'string' && ('' + res.responseText).trim() === 'ok') {
            state.lastReport = nowTime();
            gmSet('ccauto_lastReport', state.lastReport);
            // セーブの同梱が成功して初めて「送信済み」にする（失敗分は pending として次回も送る）
            if (sentSave && gmGet('ccauto_pendingSave', '') === sentSave) {
              gmSet('ccauto_pendingSave', '');
              gmSet('ccauto_lastSaveRep', Date.now());
            }
          } else {
            // 応答が 'ok' でない＝送信先で受け付けられていない。原因切り分けのためログに残す
            var msg = '送信の応答が異常（' + (res ? res.status : '?') + '）: ' +
              ((res && res.responseText) ? ('' + res.responseText).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 80) : '');
            if (state.logs[0] !== msg) log(msg);
          }
          renderPanel();
        },
        onerror: function () {
          reportDone();
          var msg = '送信に失敗しました（通信エラー）';
          if (state.logs[0] !== msg) log(msg);
          renderPanel();
        },
        ontimeout: function () {
          reportDone();
          var msg = '送信に失敗しました（時間切れ）';
          if (state.logs[0] !== msg) log(msg);
          renderPanel();
        }
      });
    } catch (e) { reportDone(); }
  }

  function reportTest() {
    // 送信の切り分け用：各段階の結果をログに残す（通常の送信は無言）
    if (!tabState.primary) { log('従タブのため送信テストは実行しません（送信は主タブだけが行います）'); renderPanel(); return; }
    if (reportInFlight) { log('通常の送信が通信中です。少し待ってから試してください'); renderPanel(); return; }
    log('送信テスト開始');
    var url = gmGet('ccauto_reportUrl', '');
    log(url ? ('送信先URL: 設定あり（' + url.length + '文字）') : '送信先URL: 未設定です');
    if (!url) { renderPanel(); return; }
    log(reportSecret() ? '合言葉: 設定あり' : '合言葉: 未設定です（パネルの🔑から設定してください）');
    if (!reportSecret()) { renderPanel(); return; }
    log('送信の部品: ' + (typeof GM_xmlhttpRequest));
    if (typeof GM_xmlhttpRequest !== 'function') { renderPanel(); return; }
    var payload;
    try {
      payload = JSON.stringify({ secret: reportSecret(), status: collectStatus() });
      log('状態データ作成: OK（' + payload.length + '文字）');
    } catch (e) {
      log('状態データ作成でエラー: ' + ((e && e.message) ? e.message : e));
      renderPanel(); return;
    }
    var done = false;
    var watchdog = setTimeout(function () {
      if (!done) { log('応答が返ってきません（送信の仕組みが止まっています）'); renderPanel(); }
    }, 25000);
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: url,
        headers: { 'Content-Type': 'text/plain' },
        data: payload, timeout: 20000,
        onload: function (res) {
          done = true; clearTimeout(watchdog);
          log('応答あり: ' + (res ? res.status : '?') + ' / ' +
            ((res && res.responseText) ? ('' + res.responseText).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 60) : ''));
          if (res && typeof res.responseText === 'string' && ('' + res.responseText).trim() === 'ok') {
            state.lastReport = nowTime();
            gmSet('ccauto_lastReport', state.lastReport);
          }
          renderPanel();
        },
        onerror: function () { done = true; clearTimeout(watchdog); log('通信エラーで失敗しました'); renderPanel(); },
        ontimeout: function () { done = true; clearTimeout(watchdog); log('時間切れで失敗しました'); renderPanel(); }
      });
      log('送信を試しました…');
    } catch (e) {
      clearTimeout(watchdog);
      log('送信の呼び出しでエラー: ' + ((e && e.message) ? e.message : e));
    }
    renderPanel();
  }

  /* ---------------- パネル表示 ---------------- */

  var panel = null;
  // ===== 画面ズーム（v2.3.42、ユーザー要望「開いたとき常に縮小」＋ChatGPTレビュー） =====
  // 旧来の90%切替を拡張: 値は 0.5/0.67/0.75/0.8/1 のみ。適用先は html の style.zoom（v2.3.43で body から変更）。
  // 未移行の端末では初回に 0.5 へ移行する（ccauto_zoomV2）。座標クリックは
  // getBoundingClientRect と clientX/Y が同じ座標系なので補正不要（レビュー確認済み）。
  var ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 1];
  var zoomOk = null; // null=未確認 / true=適用できた / false=非対応
  function pageZoom() {
    try {
      if (gmGet('ccauto_zoomV2', '') !== '1') {
        gmSet('ccauto_zoom', '0.5');
        gmSet('ccauto_zoomV2', '1');
        return 0.5;
      }
      var v = parseFloat(gmGet('ccauto_zoom', '0.5'));
      for (var i = 0; i < ZOOM_STEPS.length; i++) if (Math.abs(ZOOM_STEPS[i] - v) < 0.001) return ZOOM_STEPS[i];
      return 0.5;
    } catch (e) { return 0.5; }
  }
  function applyPageZoom() {
    try {
      if (!document.body || !document.documentElement) return;
      // v2.3.43: 適用先を body から html（ルート）へ変更。body 方式では右端のショップ列と
      // 左下固定のパネルが画面外に押し出された（実機確認）。body 側の指定は必ず外す
      try { document.body.style.removeProperty('zoom'); } catch (e) { /* ignore */ }
      var z = pageZoom();
      var next = (z >= 1) ? '' : String(z);
      var prev = document.documentElement.style.zoom || '';
      document.documentElement.style.zoom = next;
      var readback = document.documentElement.style.zoom || '';
      zoomOk = (next === '' || readback !== '');
      if (prev !== next && zoomOk) {
        // 倍率が変わったときだけ、次フレームで resize を送って描画側の再計算を促す
        try { requestAnimationFrame(function () { try { W.dispatchEvent(new W.Event('resize')); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
      }
      applyZoomCompensation(true);
    } catch (e) { /* ignore */ }
  }

  // ===== ブラウザ倍率の補正（v2.3.45、ChatGPTレビュー） =====
  // 実測で判明: Firefox 側の表示倍率（visualViewport.scale）が 1.16 に固定され、
  // レイアウトの右と下 約14% が見える範囲の外に出ていた（再読み込み・開き直し・
  // ダブルタップでも戻らない）。ページ側に倍率を戻す API は無いので、body に
  // 逆倍率の transform を掛けて相殺する。補正値は起動時・全画面切替時にだけ決め、
  // 以後は固定する（ユーザーのピンチ操作を追いかけて相殺し続けない）。
  // 軽い再確認（vv resize / 15秒間隔）は「解除」と「未決定時の初回適用」だけを行う。
  var zoomComp = 1; // 現在の補正倍率（1 = 補正なし）
  var zoomCompDecided = false;
  function applyZoomCompensation(full) {
    try {
      var vv = W.visualViewport;
      if (!vv || !document.body || !document.documentElement) return;
      var s = vv.scale || 1;
      if (s <= 1.01) {
        if (zoomComp !== 1) {
          document.body.style.transform = '';
          document.body.style.transformOrigin = '';
          zoomComp = 1;
          if (typeof logAdd === 'function') logAdd('ブラウザの表示倍率が戻ったため、画面の補正を解除しました');
        }
        zoomCompDecided = false;
        return;
      }
      if (Math.abs(vv.offsetLeft || 0) > 2 || Math.abs(vv.offsetTop || 0) > 2) return; // パン中は決めない
      if (!full && zoomCompDecided) return;
      // 補正前の寸法で必要倍率を測る（transform を一時的に外して測り、戻す）
      var prevT = document.body.style.transform || '';
      if (prevT) document.body.style.transform = '';
      var cw = document.documentElement.clientWidth || W.innerWidth || 0;
      var ch = document.documentElement.clientHeight || W.innerHeight || 0;
      if (prevT) document.body.style.transform = prevT;
      if (!cw || !ch) return;
      var f = Math.min(vv.width / cw, vv.height / ch, 1) * 0.995; // わずかに余裕を持たせる
      zoomCompDecided = true;
      if (f >= 0.999) {
        if (zoomComp !== 1) { document.body.style.transform = ''; document.body.style.transformOrigin = ''; zoomComp = 1; }
        return;
      }
      if (!(f > 0.5)) return; // 異常な値は補正しない
      if (Math.abs(f - zoomComp) < 0.005 && prevT) return;
      zoomComp = f;
      document.body.style.transformOrigin = '0 0';
      document.body.style.transform = 'scale(' + f + ')';
      if (typeof logAdd === 'function') logAdd('ブラウザの表示倍率 ' + Math.round(s * 100) + '% で画面が切れるため、全体を ' + Math.round(f * 100) + '% に補正しました');
    } catch (e) { /* ignore */ }
  }
  try { document.addEventListener('fullscreenchange', function () { applyZoomCompensation(true); }); } catch (e) { /* ignore */ }
  try {
    if (W.visualViewport) {
      var zoomCompVvTimer = null;
      W.visualViewport.addEventListener('resize', function () {
        if (zoomCompVvTimer) clearTimeout(zoomCompVvTimer);
        zoomCompVvTimer = setTimeout(function () { applyZoomCompensation(false); }, 800);
      });
    }
  } catch (e) { /* ignore */ }
  try { setInterval(function () { applyZoomCompensation(false); }, 15000); } catch (e) { /* ignore */ }

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'ccauto-panel';
    panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;background:rgba(20,16,10,0.92);color:#ffe9b0;' +
      'font:12px/1.5 sans-serif;padding:8px 10px;border:1px solid #a8842c;border-radius:8px;max-width:270px;';
    panel.innerHTML =
      '<style>#ccauto-panel button{background:#3a2c14;color:#ffe9b0;border:1px solid #6b5320;border-radius:6px;padding:5px 7px;font-size:12px;cursor:pointer}#ccauto-panel button:active{background:#57451c}#ccauto-panel .ccauto-rp{padding:2px 5px;font-size:11px}</style>' +
      '<div id="ccauto-title" style="font-weight:bold;margin-bottom:4px;font-size:13px;">🤖 自動購入パネル</div>' +
      '<div id="ccauto-status"></div>' +
      '<div id="ccauto-stats" style="color:#ffe9b0;font-weight:bold;font-size:13px;margin:2px 0;"></div>' +
      '<div id="ccauto-next" style="margin:2px 0;"></div>' +
      '<div style="height:6px;background:#3a2c14;border-radius:3px;margin:3px 0 1px;"><div id="ccauto-bar" style="height:100%;width:0%;background:#e8b64c;border-radius:3px;transition:width .5s;"></div></div>' +
      '<button id="ccauto-expand" style="display:none;margin-top:4px;">再表示</button>' +
      '<div id="ccauto-controls">' +
      '<div style="margin-top:6px;">' +
      '<button id="ccauto-toggle" style="margin-right:4px;">停止/再開</button>' +
      '<button id="ccauto-mode" style="margin-right:4px;">モード切替</button>' +
      '<button id="ccauto-backup" style="margin-right:4px;">💾 バックアップ</button>' +
      '<button id="ccauto-rate">👆 速度</button>' +
      '</div>' +
      '<div style="margin-top:4px;">' +
      '<button id="ccauto-shopbuy" style="margin-right:4px;">🛒 購入:ON</button>' +
      '<button id="ccauto-ascend">🚀 自動昇天:ON</button>' +
      '</div>' +
      '<div style="margin-top:4px;">👆速度 ' +
      '<button class="ccauto-rp" data-rate="0" style="margin-right:2px;padding:2px 5px;">止</button>' +
      '<button class="ccauto-rp" data-rate="2" style="margin-right:2px;padding:2px 5px;">2</button>' +
      '<button class="ccauto-rp" data-rate="10" style="margin-right:2px;padding:2px 5px;">10</button>' +
      '<button class="ccauto-rp" data-rate="50" style="margin-right:2px;padding:2px 5px;">50</button>' +
      '<button class="ccauto-rp" data-rate="100" style="margin-right:2px;padding:2px 5px;">100</button>' +
      '<button class="ccauto-rp" data-rate="200" style="margin-right:2px;padding:2px 5px;">200</button>' +
      '<button class="ccauto-rp" data-rate="250" style="padding:2px 5px;">250</button>' +
      '</div>' +
      '<div style="margin-top:4px;">' +
      '<button id="ccauto-full" style="margin-right:4px;">⛶ 全画面</button>' +
      '<button id="ccauto-report" style="margin-right:4px;">📤 送信先設定</button>' +
      '<button id="ccauto-secret" style="margin-right:4px;">🔑 合言葉設定</button>' +
      '<button id="ccauto-zoom" style="margin-right:4px;">🔍 縮小</button>' +
      '<button id="ccauto-wake" style="margin-right:4px;">💡 画面維持</button>' +
      '<button id="ccauto-test" style="margin-right:4px;">📨 送信テスト</button>' +
      '<button id="ccauto-min">最小化</button>' +
      '</div>' +
      '<div id="ccauto-log" style="margin-top:6px;max-height:110px;overflow:auto;font-size:11px;color:#d8c690;"></div>' +
      '</div>';
    document.body.appendChild(panel);
    document.getElementById('ccauto-toggle').addEventListener('click', function () {
      state.running = !state.running;
      if (state.running) { state.halted = false; gmSet('ccauto_halted', 0); state.anomalies = 0; state.pendingVerify = null; gmSet('ccauto_pendingVerify', ''); }
      saveState(); log(state.running ? '再開しました' : '停止しました'); renderPanel();
    });
    document.getElementById('ccauto-mode').addEventListener('click', function () {
      state.mode = (state.mode === 'auto') ? 'readonly' : 'auto';
      if (state.mode === 'auto') gmSet('ccauto_approvedVersion', SCRIPT_VERSION); // この版での自動購入を承認済みにする
      saveState(); log('モードを ' + state.mode + ' にしました'); renderPanel();
    });
    document.getElementById('ccauto-backup').addEventListener('click', function () { exportSave(true); });
    // v2.3.39: ショップ購入と自動昇天の ON/OFF（主タブでのみ変更可。保存は読み戻して確認する）
    document.getElementById('ccauto-shopbuy').addEventListener('click', function () {
      if (!tabState.primary) { log('設定の変更は主タブでのみできます'); return; }
      var next = (gmGet('ccauto_shopBuy', '1') === '1') ? '0' : '1';
      gmSet('ccauto_shopBuy', next);
      if (gmGet('ccauto_shopBuy', '1') !== next) { log('購入設定の保存に失敗しました'); renderPanel(); return; }
      storePresence = {}; // 店頭滞留は数え直し（再開直後に救済購入が即発火しないように）
      evalCache = null;    // 再開後は最新状態で評価し直す
      log(next === '1' ? 'ショップ購入をONにしました' : 'ショップ購入をOFFにしました（クリック・黄金クッキー・送信は継続します）');
      renderPanel();
    });
    document.getElementById('ccauto-ascend').addEventListener('click', function () {
      if (!tabState.primary) { log('設定の変更は主タブでのみできます'); return; }
      var next = (gmGet('ccauto_autoAscend', '1') === '1') ? '0' : '1';
      gmSet('ccauto_autoAscend', next);
      if (gmGet('ccauto_autoAscend', '1') !== next) { log('昇天設定の保存に失敗しました'); renderPanel(); return; }
      if (next === '0' && ascendBusy()) log('自動昇天をOFFにしました。進行中の昇天は続行します');
      else log(next === '1' ? '自動昇天をONにしました' : '自動昇天をOFFにしました（次回の開始から）');
      renderPanel();
    });
    document.getElementById('ccauto-rate').addEventListener('click', function () {
      var cur = clickRate();
      var u = window.prompt('大クッキーの自動クリック速度を入力してください（回/秒、0で停止、最大250。重くなったら下げてください）', cur);
      if (u === null) return;
      var v = parseFloat(u);
      if (isNaN(v)) { log('速度の入力が数字ではありませんでした'); return; }
      if (v < 0) v = 0;
      if (v > 250) v = 250;
      gmSet('ccauto_clickRate', '' + v);
      scheduleClicks();
      log('クリック速度を ' + v + '/秒 にしました');
      renderPanel();
    });
    document.getElementById('ccauto-zoom').addEventListener('click', function () {
      if (zoomOk === false) { log('この端末では画面の縮小に対応していません'); return; }
      var cur = pageZoom();
      var idx = 0;
      for (var i = 0; i < ZOOM_STEPS.length; i++) if (Math.abs(ZOOM_STEPS[i] - cur) < 0.001) idx = i;
      var nextZ = ZOOM_STEPS[(idx + 1) % ZOOM_STEPS.length];
      gmSet('ccauto_zoom', String(nextZ));
      gmSet('ccauto_zoomV2', '1');
      applyPageZoom();
      log('画面の表示を ' + Math.round(nextZ * 100) + '% にしました');
      renderPanel();
    });
    document.getElementById('ccauto-expand').addEventListener('click', function () {
      gmSet('ccauto_mini', ''); renderPanel();
    });
    document.getElementById('ccauto-min').addEventListener('click', function () {
      gmSet('ccauto_mini', '1'); renderPanel();
    });
    var rpBtns = panel.querySelectorAll('.ccauto-rp');
    for (var ri = 0; ri < rpBtns.length; ri++) {
      rpBtns[ri].addEventListener('click', function () {
        var v = parseFloat(this.getAttribute('data-rate')) || 0;
        gmSet('ccauto_clickRate', '' + v);
        scheduleClicks();
        log('クリック速度を ' + v + '/秒 にしました');
        renderPanel();
      });
    }
    document.getElementById('ccauto-wake').addEventListener('click', function () {
      var on = gmGet('ccauto_wake', '') !== '0'; // v2.3.16〜 既定はON。'0'と明示したときだけOFF
      gmSet('ccauto_wake', on ? '0' : '1');
      if (!on) acquireWakeLock(); else releaseWakeLock();
      renderPanel();
    });
    document.getElementById('ccauto-full').addEventListener('click', function () {
      try {
        if (document.fullscreenElement) { document.exitFullscreen(); }
        else {
          var p = document.documentElement.requestFullscreen();
          if (p && p.catch) p.catch(function () { log('全画面にできませんでした'); });
        }
      } catch (e) { log('全画面にできませんでした'); }
    });
    document.getElementById('ccauto-report').addEventListener('click', function () {
      var cur = gmGet('ccauto_reportUrl', '');
      var u = window.prompt('状態の送信先URL（Apps ScriptのWebアプリURL）を貼り付けてください', cur);
      if (u === null) return;
      u = ('' + u).replace(/\s+/g, '');
      gmSet('ccauto_reportUrl', u);
      log(u ? '送信先を設定しました' : '送信先を消去しました');
      if (u) reportStep();
      renderPanel();
    });
    document.getElementById('ccauto-secret').addEventListener('click', function () {
      var cur = gmGet('ccauto_reportSecret', '');
      var u = window.prompt('状態送信の合言葉（Apps Script側と対の文字列）を貼り付けてください', cur);
      if (u === null) return;
      u = ('' + u).replace(/\s+/g, '');
      gmSet('ccauto_reportSecret', u);
      log(u ? '合言葉を設定しました' : '合言葉を消去しました');
      if (u) reportStep();
      renderPanel();
    });
    document.getElementById('ccauto-test').addEventListener('click', function () { reportTest(); });
    applyPageZoom(); // v2.3.42: 保存済みの縮小率を復元（初期値は50%）
  }

  var wakeLockObj = null;
  function acquireWakeLock() {
    try {
      if (!('wakeLock' in navigator)) { log('このブラウザは画面維持に対応していません'); return; }
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLockObj = lock;
        log('画面スリープ防止を有効にしました');
        lock.addEventListener('release', function () { wakeLockObj = null; });
      }).catch(function () { log('画面スリープ防止を有効化できませんでした'); });
    } catch (e) { log('このブラウザは画面維持に対応していません'); }
  }
  function releaseWakeLock() {
    try { if (wakeLockObj) { wakeLockObj.release(); wakeLockObj = null; } } catch (e) { /* ignore */ }
    log('画面スリープ防止を解除しました');
  }

  // 描画の集約（v2.3.36、ChatGPTレビュー）: ログ・購入などの頻繁な経路は requestRender() 経由で
  // 最大1秒に1回へまとめる。手動ボタン等の応答は従来どおり renderPanel() を直接呼んで即時描画する。
  var lastRenderAt = 0;
  var renderTimer = null;
  function requestRender() {
    var now = Date.now();
    var wait = 1000 - (now - lastRenderAt);
    if (wait <= 0) { try { renderPanel(); } catch (e) { /* ignore */ } return; }
    if (!renderTimer) {
      renderTimer = setTimeout(function () {
        renderTimer = null;
        try { renderPanel(); } catch (e) { /* ignore */ }
      }, wait);
    }
  }
  function renderPanel() {
    lastRenderAt = Date.now();
    // パネルの自己修復：消えていたら作り直し、外れていたら付け直す
    if (!panel || !document.getElementById('ccauto-panel')) { panel = null; buildPanel(); }
    if (panel && panel.parentNode !== document.body) document.body.appendChild(panel);
    if (!panel) return;
    var st = document.getElementById('ccauto-status');
    var nx = document.getElementById('ccauto-next');
    var lg = document.getElementById('ccauto-log');
    if (!st) return;
    var mini = gmGet('ccauto_mini', '1') === '1';
    var ctlEl = document.getElementById('ccauto-controls');
    var expEl = document.getElementById('ccauto-expand');
    var ttlEl = document.getElementById('ccauto-title');
    if (ctlEl) ctlEl.style.display = mini ? 'none' : 'block';
    if (expEl) expEl.style.display = mini ? 'inline-block' : 'none';
    if (ttlEl) ttlEl.style.display = mini ? 'none' : 'block';
    // タブの識別コードと役割を題名に出す（複数タブ時に画面で見分けるため、v2.3.32）
    if (ttlEl) ttlEl.textContent = '🤖 自動購入パネル（タブ ' + TAB_ID.slice(-4) + (tabState.primary ? '・主' : (tabState.decided ? '・従' : '')) + '）';
    panel.style.maxWidth = mini ? '240px' : '270px';
    var modeLabel = (state.mode === 'auto') ? '自動購入' : '読み取り専用';
    var runLabel = state.halted ? '購入停止中（異常検知）' : (state.running ? '稼働中' : '停止中');
    if (tabState.decided && !tabState.primary) runLabel = '別のタブで動作中（二重タブ防止）';
    var statsTxt = '';
    if (gameReady()) {
      statsTxt = '所持 ' + fmt(W.Game.cookies) + ' / CpS ' + fmt(baseCps()) +
        ' / 👆' + (clickRate() > 0 ? clickRate() + '/秒（実測' + Math.round(measuredClickRate()) + '）' : 'オフ');
      if (!state.nextTarget) {
        try {
          // v2.3.36: パネルからも全面評価を直呼びしない。最後に完了した評価があれば流用するだけにする
          var ev = (evalCache && evalCache.ev) ? evalCache.ev : null;
          if (ev && ev.list.length) {
            state.nextTarget = ev.list[0].label;
            state.nextDetail = '価格 ' + fmt(ev.list[0].price);
            state.targetPrice = ev.list[0].price;
            if (!state.goal1) {
              var bk = W.Game.cookies;
              var incF = totalIncome(ev.cpsNow);
              var second = null;
              for (var fi = 1; fi < ev.list.length; fi++) { if (ev.list[fi].price <= bk) { second = ev.list[fi]; break; } }
              if (!second && ev.list.length > 1) second = ev.list[1];
              setGoals(ev.list[0], second, ev.list[0].price <= bk ? 1 : (second ? 2 : 1), false, bk, incF);
            }
          }
        } catch (e) { /* ignore */ }
      }
    } else if (isChallengePage()) {
      statsTxt = '⚠ 確認画面のため停止中';
    } else {
      statsTxt = 'ゲーム読み込み待ち';
    }
    var rep = !gmGet('ccauto_reportUrl', '') ? ' / 送信先未設定' : (!reportSecret() ? ' / 合言葉未設定' : (state.lastReport ? ' / 送信 ' + state.lastReport : ''));
    st.textContent = runLabel + '（' + modeLabel + '）' + (gmGet('ccauto_shopBuy', '1') !== '1' ? ' / 購入OFF' : '') + rep;
    st.style.color = state.running ? '#b6f09c' : '#ffb27d';
    st.style.fontWeight = 'bold';
    var statsEl = document.getElementById('ccauto-stats');
    if (statsEl) statsEl.textContent = statsTxt;
    var esc = function (s) { return ('' + s).replace(/</g, '&lt;'); };
    var nxHtml = '';
    if (state.replayInfo) {
      nxHtml += '▶ 前回の購入リストを再生中（' + (state.replayInfo.idx + 1) + '/' + state.replayInfo.total + '）: 次は ' + esc(state.replayInfo.label) + '<br>';
    }
    var shopOff = gmGet('ccauto_shopBuy', '1') !== '1';
    if (shopOff) {
      // v2.3.39: 購入OFFの間は目標・次に買うものを出さず、停止中とだけ表示する（古い計画が最新に見えないように）
      nxHtml = '<span style="color:#ffb27d;">ショップ自動購入 停止中</span>';
    } else if (state.goal1) {
      var bankNow = 0;
      try { bankNow = W.Game.cookies; } catch (e) { bankNow = 0; }
      var goalLine = function (tag, g) {
        var h = tag + ': ' + esc(g.label) + ' 達成率' + g.pct + '%' +
          (g.active ? ' <span style="color:#b6f09c;">← 遂行中</span>' : '');
        if (g.kind === 'set' && g.setNeed) {
          h += '<br><span style="color:#ffd98a;">' + (g.setAmt || 0) + '軒 / ' + g.setNeed + '軒</span>';
        }
        if (g.price > bankNow) {
          h += '<br><span style="color:#ffd98a;">あと ' + fmt(g.price - bankNow) + (g.etaSec > 0 ? '、約' + fmtDur(g.etaSec) : '') + '</span>';
        }
        return h;
      };
      nxHtml += goalLine('第1目標', state.goal1);
      if (state.goal2) nxHtml += '<br>' + goalLine('第2目標', state.goal2);
      else if (state.goalSaving) nxHtml += '<br>第2目標: なし（第1目標のために貯金中）';
      // 目標表示だけでは「実際は違うものを買っている」ことが分からないため、実際の動きも同じ欄に出す
      if (state.actualNext) {
        var an = state.actualNext;
        nxHtml += '<br>実際に次に買う: ' + esc(an.label) + '（' + fmt(an.price) + '）';
        if (an.mode === 'interim') nxHtml += '<br><span style="color:#ffd98a;">第1目標より先に買います</span>';
        else if (an.mode === 'candidate') nxHtml += '<br><span style="color:#ffd98a;">貯金の合間に買う候補（効率が勝れば先に買います）</span>';
      }
      if (state.lastInterim && state.lastInterim.goal === state.goal1.label) {
        var liD = new Date(state.lastInterim.at);
        var liT = ('0' + liD.getHours()).slice(-2) + ':' + ('0' + liD.getMinutes()).slice(-2);
        nxHtml += '<br>目標までの間に購入: ' + esc(state.lastInterim.label) + '（' + liT + '）';
      }
    } else {
      nxHtml = '次: ' + esc(state.nextTarget || '―') +
        (state.nextDetail ? '<br><span style="color:#ffd98a;">' + esc(state.nextDetail) + '</span>' : '');
    }
    nx.innerHTML = nxHtml;
    var barEl = document.getElementById('ccauto-bar');
    if (barEl) {
      var pct = 0;
      if (shopOff) {
        pct = 0;
      } else if (state.goal1) {
        // 進捗バーは「いま遂行中の目標」の達成率を表示する
        pct = (state.goalActive === 2 && state.goal2) ? state.goal2.pct : state.goal1.pct;
      } else if (gameReady() && state.targetPrice > 0) {
        pct = Math.min(100, Math.floor(W.Game.cookies / state.targetPrice * 100));
      }
      barEl.style.width = pct + '%';
    }
    var rps = panel.querySelectorAll('.ccauto-rp');
    for (var qi = 0; qi < rps.length; qi++) {
      rps[qi].style.background = (parseFloat(rps[qi].getAttribute('data-rate')) === clickRate()) ? '#7a5c14' : '';
      rps[qi].style.color = (parseFloat(rps[qi].getAttribute('data-rate')) === clickRate()) ? '#ffe9b0' : '';
    }
    var wkEl = document.getElementById('ccauto-wake');
    if (wkEl) {
      var wkOn = gmGet('ccauto_wake', '') !== '0';
      wkEl.textContent = !wkOn ? '💡 画面維持' : (wakeLockObj ? '💡 画面維持:ON' : '💡 画面維持:試行中');
    }
    // v2.3.39: 購入・昇天スイッチのラベル
    var sbEl = document.getElementById('ccauto-shopbuy');
    if (sbEl) sbEl.textContent = (gmGet('ccauto_shopBuy', '1') === '1') ? '🛒 購入:ON' : '🛒 購入:OFF';
    var asEl = document.getElementById('ccauto-ascend');
    if (asEl) {
      asEl.textContent = '🚀 自動昇天:' + (gmGet('ccauto_autoAscend', '1') === '1' ? 'ON' : 'OFF') + (ascendBusy() ? '（昇天中）' : '');
    }
    var zmEl = document.getElementById('ccauto-zoom');
    if (zmEl) zmEl.textContent = (zoomOk === false) ? '🔍 縮小非対応' : '🔍 表示:' + Math.round(pageZoom() * 100) + '%';
    lg.innerHTML = state.logs.slice(0, 12).map(function (s) {
      return s.replace(/</g, '&lt;');
    }).join('<br>');
  }

  /* ---------------- 新しい版の取り込み（v2.2.2） ----------------
     GitHub 上の最新版を定期的に確認し、新しい版があれば、ゲームの状態を残してから
     ページを再読み込みして取り込む（Tampermonkey 本体の更新確認を待たないため）。
     Tampermonkey 側にまだ新版が届いていない場合は再読み込みしても版が変わらないので、
     同じ版に対しては6時間あけて再試行し、再読み込みの繰り返しを防ぐ。 */
  var UPDATE_URL = 'https://raw.githubusercontent.com/domo0131/cookie-clicker-auto/main/cookie-clicker-auto.user.js';
  function parseRemoteVersion(text) {
    var m = /\/\/\s*@version\s+([0-9]+(?:\.[0-9]+)*)/.exec(text || '');
    return m ? m[1] : null;
  }
  function versionNewer(a, b) { // a が b より新しければ true
    var pa = ('' + a).split('.'), pb = ('' + b).split('.');
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
      if (d > 0) return true;
      if (d < 0) return false;
    }
    return false;
  }
  function checkForUpdate() {
    if (!gameReady() || isChallengePage()) return;
    if (tabState.decided && !tabState.primary) return; // 従タブは更新取り込みをしない（v2.3.30）
    if (ascendBusy()) return; // 自動昇天の途中で再読み込みしない
    if (typeof GM_xmlhttpRequest !== 'function') return;
    GM_xmlhttpRequest({
      method: 'GET',
      url: UPDATE_URL,
      timeout: 20000,
      onload: function (res) {
        if (!res || res.status !== 200) return;
        var rv = parseRemoteVersion(('' + (res.responseText || '')).slice(0, 4000));
        if (!rv) return;
        if (!versionNewer(rv, SCRIPT_VERSION)) {
          gmSet('ccauto_updateGuard', ''); // すでに最新なら試行ガードを解除する
          return;
        }
        var guard = null;
        try { guard = JSON.parse(gmGet('ccauto_updateGuard', '') || 'null'); } catch (e) { guard = null; }
        if (guard && guard.forVersion === rv && (Date.now() - (guard.at || 0)) < 6 * 3600 * 1000) return; // 取り込み試行済み。間隔をあけて再試行する
        // v2.3.30: 再読み込みの実行は3秒後に寄せ、その直前に主タブであることと
        // 昇天中でないことを再確認する。試行ガードは実際に再読み込みを要求する
        // 時点で立てる（延期だけで立てると、再確認がガードに弾かれるため）
        setTimeout(function () {
          if (!tabState.primary) return;
          var busy = false;
          try { busy = ascendBusy() || W.Game.OnAscend === 1 || (W.Game.AscendTimer || 0) > 0; } catch (e) { busy = false; }
          if (busy) { setTimeout(checkForUpdate, 60000); return; } // 昇天が終わってから取り込む
          var g2 = null;
          try { g2 = JSON.parse(gmGet('ccauto_updateGuard', '') || 'null'); } catch (e) { g2 = null; }
          if (g2 && g2.forVersion === rv && (Date.now() - (g2.at || 0)) < 6 * 3600 * 1000) return;
          gmSet('ccauto_updateGuard', JSON.stringify({ forVersion: rv, at: Date.now() }));
          log('新しいバージョン（' + rv + '）を取り込むため、保存して再読み込みします');
          try { gmSet('ccauto_preReloadSave', W.Game.WriteSave(1)); } catch (e2) { /* ignore */ } // 念のため直前のセーブを控える
          try { W.Game.WriteSave(); } catch (e5) { /* ignore */ } // 実保存（書き込みガードが所有者を照合する）
          try { reportStep(); } catch (e3) { /* ignore */ }
          traceEvent('reload-update');
          try { location.reload(); } catch (e4) { /* ignore */ }
        }, 3000);
      },
      onerror: function () { /* 取れなければ次の確認に回す */ },
      ontimeout: function () { /* 同上 */ }
    });
  }

  /* ---------------- 自動昇天（v2.3.0、ユーザー指示で自動化） ----------------
     流れ: バックアップ確定 → Game.Ascend(1) → 天界アップグレードを固定順に購入 →
     Permanent upgrade slot I に一番高い所有子猫を設定 → Game.Reincarnate(1)。
     状態は GM に永続化し、途中で再読み込みされたら二重実行せず「停止中」として報告する。
     画面判定は Game.OnAscend / Game.AscendTimer を使う（Game.ascensionMode は
     チャレンジモードの区別用なので使わない。ChatGPT相談 2026-11-13 の指摘に基づく）。 */

  // 購入順（名前, チップ費用の目安）。実際の費用は実行時に basePrice で照合する
  var ASCEND_PLAN = [
    ['Legacy', 1], ['Heavenly cookies', 3], ['How to bake your dragon', 9],
    ['Box of brand biscuits', 25], ['Tin of British tea biscuits', 25],
    ['Box of macarons', 25], ['Tin of butter cookies', 25],
    ['Starter kit', 50], ['Heavenly luck', 77], ['Permanent upgrade slot I', 100],
    ['Heralds', 100], ['Persistent memory', 500], ['Lasting fortune', 777]
  ];
  // ラッキー系の追加購入（出現条件があるため本プランとは分ける。発動条件のチップ合計には含めない）
  // [名前, チップ費用, 名声レベルの数字に必要な「7」の個数]
  var ASCEND_EXTRA_PLAN = [
    ['Lucky digit', 777, 1], ['Lucky number', 77777, 2], ['Lucky payout', 77778000, 4]
  ];
  // 名前の大文字小文字の表記ゆれで「未発見」にならないよう、小文字化して照合する
  function findUpgrade(G, name) {
    if (!G.Upgrades) return null;
    if (G.Upgrades[name]) return G.Upgrades[name];
    var low = ('' + name).toLowerCase();
    for (var k in G.Upgrades) { if (('' + k).toLowerCase() === low) return G.Upgrades[k]; }
    return null;
  }
  // 動的プラン（v2.3.22、ChatGPT相談）: 固定リストで買うものが無くなっても、昇天のたびに
  // プレスティージショップの未所持品を洗い出して買い続ける（プランを更新し続ける仕組み）。
  // 自動購入から外す品目: Sugar craving（砂糖玉を消費する仕組みに触れるため）
  var ASCEND_HEAVEN_EXCLUDE = ['Sugar craving'];
  // 最後に回す品目: Shimmering veil（クリックで割れるため、買う場合も一番最後）
  var ASCEND_HEAVEN_LAST = ['Shimmering veil'];
  var ASCEND_SLOT_ORDER = ['Permanent upgrade slot II', 'Permanent upgrade slot III', 'Permanent upgrade slot IV', 'Permanent upgrade slot V'];
  var ASCEND_ALL_SLOTS = ['Permanent upgrade slot I'].concat(ASCEND_SLOT_ORDER);
  function slotCountOwned(G) {
    var n = 0;
    for (var i = 0; i < ASCEND_ALL_SLOTS.length; i++) { var u = findUpgrade(G, ASCEND_ALL_SLOTS[i]); if (u && u.bought) n++; }
    return n;
  }
  // 優先順に並べた購入候補の一覧: コア13品目 → 条件を満たしたLucky系 → 永続枠II〜V → その他の未所持（安い順）
  // 天界アップグレードの効果文（スペースの購入記録用）: ゲーム内の説明から
  // フレーバーの台詞（<q>…）とタグを取り除いた実用部分だけを残す
  function heavenDescOf(up) {
    var d = '';
    try { d = String((up && up.desc) || ''); } catch (e) { d = ''; }
    var qi = d.indexOf('<q'); if (qi >= 0) d = d.slice(0, qi);
    d = d.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    return d.slice(0, 200);
  }

  // v2.3.34: v2.3.33 の着地より前に完了した昇天は heavenLog に残っていないため、
  // 前回フローの記録（ccauto_ascendLast）から1件分だけ復元する。価格と効果は現在の
  // ゲーム定義から引く（天界アップグレードの価格は固定）。重複判定は (run, at) の組で、
  // 既存エントリがあれば何もしない（冪等）。主タブの reportStep からのみ呼ばれる。
  function heavenLogBackfill() {
    var last = gmGet('ccauto_ascendLast', null);
    if (!last || typeof last.run !== 'number' || typeof last.at !== 'number' || !Array.isArray(last.bought)) return;
    var hl = gmGet('ccauto_heavenLog', []);
    if (!Array.isArray(hl)) hl = [];
    for (var i = 0; i < hl.length; i++) { if (hl[i] && hl[i].run === last.run && hl[i].at === last.at) return; }
    var G = W.Game;
    var items = [], spent = 0, incomplete = false;
    for (var bi = 0; bi < last.bought.length; bi++) {
      var nm = last.bought[bi];
      var up = null; try { up = findUpgrade(G, nm); } catch (e) { up = null; }
      if (up && up.pool === 'prestige' && typeof up.basePrice === 'number' && isFinite(up.basePrice)) {
        var pr = Math.ceil(up.basePrice);
        items.push({ name: nm, dname: (up.name && up.name !== nm) ? String(up.name) : '', price: pr, desc: heavenDescOf(up) });
        spent += pr;
      } else {
        items.push({ name: nm, dname: '', price: 0, desc: '', unresolved: true });
        incomplete = true;
      }
    }
    var ent = { run: last.run, at: last.at, spent: spent, bought: items, reconstructed: true };
    if (incomplete) ent.spentIncomplete = true;
    hl.push(ent);
    hl.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    if (hl.length > 15) hl.length = 15;
    gmSet('ccauto_heavenLog', hl);
  }

  function heavenlyCandidates(G, f) {
    var skip = (f && f.planSkip) || [];
    var out = [];
    var seen = {};
    function add(name, up, cost, tier) {
      if (!name || seen[name]) return;
      if (skip.indexOf(name) >= 0) return;
      seen[name] = 1;
      out.push({ name: name, up: up, cost: cost, tier: tier });
    }
    var i, up, nm;
    for (i = 0; i < ASCEND_PLAN.length; i++) {
      nm = ASCEND_PLAN[i][0]; up = findUpgrade(G, nm);
      if (up && !up.bought) add(nm, up, (typeof up.basePrice === 'number' ? up.basePrice : ASCEND_PLAN[i][1]), 1);
    }
    var sevenCount = (('' + Math.floor(G.prestige || 0)).match(/7/g) || []).length;
    for (i = 0; i < ASCEND_EXTRA_PLAN.length; i++) {
      nm = ASCEND_EXTRA_PLAN[i][0]; up = findUpgrade(G, nm);
      if (up && !up.bought && sevenCount >= ASCEND_EXTRA_PLAN[i][2]) add(nm, up, (typeof up.basePrice === 'number' ? up.basePrice : ASCEND_EXTRA_PLAN[i][1]), 2);
    }
    for (i = 0; i < ASCEND_SLOT_ORDER.length; i++) {
      nm = ASCEND_SLOT_ORDER[i]; up = findUpgrade(G, nm);
      if (up && !up.bought) add(nm, up, (typeof up.basePrice === 'number' ? up.basePrice : Infinity), 3);
    }
    var rest = [];
    try {
      for (var k in G.Upgrades) {
        var u2 = G.Upgrades[k];
        if (!u2 || u2.bought || u2.pool !== 'prestige') continue;
        if (seen[k] || skip.indexOf(k) >= 0) continue;
        if (ASCEND_HEAVEN_EXCLUDE.indexOf(k) >= 0) continue;
        rest.push({ name: k, up: u2, cost: (typeof u2.basePrice === 'number' ? u2.basePrice : Infinity), tier: 4 });
      }
    } catch (e) { /* ignore */ }
    rest.sort(function (a, b) { return a.cost - b.cost; });
    var lastOnes = [];
    for (i = 0; i < rest.length; i++) {
      if (ASCEND_HEAVEN_LAST.indexOf(rest[i].name) >= 0) lastOnes.push(rest[i]);
      else out.push(rest[i]);
    }
    for (i = 0; i < lastOnes.length; i++) out.push(lastOnes[i]);
    return out;
  }
  function skipFlowItem(f, name, reason) {
    f.skipped.push(name + '（' + reason + '）');
    f.planSkip = f.planSkip || [];
    if (f.planSkip.indexOf(name) < 0) f.planSkip.push(name);
    ascendSaveFlow(f);
  }
  // 周回ごとの発動チップ数（その周回で新規に獲得するチップ数）。4周目以降は計画の未購入分の合計
  var ASCEND_TARGETS = { 1: 940, 2: 2185, 3: 12301 };

  function ascendFlow() {
    try { var f = gmGet('ccauto_ascendFlow', null); return (f && f.phase) ? f : null; } catch (e) { return null; }
  }
  function ascendSaveFlow(f) { try { gmSet('ccauto_ascendFlow', f); } catch (e) { /* ignore */ } }
  function ascendBusy() {
    var f = ascendFlow();
    if (f && f.phase !== 'done' && f.phase !== 'stuck') return true;
    try { if (W.Game && W.Game.OnAscend === 1) return true; } catch (e) { /* ignore */ }
    return false;
  }
  // 「今昇天したら新規に得られるチップ数」。ゲーム自身の換算（HowMuchPrestige）を使い、
  // 過去周回累計 cookiesReset + 今周回 cookiesEarned のレベルから、確定済み prestige を引く。
  // 旧方式（今周回の稼ぎだけで三乗根）は実付与と大きくずれるため使わない
  // （2026-11-14 実測: 3周目で表示18,845に対し実績4,191。ChatGPT相談「チップ計算修正設計」）
  function pendingChips(G) {
    try {
      if (typeof G.HowMuchPrestige === 'function') {
        var lvl = Math.floor(G.HowMuchPrestige(Math.max(0, G.cookiesReset || 0) + Math.max(0, G.cookiesEarned || 0)));
        var gain = lvl - Math.floor(G.prestige || 0);
        if (isFinite(gain)) return Math.max(0, gain);
      }
    } catch (e) { /* フォールバックへ */ }
    // フォールバック: 保存済みの完了周回の totalEarned 合計から累計を再構成する
    try {
      var logArr = gmGet('ccauto_runLog', []);
      var cum = 0;
      if (Array.isArray(logArr)) { for (var i = 0; i < logArr.length; i++) cum += (logArr[i].totalEarned || 0); }
      return Math.max(0, prestigeLevelFor(cum + (G.cookiesEarned || 0)) - prestigeLevelFor(cum));
    } catch (e) { return 0; }
  }
  /* ================= 昇天タイミングの効率判定（v2.3.25・試験運用） =================
     ChatGPT相談「昇天規則の効率設計」の推奨: 固定の +20% ではなく、「今すぐ昇天」と
     「15分続けてから昇天」を、今から60分後の累計生産で比べる回収時間ベースの判定。
     v2.3.25 では実際の昇天は現行ルール（+20%＋ペース）が行い、新判定は影（シャドー）
     として結果をログと状態送信に残すだけ。判定に必要な「転生後の生産カーブ」は、
     完了した周回の1分ごとの実測（全期間累計クッキー）から作る */
  var effCache = null; // {at, data}: 直近の効率判定（状態送信に載せる）
  function recordCurveSample(G) {
    try {
      var resets = G.resets || 0;
      var cv = null;
      try { cv = gmGet('ccauto_runCurve', null); } catch (e) { cv = null; }
      var now = Date.now();
      if (!cv || cv.resets !== resets || !Array.isArray(cv.samples)) cv = { resets: resets, samples: [] };
      var last = cv.samples.length ? cv.samples[cv.samples.length - 1] : null;
      if (last && now - last[0] < 55000) return; // 約1分に1回
      var cum = 0;
      try { cum = (G.cookiesReset || 0) + (G.cookiesEarned || 0); } catch (e) { cum = 0; }
      if (!(cum > 0)) return;
      cv.samples.push([now, cum]);
      if (cv.samples.length > 3000) cv.samples = cv.samples.slice(cv.samples.length - 3000);
      gmSet('ccauto_runCurve', cv);
    } catch (e) { /* ignore */ }
  }
  function archiveRunCurve(completedRun, startPrestige) {
    try {
      var cv = gmGet('ccauto_runCurve', null);
      if (!cv || !Array.isArray(cv.samples) || cv.samples.length < 5) return;
      if ((cv.resets || 0) !== completedRun - 1) return; // 別周回のカーブは混ぜない
      var hist = [];
      try { hist = gmGet('ccauto_curveHist', []); } catch (e) { hist = []; }
      if (!Array.isArray(hist)) hist = [];
      hist.push({ run: completedRun, startPrestige: startPrestige, samples: cv.samples });
      if (hist.length > 3) hist = hist.slice(hist.length - 3);
      gmSet('ccauto_curveHist', hist);
    } catch (e) { /* ignore */ }
  }
  // 転生後の生産カーブ Y(t分, プレステージS) の推定: 過去の周回の実測カーブ（開始からの
  // 新規生産）を、プレステージ倍率 (1 + 0.01*S) の比で補正して中央値を取る。
  // 記録が t 分に届いていない周回は使わない（短い周回の外挿はしない）
  function estimateY(tMin, S) {
    var hist = [];
    try { hist = gmGet('ccauto_curveHist', []); } catch (e) { hist = []; }
    if (!Array.isArray(hist) || !hist.length) return null;
    var vals = [];
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i];
      if (!h || !Array.isArray(h.samples) || h.samples.length < 5) continue;
      var base = h.samples[0][1];
      var target = h.samples[0][0] + tMin * 60000;
      var cum = null;
      for (var j = 0; j < h.samples.length; j++) {
        if (h.samples[j][0] >= target) { cum = h.samples[j][1]; break; }
      }
      if (cum === null) continue;
      var scale = (1 + 0.01 * S) / (1 + 0.01 * (h.startPrestige || 0));
      vals.push((cum - base) * scale);
    }
    if (!vals.length) return null;
    vals.sort(function (a, b) { return a - b; });
    return vals[Math.floor(vals.length / 2)];
  }
  // 効率判定本体（影運用）: Y(60, S_now) >= 1.10 * (D15 + Y(45, S_wait)) が
  // 1分間隔で3回連続したら「今すぐ昇天が有利」。歯止め: 周回45分未満は判定しない、
  // バフ中は保留する（バフの延長価値は累計増分でしか測れず、外挿が暴れるため）
  function efficiencyVerdict(G) {
    var now = Date.now();
    if (effCache && now - effCache.at < 55000) return effCache.data;
    var data = { ready: false, why: '', streak: 0 };
    try {
      var tr = null;
      try { tr = gmGet('ccauto_runTrack', null); } catch (e) { tr = null; }
      var elapsedMin = (tr && tr.startedAt) ? (now - tr.startedAt) / 60000 : 0;
      data.elapsedMin = Math.round(elapsedMin);
      if (elapsedMin < 45) { data.why = '周回45分未満'; effCache = { at: now, data: data }; return data; }
      if (anyBuffActive()) { data.why = 'バフ中'; effCache = { at: now, data: data }; return data; }
      var cv = null;
      try { cv = gmGet('ccauto_runCurve', null); } catch (e) { cv = null; }
      if (!cv || !Array.isArray(cv.samples) || cv.samples.length < 21) { data.why = 'サンプル不足'; effCache = { at: now, data: data }; return data; }
      var samples = cv.samples;
      var cumNow = samples[samples.length - 1][1];
      function ratePerMin(min) {
        var from = now - min * 60000;
        var past = null;
        for (var i = samples.length - 1; i >= 0; i--) { if (samples[i][0] <= from) { past = samples[i]; break; } }
        if (!past) return null;
        var span = (samples[samples.length - 1][0] - past[0]) / 60000;
        if (span < min * 0.6) return null;
        return (cumNow - past[1]) / span;
      }
      var r10 = ratePerMin(10), r20 = ratePerMin(20);
      if (r10 === null && r20 === null) { data.why = 'レート不明'; effCache = { at: now, data: data }; return data; }
      var rate = Math.max(r10 || 0, r20 || 0); // 高い方: 一時的な減速での早切りを抑える
      var D15 = rate * 15;
      var C = 0;
      try { C = (G.cookiesReset || 0) + (G.cookiesEarned || 0); } catch (e) { C = cumNow; }
      var sNow = prestigeLevelFor(C);
      var sWait = prestigeLevelFor(C + D15);
      var yNow = estimateY(60, sNow);
      var y45 = estimateY(45, sWait);
      data.sNow = sNow; data.sWait = sWait;
      if (yNow === null || y45 === null) { data.why = 'カーブ不足'; effCache = { at: now, data: data }; return data; }
      var yWait = D15 + y45;
      data.yNow = Math.round(yNow); data.yWait = Math.round(yWait);
      data.ratio = Math.round((yNow / Math.max(1, yWait)) * 1000) / 1000;
      var raw = yNow >= 1.10 * yWait;
      var st = null;
      try { st = gmGet('ccauto_effStreak', null); } catch (e) { st = null; }
      if (!st || st.resets !== (G.resets || 0)) st = { resets: G.resets || 0, n: 0, logged: 0 };
      st.n = raw ? (st.n || 0) + 1 : 0;
      data.streak = st.n;
      data.ready = st.n >= 3;
      if (data.ready && !st.logged) {
        st.logged = 1;
        log('効率判定（試験）: 今すぐ昇天が有利と判定しました（60分予測: 今すぐ ' + fmt(yNow) + ' / 15分待ち ' + fmt(yWait) + '）');
      }
      try { gmSet('ccauto_effStreak', st); } catch (e) { /* ignore */ }
    } catch (e) { data.why = '判定エラー'; }
    effCache = { at: now, data: data };
    return data;
  }

  function chipsThisRun(G) { return pendingChips(G); }
  function ascendTargetFor(G) {
    var run = (G.resets || 0) + 1;
    var base;
    if (ASCEND_TARGETS[run]) { base = ASCEND_TARGETS[run]; }
    else {
      var sum = 0;
      for (var i = 0; i < ASCEND_PLAN.length; i++) {
        var up = findUpgrade(G, ASCEND_PLAN[i][0]);
        if (up && !up.bought) sum += ASCEND_PLAN[i][1];
      }
      base = Math.max(940, sum);
    }
    // 効率条件（ユーザー決定 2026-11-14）: 実績の増加分が現在プレステージの +20% に達することも必要。
    // 940個だけ（+3.7%程度）では再クライムの手間に見合わないため（ChatGPT相談に基づく）。
    var rel = Math.ceil(Math.max(0, Math.floor(G.prestige || 0)) * 0.20);
    return Math.max(base, rel);
  }
  function sampleChips(G, chips) {
    var now = Date.now();
    var arr = [];
    try { arr = gmGet('ccauto_chipSamples', []); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
    if (arr.length && now - arr[arr.length - 1].ts < 60000) return arr;
    arr.push({ ts: now, chips: chips, resets: G.resets || 0 });
    arr = arr.filter(function (s) { return s.resets === (G.resets || 0); }).slice(-90);
    try { gmSet('ccauto_chipSamples', arr); } catch (e) { /* ignore */ }
    return arr;
  }
  function paceFlattened(G, chips, target) {
    if (chips >= target * 1.5) return true; // 目標を大きく超えたら待ち続けない
    var arr = sampleChips(G, chips);
    var now = Date.now();
    // v2.3.29: 「50分以上前で最も古い標本」ではなく「50分前の境界に最も近い標本」を使う
    // （標本が毎分そろうと約89分前と比較してしまう問題の修正。ChatGPTレビューに基づく）
    var old = null, bestAge = Infinity;
    for (var i = 0; i < arr.length; i++) {
      var age = now - arr[i].ts;
      if (age >= 50 * 60000 && age < bestAge) { bestAge = age; old = arr[i]; }
    }
    if (!old) return false; // 観測が貯まるまでは昇天しない
    return (chips - old.chips) < chips * 0.05; // 直近の伸びが5%未満なら鈍化とみなす
  }
  function ascendStuck(f, msg) {
    f.phase = 'stuck';
    ascendSaveFlow(f);
    reportError('自動昇天を停止しました: ' + msg);
  }
  function ascendMaybeStart(G) {
    if (!state.running || state.mode !== 'auto') return;
    // 昇天の開始直前にも所有者を照合する（v2.3.30）: 主張を失っていたら始めない
    if (claimIsForeignFresh(tabClaimRead())) { tabSetRole(false); return; }
    if (G.OnAscend === 1 || (G.AscendTimer || 0) > 0) return;
    // 必要なAPIがそろっているか事前に確認する（無い版では始めない）
    if (typeof G.Ascend !== 'function' || typeof G.Reincarnate !== 'function' ||
        typeof G.WriteSave !== 'function' || !G.Upgrades || typeof G.OnAscend === 'undefined') {
      if (!gmGet('ccauto_ascendApiWarned', '')) {
        gmSet('ccauto_ascendApiWarned', SCRIPT_VERSION);
        reportError('自動昇天に必要な仕組みが見つからず、自動昇天は無効です');
      }
      return;
    }
    var chips = chipsThisRun(G);
    sampleChips(G, chips); // チップの観測は自動昇天OFFの間も続ける（ONに戻した直後の鈍化判定が古い標本にならないように。v2.3.39、ChatGPTレビュー）
    if (gmGet('ccauto_autoAscend', '1') !== '1') return; // ここから先は「新しい昇天を始めるか」の判定
    var target = ascendTargetFor(G);
    if (chips < target) return;
    if ((G.resets || 0) >= 1 && !paceFlattened(G, chips, target)) return; // 2周目以降は伸びが鈍ってから
    if (anyBuffActive() && chips < target * 1.5) return; // バフ中は延期（次回判定で再確認）。ただし目標の1.5倍を超えたらバフ中でも進める（バフが途切れない状態で待ち続けないため。ユーザー指示 2026-11-14）
    // 事前確認: 購入リストの名前がゲーム内に実在するか（表記違いで買えない事故の再発防止。周回ごとに1回だけ）
    var preKey = 'ccauto_ascendPreflight_' + (G.resets || 0);
    if (!gmGet(preKey, '')) {
      gmSet(preKey, '1');
      var missing = [];
      for (var qi = 0; qi < ASCEND_PLAN.length; qi++) { if (!findUpgrade(G, ASCEND_PLAN[qi][0])) missing.push(ASCEND_PLAN[qi][0]); }
      if (missing.length) reportError('自動昇天の事前確認: 次の項目がゲーム内に見つかりません（それ以外で進めます）: ' + missing.join('、'));
    }
    var sc = null;
    try { sc = G.WriteSave(1); } catch (e) { sc = null; }
    if (!sc || typeof sc !== 'string' || sc.length < 20) {
      reportError('自動昇天: バックアップが作れず開始しませんでした');
      return;
    }
    gmSet('ccauto_pendingSave', sc);
    recordFlush(); // v2.3.41: 昇天開始前にこの周回の購入記録を保存しきる（学習の採用材料）
    var f = {
      phase: 'backup', run: (G.resets || 0) + 1, startedAt: Date.now(),
      bought: [], failed: [], failedNames: [], skipped: [], idx: 0, planSkip: [],
      pendingCheck: '', retries: 0, slotKitten: '', chipsAtStart: chips,
      // v2.3.29: 確定チップの記録用に、開始時点の所持チップとプレステージを残す
      heavenlyBefore: Math.floor(G.heavenlyChips || 0), prestigeBefore: Math.floor(G.prestige || 0)
    };
    ascendSaveFlow(f);
    log('自動昇天: バックアップの送信確認をしてから昇天します（' + f.run + '周目、チップ ' + chips + ' 個）');
    try { reportStep(); } catch (e) { /* ignore */ }
  }
  function bestKitten(G) {
    var best = null;
    try {
      for (var name in G.Upgrades) {
        if (!/^Kitten /.test(name)) continue;
        var up = G.Upgrades[name];
        if (!up || !up.bought || up.pool === 'prestige') continue;
        if (!best || (up.basePrice || 0) > (best.basePrice || 0)) best = up;
      }
    } catch (e) { /* ignore */ }
    return best;
  }
  // 永久スロットの割り当て候補: 所持している通常アップグレードから、子猫系を価格の高い順に優先し、残りも価格順（ChatGPT相談）
  function slotCandidates(G, n) {
    var arr = [];
    try {
      for (var name in G.Upgrades) {
        var up = G.Upgrades[name];
        if (!up || !up.bought || up.pool === 'prestige') continue;
        arr.push(up);
      }
    } catch (e) { /* ignore */ }
    arr.sort(function (a, b) {
      var ak = /^Kitten /.test(a.name) ? 0 : 1, bk = /^Kitten /.test(b.name) ? 0 : 1;
      if (ak !== bk) return ak - bk;
      return (b.basePrice || 0) - (a.basePrice || 0);
    });
    return arr.slice(0, Math.max(0, n));
  }
  // 永久スロットの自己修復（v2.3.23）: 新しく買った永久スロットは、転生後にゲーム側の
  // 選択ダイアログが開いたまま残り、割り当ても空に見えることがある（2026-11-14 実測）。
  // 直前の昇天フローが記録した割り当て（ccauto_ascendLast.slot）を正として空きを埋め、
  // ダイアログが残っていれば閉じる（ダイアログはクリックを遮るため）
  function slotHeal(G) {
    try {
      if ((G.resets || 0) <= 0 || G.OnAscend === 1) return;
      var n = slotCountOwned(G);
      if (n <= 0 || !G.permanentUpgrades) return;
      var filled = [];
      var last = null;
      try { last = gmGet('ccauto_ascendLast', null); } catch (e) { last = null; }
      if (last && last.slot && Date.now() - (last.at || 0) < 30 * 60 * 1000) {
        var names = String(last.slot).split('、');
        var usedH = {};
        var hi;
        for (hi = 0; hi < n; hi++) { if (G.permanentUpgrades[hi]) usedH[G.permanentUpgrades[hi]] = 1; }
        for (hi = 0; hi < n; hi++) {
          if (G.permanentUpgrades[hi]) continue;
          for (var ni = 0; ni < names.length; ni++) {
            var upH = findUpgrade(G, names[ni]);
            if (upH && !usedH[upH.id]) {
              G.permanentUpgrades[hi] = upH.id;
              usedH[upH.id] = 1;
              filled.push(names[ni]);
              break;
            }
          }
        }
      }
      var promptEl = null;
      try { promptEl = document.getElementById('prompt'); } catch (e) { promptEl = null; }
      var slotPromptOpen = !!(promptEl && promptEl.textContent && promptEl.textContent.indexOf('永久に持続') >= 0);
      if (filled.length) {
        log('永久スロットの空きに ' + filled.join('、') + ' を割り当てました');
        var keyH = 'ccauto_slotHealNote_' + (G.resets || 0);
        if (!gmGet(keyH, '')) {
          gmSet(keyH, '1');
          reportError('永久スロットが空だったため自動で割り当てました: ' + filled.join('、'));
        }
      }
      if ((filled.length || slotPromptOpen) && typeof G.ClosePrompt === 'function') {
        try { G.ClosePrompt(); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }
  function ascendStep() {
    if (!tabState.primary) return; // 二重タブ防止: 従タブは昇天処理をしない
    if (!gameReady() || isChallengePage()) return;
    var G = W.Game;
    var f = ascendFlow();
    // 完了済みのフロー記録が残っていると、ここで永久に戻ってしまい次の開始判定に
    // たどり着けない。完了済みは周回番号によらず「フローなし」として扱う。
    // 番号で比べると、セーブの巻き戻しでゲームの周回が記録より少なく戻った場合に
    // 「未来の完了記録」が残り続け、再昇天が二度と始まらなくなる（2026-11-14 実発生）
    if (f && f.phase === 'done') f = null;
    if (!f) { slotHeal(G); recordCurveSample(G); efficiencyVerdict(G); ascendMaybeStart(G); return; }
    if (f.phase === 'done') return;
    if (f.phase === 'stuck') {
      // 再読み込みで止まった場合だけ、昇天が「実行されていない」と証明できれば復旧する。
      // 昇天画面にいるなら購入から再開、通常画面で何も買われていなければ最初からやり直す
      // v2.3.0 が理由を記録する前に止めた分も、購入が1件も進んでいなければ同じ扱いにする
      if (f.stuckReason !== 'reload' &&
          !(!f.stuckReason && !(f.bought || []).length && !(f.failed || []).length && !(f.skipped || []).length)) return;
      var planBought = false;
      for (var bi = 0; bi < ASCEND_PLAN.length; bi++) {
        var bup = findUpgrade(G, ASCEND_PLAN[bi][0]);
        if (bup && bup.bought) { planBought = true; break; }
      }
      if ((G.resets || 0) !== (f.run - 1) || planBought) return; // 状態が想定と違うので止めたまま
      if (G.OnAscend === 1) {
        f.phase = 'buy'; f.idx = 0; f.stuckReason = '';
        ascendSaveFlow(f);
        log('自動昇天: 昇天画面で購入から再開します');
      } else {
        var attKey = 'ccauto_ascendAttempts_' + f.run;
        var att = gmGet(attKey, 0);
        if (att >= 3) return; // やり直し上限。これ以上は止めたまま報告済みにする
        gmSet(attKey, att + 1);
        gmSet('ccauto_ascendFlow', null);
        log('自動昇天: 昇天が実行されていなかったため、最初からやり直します（' + (att + 1) + '回目）');
      }
      return;
    }

    if (f.phase === 'backup') {
      if (gmGet('ccauto_lastSaveRep', 0) > (f.startedAt || 0)) {
        f.phase = 'ascend'; ascendSaveFlow(f);
        log('自動昇天: バックアップ確認OK。昇天します');
        // このまま下の ascend 処理へ進み、同じ tick で昇天を呼ぶ（再読み込みの隙を減らす）
      } else if (Date.now() - (f.startedAt || 0) > 180000) {
        gmSet('ccauto_ascendFlow', null);
        reportError('自動昇天: バックアップの送信確認ができず中止しました');
        return;
      } else {
        return;
      }
    }
    if (f.phase === 'ascend') {
      if (!f.ascendCalled) {
        f.ascendCalled = 1; f.ascendAt = Date.now(); ascendSaveFlow(f);
        try { G.Ascend(1); } catch (e) { ascendStuck(f, '昇天の呼び出しでエラー: ' + e); }
        return;
      }
      if (G.OnAscend === 1) {
        f.phase = 'buy'; f.idx = 0; ascendSaveFlow(f);
        log('自動昇天: 昇天画面に到達。天界アップグレードを購入します');
      } else if (Date.now() - (f.ascendAt || 0) > 30000) {
        ascendStuck(f, '昇天画面に到達できませんでした（転生はしていません）');
      }
      return;
    }
    if (f.phase === 'buy') {
      // v2.3.29: 購入フェーズに入った直後（まだ何も買っていない時点）の所持チップから
      // 「この周回の確定獲得チップ」を記録する。従来の累計からの三乗根再構成は
      // 最終観測から昇天確定までの稼ぎを取りこぼすため（6周目で429の差が出た）
      if (typeof f.gainChips !== 'number' && typeof f.heavenlyBefore === 'number') {
        var gainNow = Math.floor(G.heavenlyChips || 0) - f.heavenlyBefore;
        if (gainNow >= 0) {
          f.gainChips = gainNow;
          try { gmSet('ccauto_lastGain', { run: f.run, gain: gainNow, at: Date.now() }); } catch (e) { /* ignore */ }
          ascendSaveFlow(f);
        }
      }
      if (f.pendingCheck) {
        var upc = findUpgrade(G, f.pendingCheck);
        if (upc && upc.bought) { f.bought.push(f.pendingCheck); f.pendingCheck = ''; }
        else if ((f.retries || 0) < 1) {
          f.retries = 1; ascendSaveFlow(f);
          try { if (upc) upc.buy(); } catch (e) { /* ignore */ }
          return;
        } else {
          f.failed.push(f.pendingCheck); f.failedNames.push(f.pendingCheck);
          f.planSkip = f.planSkip || [];
          if (f.planSkip.indexOf(f.pendingCheck) < 0) f.planSkip.push(f.pendingCheck);
          f.pendingCheck = ''; f.retries = 0;
        }
        ascendSaveFlow(f);
        return;
      }
      // 動的プラン（v2.3.22）: 毎tick候補を作り直し（親を買うと子が解禁されるため）、買える最優先の1件を買う
      var cands = heavenlyCandidates(G, f);
      if (!f.buyAnnounced) {
        f.buyAnnounced = 1;
        var totC = 0;
        for (var ai = 0; ai < cands.length; ai++) totC += (isFinite(cands[ai].cost) ? cands[ai].cost : 0);
        log('自動昇天: 購入プラン（未所持 ' + cands.length + ' 品目、合計 ' + fmt(totC) + ' チップ、所持 ' + fmt(G.heavenlyChips || 0) + '）');
        ascendSaveFlow(f);
      }
      var pick = null;
      for (var ci2 = 0; ci2 < cands.length; ci2++) { if ((G.heavenlyChips || 0) >= cands[ci2].cost) { pick = cands[ci2]; break; } }
      if (!pick) {
        // 買えるものが無くなったら次の段階へ（永続枠を持っていれば設定、なければ転生）
        f.phase = slotCountOwned(G) > 0 ? 'slot' : 'reincarnate';
        ascendSaveFlow(f);
        return;
      }
      var up2 = pick.up, name2 = pick.name;
      if (!up2) { skipFlowItem(f, name2, '未発見'); return; }
      if (up2.pool !== 'prestige') { skipFlowItem(f, name2, '対象外'); return; }
      var parentFailed = false;
      try {
        if (up2.parents && up2.parents.length) {
          for (var pi2 = 0; pi2 < up2.parents.length; pi2++) {
            var pn2 = up2.parents[pi2] && up2.parents[pi2].name;
            if (pn2 && f.failedNames.indexOf(pn2) >= 0) parentFailed = true;
          }
        }
      } catch (e) { /* ignore */ }
      if (parentFailed) { skipFlowItem(f, name2, '前提の購入失敗'); return; }
      if (typeof up2.canBuy === 'function' && !up2.canBuy()) {
        // 前提品が未購入で買えない場合は、買える前提品を先に買う（候補にあれば差し替え）
        var parentPick = null;
        try {
          if (up2.parents) {
            for (var pj = 0; pj < up2.parents.length; pj++) {
              var pu = up2.parents[pj];
              if (pu && !pu.bought) {
                for (var ck = 0; ck < cands.length; ck++) {
                  if (cands[ck].up === pu && (G.heavenlyChips || 0) >= cands[ck].cost) parentPick = cands[ck];
                }
              }
            }
          }
        } catch (e) { /* ignore */ }
        if (parentPick) { up2 = parentPick.up; name2 = parentPick.name; }
        else { skipFlowItem(f, name2, '未解放'); return; }
      }
      var cost2 = (typeof up2.basePrice === 'number') ? up2.basePrice : pick.cost;
      if ((G.heavenlyChips || 0) < cost2) { skipFlowItem(f, name2, 'チップ不足'); return; }
      // 購入明細を控える（スペースの昇天アップグレード記録用、v2.3.33）: 買う直前に名前・価格・効果を記録
      try {
        f.boughtDetail = f.boughtDetail || {};
        f.boughtDetail[name2] = { name: name2, dname: (up2.name && up2.name !== name2) ? String(up2.name) : '', price: cost2, desc: heavenDescOf(up2) };
      } catch (e) { /* ignore */ }
      try { up2.buy(); } catch (e) {
        f.failed.push(name2); f.failedNames.push(name2);
        f.planSkip = f.planSkip || [];
        if (f.planSkip.indexOf(name2) < 0) f.planSkip.push(name2);
        ascendSaveFlow(f);
        return;
      }
      f.pendingCheck = name2; f.retries = 0; ascendSaveFlow(f);
      return;
    }
    if (f.phase === 'slot') {
      // 全ての永続枠に割り当てる（v2.3.22で枠II以降にも対応。候補は子猫系を価格順に優先）
      var slotN = slotCountOwned(G);
      var candsS = slotCandidates(G, slotN);
      if (!candsS.length) {
        log('自動昇天: 設定できるアップグレードが無いため、永久スロットは空のまま進みます');
        f.phase = 'reincarnate'; ascendSaveFlow(f);
        return;
      }
      var allSet = true;
      for (var si = 0; si < candsS.length; si++) {
        if (!G.permanentUpgrades || G.permanentUpgrades[si] !== candsS[si].id) allSet = false;
      }
      if (allSet) {
        f.slotKitten = candsS.map(function (u) { return u.name; }).join('、');
        f.phase = 'reincarnate'; ascendSaveFlow(f);
        log('自動昇天: 永久スロットに ' + f.slotKitten + ' を設定しました');
        return;
      }
      if (!f.slotTried) {
        f.slotTried = 1;
        // 選択画面を開く方式は画面が開いたまま残ってしまうため、内部状態へ直接設定して次tickで検証する
        try {
          if (G.permanentUpgrades) { for (var sj = 0; sj < candsS.length; sj++) G.permanentUpgrades[sj] = candsS[sj].id; }
        } catch (e) { /* ignore */ }
        ascendSaveFlow(f);
        return;
      }
      // 直接設定でも一致しなければ、無理に進めず昇天画面で止める
      ascendStuck(f, '永久スロットの設定に失敗したため、昇天画面で停止しました（転生はしていません）');
      return;
    }
    if (f.phase === 'reincarnate') {
      if (!f.reinCalled) {
        f.reinCalled = 1; f.reinAt = Date.now(); f.resetsBefore = G.resets || 0; ascendSaveFlow(f);
        traceEvent('reincarnate-call');
        try { G.Reincarnate(1); } catch (e) { ascendStuck(f, '転生の呼び出しでエラー: ' + e); }
        return;
      }
      if ((G.resets || 0) > (f.resetsBefore || 0) && G.OnAscend === 0) {
        traceEvent('reincarnate-ok');
        f.phase = 'done'; f.completedAt = Date.now(); ascendSaveFlow(f);
        try { gmSet('ccauto_ascendAttempts_' + f.run, 0); } catch (e) { /* ignore */ }
        try { gmSet('ccauto_ascendLast', { at: f.completedAt, run: f.run, chips: f.chipsAtStart, bought: f.bought, failed: f.failed, skipped: f.skipped, slot: f.slotKitten }); } catch (e) { /* ignore */ }
        // 昇天アップグレードの購入記録を履歴として残す（スペース表示用、v2.3.33。新しい順、直近15回分）
        try {
          var hl = gmGet('ccauto_heavenLog', []);
          if (!Array.isArray(hl)) hl = [];
          var items = [], spent = 0;
          for (var bi = 0; bi < (f.bought || []).length; bi++) {
            var bn = f.bought[bi];
            var bd = (f.boughtDetail && f.boughtDetail[bn]) || { name: bn, dname: '', price: 0, desc: '' };
            items.push(bd); spent += (bd.price || 0);
          }
          hl.unshift({ run: f.run, at: f.completedAt, spent: spent, bought: items });
          if (hl.length > 15) hl.length = 15;
          gmSet('ccauto_heavenLog', hl);
        } catch (e) { /* ignore */ }
        log('自動昇天が完了しました（' + f.run + '周目終了、チップ ' + f.chipsAtStart + ' 個、購入 ' + f.bought.length + ' 件、見送り ' + f.skipped.length + ' 件）');
        // 購入リストの学習（v2.3.41）: 正常に終わった周回の購入実績を次回の再生リストに採用する。
        // 巻き戻しのあった周回・記録が欠けた周回は採用せず、救済購入の品はリストから外す
        try {
          var candRec = null;
          try { candRec = gmGet('ccauto_runRecord', null); } catch (eL) { candRec = null; }
          if (candRec && candRec.run === f.run && !candRec.overflow && !candRec.tainted && Array.isArray(candRec.events) && candRec.events.length >= 20) {
            var evsL = [];
            for (var li = 0; li < candRec.events.length; li++) { if (candRec.events[li].src !== 'rescue') evsL.push(candRec.events[li]); }
            if (evsL.length >= 20) {
              var prevList = null;
              try { prevList = gmGet('ccauto_replayList', null); } catch (eL2) { prevList = null; }
              if (prevList) { try { gmSet('ccauto_replayGood', prevList); } catch (eL3) { /* ignore */ } }
              var newList = { run: f.run, at: Date.now(), events: evsL };
              gmSet('ccauto_replayList', newList);
              replayListCache = newList;
              log('購入リストを学習しました（' + f.run + '周目の実績 ' + evsL.length + ' 件を次回の再生に使います）');
              try { traceEvent('replay-learn'); } catch (eL4) { /* ignore */ }
            }
          }
        } catch (eL5) { /* ignore */ }
        if (f.failed.length) reportError('自動昇天: 買えなかったものがあります: ' + f.failed.join('、'));
        if (slotCountOwned(G) > 0 && !(G.permanentUpgrades && G.permanentUpgrades[0])) {
          reportError('自動昇天: 永久スロットが空のまま終わりました');
        }
        try { reportStep(); } catch (e) { /* ignore */ }
      } else if (Date.now() - (f.reinAt || 0) > 30000) {
        ascendStuck(f, '転生の完了を確認できませんでした');
      }
      return;
    }
  }

  /* ---------------- 起動 ---------------- */

  // 共有状態の復旧は、主タブとして稼働を始める直前に一度だけ行う（v2.3.30で boot から移動）。
  // 従タブの起動処理が、主タブの購入検証マーカーや進行中の昇天フローを壊さないため
  var recoveryDone = false;
  function primaryRecovery() {
    if (recoveryDone) return;
    recoveryDone = true;
    // 以前の版で立った購入停止フラグは引き継がない（止まらない運用に変更したため）
    if (state.halted) { state.halted = false; gmSet('ccauto_halted', 0); }
    // 購入の検証が終わらないうちに再読み込みされた形跡があれば、検証マーカーを破棄して購入は続ける。
    // v2.3.35（ChatGPTレビューで B3 採用）: 通常の再読み込み（版の更新・引き継ぎ・自動復旧など）でも
    // 購入直後なら毎回起きるため、単発はパネルの検証メモに落とすだけにする。直近60分で3回以上
    // 破棄した場合だけ、リロードの繰り返しとして一度報告する（報告は最低60分間隔）
    if (gmGet('ccauto_pendingVerify', '')) {
      gmSet('ccauto_pendingVerify', '');
      var pvDropNow = Date.now();
      var pvHist = [];
      try { pvHist = gmGet('ccauto_pvDropHist', []); } catch (e) { pvHist = []; }
      if (!Array.isArray(pvHist)) pvHist = [];
      pvHist.push(pvDropNow);
      pvHist = pvHist.filter(function (t) { return typeof t === 'number' && (pvDropNow - t) < 60 * 60 * 1000; });
      try { gmSet('ccauto_pvDropHist', pvHist); } catch (e) { /* ignore */ }
      var pvLastReport = 0;
      try { pvLastReport = gmGet('ccauto_pvDropLastReport', 0) || 0; } catch (e) { pvLastReport = 0; }
      if (pvHist.length >= 3 && (pvDropNow - pvLastReport) >= 60 * 60 * 1000) {
        try { gmSet('ccauto_pvDropLastReport', pvDropNow); } catch (e) { /* ignore */ }
        reportError('購入検証の中断が直近60分で' + pvHist.length + '回発生しました（購入は継続します）');
      } else {
        log('検証メモ: 購入の検証が未完了のまま再読み込みされました（購入は継続します）');
      }
    }
    // 自動昇天の途中で再読み込みされた場合は、二重実行を避けて安全側に倒す
    var bootFlow = ascendFlow();
    if (bootFlow && bootFlow.phase !== 'done' && bootFlow.phase !== 'stuck') {
      if (bootFlow.phase === 'backup') {
        gmSet('ccauto_ascendFlow', null); // まだ何も始まっていないので破棄してよい
      } else {
        bootFlow.phase = 'stuck';
        bootFlow.stuckReason = 'reload'; // ascendStep 側で「昇天が実行されていない」と証明できれば復旧する
        ascendSaveFlow(bootFlow);
        reportError('自動昇天の途中で再読み込みされたため、安全のため停止しました');
      }
    }
  }

  // パンテオンの配置署名（購入→検証の間に配置が変わったら比較条件の変化として扱う）
  function pantheonSignature() {
    try {
      var t = W.Game.Objects['Temple'];
      var mg = t && t.minigame;
      if (!mg || !mg.gods) return '';
      var parts = [];
      for (var gid in mg.gods) {
        var g = mg.gods[gid];
        var psN = godSlotNum(g);
        if (psN !== null && psN >= 0) parts.push(gid + ':' + psN);
      }
      return parts.sort().join(',');
    } catch (e) { return ''; }
  }

  function boot() {
    if (isChallengePage()) {
      // 確認画面では何もしない（自動で解こうとしない・再読み込みしない）
      setTimeout(boot, 30000);
      return;
    }
    buildPanel();
    renderPanel();
    // 二重タブ防止（v2.3.23）: 主タブの選挙・維持と、ゲーム保存の遮断ガードの設置
    try {
      var bc = tabClaimRead();
      traceEvent('boot:' + TAB_ID.slice(-4) + ':' + (!bc ? 'noclaim' : (bc.id === TAB_ID ? 'ownclaim' : 'foreignclaim')));
    } catch (e) { /* ignore */ }
    tabElect();
    setInterval(tabHeartbeat, 5000);
    installSaveGuard();
    var guardTimer = setInterval(function () {
      if (installSaveGuard()) clearInterval(guardTimer);
    }, 1000);
    log('スクリプトを開始しました（モード: ' + state.mode + '）');
    // 共有状態の復旧（未完了検証の破棄・昇天フローの停止判定）は v2.3.30 で
    // primaryRecovery() へ移した。従タブの起動が主タブの状態を壊さないため、
    // 主タブとして稼働を始める直前にだけ実行する

    sampleClicks();
    setInterval(sampleClicks, 1000);
    // 購入はイベント駆動チェーンで回す（v2.3.22）: buyStep の戻り値が次の実行までの待ち時間
    setTimeout(function buyChain() {
      var d = 1000;
      try { d = buyStep(); } catch (e) { d = 1000; }
      setTimeout(buyChain, Math.max(30, Math.min(5000, d || 1000)));
    }, 1500);
    setInterval(ascendStep, 2000);
    setInterval(goldenStep, 1500);
    setInterval(spellStep, 2000);
    setInterval(renderPanel, 5000);
    try { requestAnimationFrame(frameWatch); } catch (e) { /* ignore */ } // v2.3.36: フレーム計測（カクつき切り分け用）
    setInterval(function () {
      if (tabState.primary) gmSet('ccauto_lastBeat', Date.now()); // 稼働時刻は主タブだけが更新する（v2.3.32）
      // 画面維持ロックがシステム側で外れていたら取り直す（可視状態のときだけ）
      if (gmGet('ccauto_wake', '') !== '0' && !wakeLockObj && !document.hidden) acquireWakeLock();
    }, 30000);
    state.lastReport = gmGet('ccauto_lastReport', '');
    setTimeout(reportStep, 15000);
    setInterval(reportStep, CONFIG.reportIntervalMs);
    setTimeout(checkForUpdate, 120000);
    setInterval(checkForUpdate, CONFIG.updateCheckMinutes * 60000);

    scheduleClicks();
    setInterval(clickWatchdog, 5000);
    if (state.running && clickRate() > 0) log('クリック設定を適用しました（' + clickRate() + '/秒）');
    if (gmGet('ccauto_wake', '') !== '0') acquireWakeLock();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && gmGet('ccauto_wake', '') !== '0' && !wakeLockObj) acquireWakeLock();
    });
    if (CONFIG.autoBackupHours > 0) {
      setInterval(function () {
        var last = gmGet('ccauto_lastBackup', 0);
        if (Date.now() - last >= CONFIG.autoBackupHours * 3600 * 1000) exportSave(false);
      }, 60000);
    }
  }

  /* ---------------- 読み込み待ちの立て直し ----------------
     ネットの一時的な不安定でゲームの読み込みが固まったままになったら、
     一定時間待っても読み込みが終わらないときに再読み込みして立て直す。
     連続するときは間隔を延ばす（15秒→60秒→180秒が上限）。確認画面では再読み込みしない。 */
  var loadWatchStartedAt = Date.now();
  var loadReadySince = 0;
  function loadWatchdog() {
    try {
      if (gameReady()) {
        // 読み込みが安定して続いたら、間隔延長の記録をリセットする（一瞬だけ復帰した場合は維持）
        if (!loadReadySince) loadReadySince = Date.now();
        if (Date.now() - loadReadySince >= 60000 && gmGet('ccauto_loadReload', '')) gmSet('ccauto_loadReload', '');
        return;
      }
    } catch (e) { /* ignore */ }
    loadReadySince = 0;
    if (isChallengePage()) return; // 確認画面では再読み込みしない
    var rec = null;
    try { rec = JSON.parse(gmGet('ccauto_loadReload', '') || 'null'); } catch (e) { rec = null; }
    if (!rec || typeof rec.count !== 'number') rec = { count: 0, at: 0 };
    var waitMs = Math.min(180000, 15000 * Math.pow(4, Math.min(rec.count, 3)));
    if (Date.now() - loadWatchStartedAt < waitMs) return;
    rec.count++; rec.at = Date.now();
    try { gmSet('ccauto_loadReload', JSON.stringify(rec)); } catch (e) { /* ignore */ }
    try { log('ゲームの読み込みが進まないため再読み込みします（待機 ' + Math.round(waitMs / 1000) + ' 秒超え、' + rec.count + ' 回目）'); } catch (e) { /* ignore */ }
    traceEvent('reload-watchdog');
    try { location.reload(); } catch (e) { /* ignore */ }
  }
  setInterval(loadWatchdog, 5000);

  // セーブ書き込みガードは boot の完了を待たず、ゲームが見えた時点ですぐに設置する（v2.3.32）
  var guardEarlyTimer = setInterval(function () { if (installSaveGuard()) clearInterval(guardEarlyTimer); }, 250);

  applyPageZoom(); // v2.3.42: 起動直後（boot の3秒待ちの前）に縮小を適用する

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(boot, 3000);
  } else {
    window.addEventListener('load', function () { setTimeout(boot, 3000); });
  }
})();
