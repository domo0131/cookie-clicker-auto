// ==UserScript==
// @name         Cookie Clicker 自動購入（Galaxy Tab専用機用）
// @namespace    muse.cookieclicker
// @version      2.3.14
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
    buyIntervalMs: 2000,     // 購入判断の間隔（ミリ秒）
    maxBatch: 1,             // 1回の判断で買う上限数（安全優先: 1件買って実測検証してから次へ）
    clickPerSecond: 2,       // 大クッキーの自動クリック回数/秒（0で無効）
    clickGolden: true,       // 黄金クッキーを自動でクリックするか（ホロボア配置中は設定に関係なく常に停止）
    saveUpSeconds: 600,      // （v2.0で「A→B／B→Aの順序比較」に置き換えたため未使用。互換のため残置）
    autoBackupHours: 0,      // セーブの自動書き出し間隔（時間）。0 = 自動では書き出さない（パネルのボタンで手動実行）
    logMax: 60,              // パネルに残す購入ログの件数
    reportSecret: '', // （v2.2.0で廃止）合言葉はコードに書かず、パネルの「🔑 合言葉設定」から保存する（公開リポジトリに載せないため）
    reportIntervalMs: 60000,  // 状態送信の間隔（ミリ秒）。送信先URLはパネルの「送信先設定」から保存する
    updateCheckMinutes: 10,   // 新しい版が出ていないか GitHub を確認する間隔（分）。新版があれば保存して再読み込みし、取り込む
    clickBudgetMs: 5         // クリック処理に1回のtickで使う時間の上限（ミリ秒）。ゲーム本体の処理を飢えさせないための制限
  };
  /* ====================================================================== */

  var SCRIPT_VERSION = '2.3.14'; // ヘッダーの @version と必ず揃えること（状態送信に含める）

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
  }

  function saveState() {
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
    renderPanel();
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

  function holoboreState() {
    // 'slotted'（配置中）/ 'none'（未配置で確定）/ 'unknown'（判定不能）の3状態。
    // 'none' のときだけ黄金クッキーをクリックしてよい。
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
  var upGainCache = {}; // name -> {dcps, dclick, at, ach, cps, bOwned, uOwned}
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
        if (simFailCount >= 3) {
          simDisabled = true;
          gmSet('ccauto_simDisabled', 1);
          upGainCache = {};
          reportError('全体系の効果測定で状態の不一致が続いたため、この測定方法だけを停止しました（購入は継続します）');
        } else {
          log('測定メモ: 全体系の復元照合で不一致（' + simFailCount + '回目）。今回の測定だけ無効にしました');
        }
      } else if (wild || achJump || driftFail) {
        dcps = 0; dclick = 0;
        log('測定メモ: 全体系の実測を無効にしました（' + (wild ? '異常値' : (achJump ? '実績増加' : '派生値のずれ')) + '）');
      } else {
        simFailCount = 0;
      }
    } catch (e) { dcps = 0; dclick = 0; }
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
  function simulatedBuildingGain(obj, cpsNow) {
    var name = obj.name;
    if (bSimDisabled || bSimOff[name]) return 0;
    var now = Date.now();
    var ach = achievementCount();
    var bOwned = 0, uOwned = 0;
    try { bOwned = W.Game.BuildingsOwned || 0; uOwned = W.Game.UpgradesOwned || 0; } catch (e) { /* ignore */ }
    var c = bGainCache[name];
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
      var failed = false, wild = false;
      obj.amount = amt0 + 1;
      // 派生カウンタ（所有建物数）も、そのフェーズの値に合わせてから再計算する（Cursor のボーナス計算が参照するため）
      try { G.BuildingsOwned = bOwned0 + 1; } catch (e8) { /* ignore */ }
      try {
        G.CalculateGains();
        gain = Math.max(0, storedSum() - sum0);
        // あり得ない大きさの増え方は測定が乱れたものとして捨てる（判断に使わない）
        var unit0 = 0;
        try { unit0 = unitCpsOf(obj) || 0; } catch (e6) { unit0 = 0; }
        if (gain > Math.max(sum0 * 0.25, unit0 * 30)) wild = true;
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
    bGainCache[name] = { gain: gain, at: now, ach: ach, cps: cpsNow, bOwned: bOwned, uOwned: uOwned };
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

  function doBuy(cand, quiet) {
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
    // 購入後検証の物差しは readProduction() に統一する（シミュレーションと同じ読み方）
    var prodBefore = null;
    try { prodBefore = readProduction(); } catch (e) { /* ignore */ }
    var cpsBefore = prodBefore ? prodBefore.cps : 0;
    var clickBefore = prodBefore ? prodBefore.click : 0;
    var writeVerify = !cand.noVerify; // 効果を再計算で検証できない購入（ゴールデンクッキー系）は検証を記録しない
    try {
      if (cand.kind === 'building') {
        var before = cand.ref.amount;
        cand.ref.buy(1);
        if (cand.ref.amount > before) {
          discTel.bSpend += cand.price || 0; // 割引系の評価用に支出を記録する
          upGainCache = {}; bGainCache = {}; // 購入が入ったら効果測定のキャッシュは捨て直す
          if (writeVerify) {
            state.pendingVerify = { label: cand.label, kind: cand.kind, gain: cand.gain || 0, cpsBefore: cpsBefore, clickBefore: clickBefore, achBefore: achievementsWon(), buffs: buffSignature(), rateAtBuy: preRate, predCps: preParts ? preParts.cps : null, predClick: preParts ? preParts.click : null };
            gmSet('ccauto_pendingVerify', state.pendingVerify); // 再読み込みで検証を飛ばさないよう永続化
          }
          if (!quiet) {
            log('購入: ' + cand.label + ' / ' + fmt(cand.price) + ' / 回収約' + Math.round(cand.payback / 360) / 10 + '時間');
            reportStep();
          }
          return true;
        }
      } else {
        cand.ref.buy();
        if (cand.ref.bought) {
          if (cand.kind === 'upgrade') discTel.upSpend += cand.price || 0; else discTel.bSpend += cand.price || 0; // 割引系の評価用に支出を記録する
          upGainCache = {}; bGainCache = {}; // 購入が入ったら効果測定のキャッシュは捨て直す
          if (writeVerify) {
            state.pendingVerify = { label: cand.label, kind: cand.kind, gain: cand.gain || 0, cpsBefore: cpsBefore, clickBefore: clickBefore, achBefore: achievementsWon(), buffs: buffSignature(), rateAtBuy: preRate, predCps: preParts ? preParts.cps : null, predClick: preParts ? preParts.click : null };
            gmSet('ccauto_pendingVerify', state.pendingVerify); // 再読み込みで検証を飛ばさないよう永続化
          }
          if (!quiet) {
            log('購入: ' + cand.label + ' / ' + fmt(cand.price) + ' / 回収約' + Math.round(cand.payback / 360) / 10 + '時間');
            reportStep();
          }
          return true;
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
  function sampleClicks() {
    try {
      if (!gameReady()) return;
      var now = Date.now();
      clickSamples.push([now, W.Game.cookieClicks || 0]);
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

  function buyStep() {
    if (!state.running || state.mode !== 'auto') return;
    if (!gameReady() || isChallengePage()) return;
    if (ascendBusy()) return; // 自動昇天の実行中は通常の購入を止める
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
        } else if (buffChanged || achChanged) {
          log('検証メモ: ' + pv.label + ' は比較条件の変化（' + (buffChanged ? 'バフ変化' : '実績変化') + '）のため判定しませんでした（予測 ' + fmt(Math.round(predV)) + ' → 実測 ' + fmt(Math.round(measured)) + partsTxt + '）');
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
    var G = W.Game;
    var boughtCounts = {};
    var boughtTotal = 0;
    // 1回の判断で、回収効率を毎回判定し直しながら最大 maxBatch 個までまとめ買いする
    for (var step = 0; step < CONFIG.maxBatch; step++) {
      var ev = evaluateCandidates();
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
      if (!doBuy(buyCand, true)) break;
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
      boughtCounts[countKey].n++;
      boughtCounts[countKey].spent += Math.max(0, bankB - G.cookies);
    }
    if (boughtTotal > 0) {
      var parts = [];
      for (var k in boughtCounts) {
        parts.push(k + (boughtCounts[k].n > 1 ? ' ×' + boughtCounts[k].n : '') + '（' + fmt(boughtCounts[k].spent) + '）');
      }
      log('購入: ' + parts.join(' / '));
      reportStep();
    }
    renderPanel();
  }

  /* ---------------- クリック ---------------- */

  function clickRate() {
    var v = parseFloat(gmGet('ccauto_clickRate', ''));
    if (isNaN(v)) v = CONFIG.clickPerSecond;
    if (v < 0) v = 0;
    if (v > 250) v = 250; // ゲーム側のクリック計数上限が約250/秒のため
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
      visualAcc = Math.min(8, visualAcc + VISUAL_CLICKS_PER_SEC * elapsedMs / 1000);
    }
    clickLastAt = now;
    var n = Math.floor(clickAcc);
    if (n <= 0) return;
    // 1tickあたりの時間予算の中でまとめて叩く。予算を超えたら残りは次tickへ回し、
    // ゲーム本体（生産・描画・保存）の処理を飢えさせない。
    var t0 = Date.now();
    var done = 0;
    while (done < n) {
      try {
        // 一部だけ画面クリック（数字が見える）、残りはAPIで補って全体の速度を保つ
        if (visualAcc >= 1) { clickBigCookie(); visualAcc -= 1; }
        else { W.Game.ClickCookie(); }
      } catch (e) { break; }
      done++;
      if ((done & 3) === 0 && Date.now() - t0 >= CONFIG.clickBudgetMs) break;
    }
    clickAcc -= done;
    if (clickAcc > r) clickAcc = r; // 溜め込みは最大で設定値の1秒ぶんまで
    if (clickAcc < 0) clickAcc = 0;
  }

  // クリックの見張り: 再読み込みなどでタイマーが止まったままになっていたら張り直す
  var clickWatchLast = -1, clickWatchFlatAt = 0;
  function clickWatchdog() {
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
    if (resets > tr.resets) {
      // 昇天があった: 前の周回を確定して記録する（複数回まとめて起きた場合は合算の1件として残す）
      var logArr = [];
      try { logArr = gmGet('ccauto_runLog', []); } catch (e) { logArr = []; }
      if (!Array.isArray(logArr)) logArr = [];
      var chips = Math.floor(Math.cbrt(Math.max(0, tr.lastTotal || 0) / 1e12));
      logArr.push({
        run: tr.resets + 1,
        chips: chips,
        durationSec: Math.max(0, Math.round((now - (tr.startedAt || now)) / 1000)),
        peakCps: Math.round(tr.peakCps || 0),
        totalEarned: Math.round(tr.lastTotal || 0),
        endedAt: now
      });
      if (logArr.length > 50) logArr = logArr.slice(logArr.length - 50);
      try { gmSet('ccauto_runLog', logArr); } catch (e) { /* ignore */ }
      tr = { resets: resets, startedAt: now, peakCps: 0, lastTotal: 0 };
    }
    if (cpsNow > (tr.peakCps || 0)) tr.peakCps = cpsNow;
    if (totalEarned > 0) tr.lastTotal = totalEarned;
    try { gmSet('ccauto_runTrack', tr); } catch (e) { /* ignore */ }
    var runLogArr = [];
    try { runLogArr = gmGet('ccauto_runLog', []); } catch (e) { runLogArr = []; }
    return {
      resets: resets,
      runs: Array.isArray(runLogArr) ? runLogArr : [],
      current: {
        run: resets + 1,
        startedAt: tr.startedAt || now,
        peakCps: Math.round(tr.peakCps || 0),
        chipsNow: Math.floor(Math.cbrt(Math.max(0, totalEarned || 0) / 1e12))
      }
    };
  }

  function collectStatus() {
    var G = W.Game;
    var buildings = [];
    for (var k in G.Objects) {
      var o = G.Objects[k];
      buildings.push({
        name: o.name, count: o.amount || 0,
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
      mode: state.mode, running: state.running, lastAction: state.lastAction || '',
      recentLogs: (state.logs || []).slice(0, 15)
    };
    status.scriptVersion = SCRIPT_VERSION;
    // 周回（昇天）の記録: 昇天回数・完了した周回の一覧・進行中の周回の状態
    try {
      var runInfo = trackRun(G, status.cps || status.cpsRaw || 0, status.totalEarned || 0);
      status.resets = runInfo.resets;
      status.runs = runInfo.runs;
      status.runCurrent = runInfo.current;
    } catch (e) { /* ignore */ }
    try {
      var evD = evaluateCandidates();
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
          next: state.actualNext || null,
          last: (state.lastInterim && topD && state.lastInterim.goal === topD.label) ? state.lastInterim : null
        }
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
    return status;
  }

  function reportSecret() { return gmGet('ccauto_reportSecret', ''); }

  var lastSentSave = '';
  var reportInFlight = false;
  function reportStep() {
    if (reportInFlight) return; // 通信中は重ねて送らない（受信側での競合・重複を防ぐ）
    if (!gameReady() || isChallengePage()) return;
    if (typeof GM_xmlhttpRequest !== 'function') return;
    var url = gmGet('ccauto_reportUrl', '');
    if (!url) return; // 送信先URLが未設定なら何もしない（パネルから設定する）
    if (!reportSecret()) return; // 合言葉が未設定なら送らない（パネルの🔑から設定する）
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
          reportInFlight = false;
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
          reportInFlight = false;
          var msg = '送信に失敗しました（通信エラー）';
          if (state.logs[0] !== msg) log(msg);
          renderPanel();
        },
        ontimeout: function () {
          reportInFlight = false;
          var msg = '送信に失敗しました（時間切れ）';
          if (state.logs[0] !== msg) log(msg);
          renderPanel();
        }
      });
    } catch (e) { reportInFlight = false; }
  }

  function reportTest() {
    // 送信の切り分け用：各段階の結果をログに残す（通常の送信は無言）
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
      var z = (gmGet('ccauto_zoom', '') === '0.9') ? '' : '0.9';
      gmSet('ccauto_zoom', z);
      try { document.body.style.zoom = z; } catch (e) { /* ignore */ }
      log(z ? '画面を90%に縮小しました' : '画面の縮小を解除しました');
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
      var on = gmGet('ccauto_wake', '') === '1';
      gmSet('ccauto_wake', on ? '' : '1');
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
    try { document.body.style.zoom = gmGet('ccauto_zoom', ''); } catch (e) { /* ignore */ }
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

  function renderPanel() {
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
    panel.style.maxWidth = mini ? '240px' : '270px';
    var modeLabel = (state.mode === 'auto') ? '自動購入' : '読み取り専用';
    var runLabel = state.halted ? '購入停止中（異常検知）' : (state.running ? '稼働中' : '停止中');
    var statsTxt = '';
    if (gameReady()) {
      statsTxt = '所持 ' + fmt(W.Game.cookies) + ' / CpS ' + fmt(baseCps()) +
        ' / 👆' + (clickRate() > 0 ? clickRate() + '/秒（実測' + Math.round(measuredClickRate()) + '）' : 'オフ');
      if (!state.nextTarget) {
        try {
          var ev = evaluateCandidates();
          if (ev.list.length) {
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
    st.textContent = runLabel + '（' + modeLabel + '）' + rep;
    st.style.color = state.running ? '#b6f09c' : '#ffb27d';
    st.style.fontWeight = 'bold';
    var statsEl = document.getElementById('ccauto-stats');
    if (statsEl) statsEl.textContent = statsTxt;
    var esc = function (s) { return ('' + s).replace(/</g, '&lt;'); };
    var nxHtml = '';
    if (state.goal1) {
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
      if (state.goal1) {
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
      var wkOn = gmGet('ccauto_wake', '') === '1';
      wkEl.textContent = !wkOn ? '💡 画面維持' : (wakeLockObj ? '💡 画面維持:ON' : '💡 画面維持:試行中');
    }
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
        var now = Date.now();
        if (guard && guard.forVersion === rv && (now - (guard.at || 0)) < 6 * 3600 * 1000) return; // 取り込み試行済み。間隔をあけて再試行する
        gmSet('ccauto_updateGuard', JSON.stringify({ forVersion: rv, at: now }));
        log('新しいバージョン（' + rv + '）を取り込むため、保存して再読み込みします');
        try { gmSet('ccauto_preReloadSave', W.Game.WriteSave(1)); } catch (e2) { /* ignore */ } // 念のため直前のセーブを控える
        try { reportStep(); } catch (e3) { /* ignore */ }
        setTimeout(function () { try { location.reload(); } catch (e4) { /* ignore */ } }, 3000);
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
  function chipsThisRun(G) {
    var t = 0;
    try { t = G.cookiesEarned || 0; } catch (e) { t = 0; }
    return Math.floor(Math.cbrt(Math.max(0, t) / 1e12));
  }
  function ascendTargetFor(G) {
    var run = (G.resets || 0) + 1;
    if (ASCEND_TARGETS[run]) return ASCEND_TARGETS[run];
    var sum = 0;
    for (var i = 0; i < ASCEND_PLAN.length; i++) {
      var up = findUpgrade(G, ASCEND_PLAN[i][0]);
      if (up && !up.bought) sum += ASCEND_PLAN[i][1];
    }
    return Math.max(940, sum);
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
    var old = null;
    for (var i = 0; i < arr.length; i++) { if (now - arr[i].ts >= 50 * 60000) { old = arr[i]; break; } }
    if (!old) return false; // 観測が貯まるまでは昇天しない
    return (chips - old.chips) < chips * 0.05; // 直近の伸びが5%未満なら鈍化とみなす
  }
  function ascendStuck(f, msg) {
    f.phase = 'stuck';
    ascendSaveFlow(f);
    reportError('自動昇天を停止しました: ' + msg);
  }
  function ascendMaybeStart(G) {
    if (gmGet('ccauto_autoAscend', '1') !== '1') return;
    if (!state.running || state.mode !== 'auto') return;
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
    sampleChips(G, chips);
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
    var f = {
      phase: 'backup', run: (G.resets || 0) + 1, startedAt: Date.now(),
      bought: [], failed: [], failedNames: [], skipped: [], idx: 0,
      pendingCheck: '', retries: 0, slotKitten: '', chipsAtStart: chips
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
  function ascendStep() {
    if (!gameReady() || isChallengePage()) return;
    var G = W.Game;
    var f = ascendFlow();
    // 前の周回で完了したフロー記録が残っていると、ここで永久に戻ってしまい
    // 2周目以降の開始判定に一生たどり着けない。完了済みで自分の周回より前のものは「フローなし」として扱う
    if (f && f.phase === 'done' && (f.run || 0) <= (G.resets || 0)) f = null;
    if (!f) { ascendMaybeStart(G); return; }
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
      if (f.pendingCheck) {
        var upc = findUpgrade(G, f.pendingCheck);
        if (upc && upc.bought) { f.bought.push(f.pendingCheck); f.pendingCheck = ''; }
        else if ((f.retries || 0) < 1) {
          f.retries = 1; ascendSaveFlow(f);
          try { if (upc) upc.buy(); } catch (e) { /* ignore */ }
          return;
        } else {
          f.failed.push(f.pendingCheck); f.failedNames.push(f.pendingCheck);
          f.pendingCheck = ''; f.retries = 0;
        }
        ascendSaveFlow(f);
        return;
      }
      if (f.idx >= ASCEND_PLAN.length) {
        // 本プランが終わったら、ラッキー系の追加購入を試す（条件がそろったときだけ買う）
        if (!f.inExtras) { f.inExtras = 1; f.xidx = 0; ascendSaveFlow(f); return; }
        if ((f.xidx || 0) < ASCEND_EXTRA_PLAN.length) {
          var xitem = ASCEND_EXTRA_PLAN[f.xidx]; f.xidx++;
          var xname = xitem[0];
          var xup = findUpgrade(G, xname);
          if (!xup) { ascendSaveFlow(f); return; } // 追加分は未発見でも失敗にしない
          if (xup.bought) { f.bought.push(xname); ascendSaveFlow(f); return; }
          // 出現条件: 昇天後の名声レベルの数字に「7」が一定個数含まれること（ゲーム側の仕様）
          var sevenCount = (('' + Math.floor(G.prestige || 0)).match(/7/g) || []).length;
          if (sevenCount < xitem[2]) { f.skipped.push(xname + '（出現条件未達）'); ascendSaveFlow(f); return; }
          if (typeof xup.canBuy === 'function' && !xup.canBuy()) { f.skipped.push(xname + '（未解放）'); ascendSaveFlow(f); return; }
          var xcost = (typeof xup.basePrice === 'number') ? xup.basePrice : xitem[1];
          if ((G.heavenlyChips || 0) < xcost) { f.skipped.push(xname + '（チップ不足）'); ascendSaveFlow(f); return; }
          try { xup.buy(); } catch (e) { f.skipped.push(xname + '（購入失敗）'); ascendSaveFlow(f); return; }
          f.pendingCheck = xname; f.retries = 0; ascendSaveFlow(f);
          return;
        }
        var slotUp = findUpgrade(G, 'Permanent upgrade slot I');
        f.phase = (slotUp && slotUp.bought) ? 'slot' : 'reincarnate';
        ascendSaveFlow(f);
        return;
      }
      var item = ASCEND_PLAN[f.idx]; f.idx++;
      var name = item[0];
      var up = findUpgrade(G, name);
      if (!up) { f.failed.push(name + '（未発見）'); f.failedNames.push(name); ascendSaveFlow(f); return; }
      if (up.bought) { f.bought.push(name); ascendSaveFlow(f); return; }
      if (up.pool !== 'prestige') { f.failed.push(name + '（対象外）'); f.failedNames.push(name); ascendSaveFlow(f); return; }
      var parentFailed = false;
      try {
        if (up.parents && up.parents.length) {
          for (var pi = 0; pi < up.parents.length; pi++) {
            var pn = up.parents[pi] && up.parents[pi].name;
            if (pn && f.failedNames.indexOf(pn) >= 0) parentFailed = true;
          }
        }
      } catch (e) { /* ignore */ }
      if (parentFailed) { f.skipped.push(name + '（前提の購入失敗）'); ascendSaveFlow(f); return; }
      if (typeof up.canBuy === 'function' && !up.canBuy()) { f.skipped.push(name + '（未解放）'); ascendSaveFlow(f); return; }
      var cost = (typeof up.basePrice === 'number') ? up.basePrice : item[1];
      if ((G.heavenlyChips || 0) < cost) { f.skipped.push(name + '（チップ不足）'); ascendSaveFlow(f); return; }
      try { up.buy(); } catch (e) {
        f.failed.push(name); f.failedNames.push(name); ascendSaveFlow(f); return;
      }
      f.pendingCheck = name; f.retries = 0; ascendSaveFlow(f);
      return;
    }
    if (f.phase === 'slot') {
      var kitten = bestKitten(G);
      if (!kitten) {
        log('自動昇天: 設定できる子猫アップグレードが無いため、永久スロットは空のまま進みます');
        f.phase = 'reincarnate'; ascendSaveFlow(f);
        return;
      }
      if (G.permanentUpgrades && G.permanentUpgrades[0] === kitten.id) {
        f.slotKitten = kitten.name; f.phase = 'reincarnate'; ascendSaveFlow(f);
        log('自動昇天: 永久スロットに ' + kitten.name + ' を設定しました');
        return;
      }
      if (!f.slotTried) {
        f.slotTried = 1;
        // 選択画面を開く方式は画面が開いたまま残ってしまうため、内部状態へ直接設定して次tickで検証する
        try { if (G.permanentUpgrades) G.permanentUpgrades[0] = kitten.id; } catch (e) { /* ignore */ }
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
        try { G.Reincarnate(1); } catch (e) { ascendStuck(f, '転生の呼び出しでエラー: ' + e); }
        return;
      }
      if ((G.resets || 0) > (f.resetsBefore || 0) && G.OnAscend === 0) {
        f.phase = 'done'; f.completedAt = Date.now(); ascendSaveFlow(f);
        try { gmSet('ccauto_ascendAttempts_' + f.run, 0); } catch (e) { /* ignore */ }
        try { gmSet('ccauto_ascendLast', { at: f.completedAt, run: f.run, chips: f.chipsAtStart, bought: f.bought, failed: f.failed, skipped: f.skipped, slot: f.slotKitten }); } catch (e) { /* ignore */ }
        log('自動昇天が完了しました（' + f.run + '周目終了、チップ ' + f.chipsAtStart + ' 個、購入 ' + f.bought.length + ' 件、見送り ' + f.skipped.length + ' 件）');
        if (f.failed.length) reportError('自動昇天: 買えなかったものがあります: ' + f.failed.join('、'));
        var slotUpDone = findUpgrade(G, 'Permanent upgrade slot I');
        if (slotUpDone && slotUpDone.bought && !(G.permanentUpgrades && G.permanentUpgrades[0])) {
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

  function boot() {
    if (isChallengePage()) {
      // 確認画面では何もしない（自動で解こうとしない・再読み込みしない）
      setTimeout(boot, 30000);
      return;
    }
    buildPanel();
    renderPanel();
    log('スクリプトを開始しました（モード: ' + state.mode + '）');
    // 以前の版で立った購入停止フラグは引き継がない（止まらない運用に変更したため）
    if (state.halted) { state.halted = false; gmSet('ccauto_halted', 0); }
    // 購入の検証が終わらないうちに再読み込みされた形跡があれば、報告だけして購入は続ける
    if (gmGet('ccauto_pendingVerify', '')) {
      gmSet('ccauto_pendingVerify', '');
      reportError('購入の検証が未完了のまま再読み込みされました（購入は継続します）');
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

    sampleClicks();
    setInterval(sampleClicks, 1000);
    setInterval(buyStep, CONFIG.buyIntervalMs);
    setInterval(ascendStep, 2000);
    setInterval(goldenStep, 1500);
    setInterval(renderPanel, 5000);
    setInterval(function () { gmSet('ccauto_lastBeat', Date.now()); }, 30000);
    gmSet('ccauto_lastBeat', Date.now());
    state.lastReport = gmGet('ccauto_lastReport', '');
    setTimeout(reportStep, 15000);
    setInterval(reportStep, CONFIG.reportIntervalMs);
    setTimeout(checkForUpdate, 120000);
    setInterval(checkForUpdate, CONFIG.updateCheckMinutes * 60000);

    scheduleClicks();
    setInterval(clickWatchdog, 5000);
    if (state.running && clickRate() > 0) log('クリック設定を適用しました（' + clickRate() + '/秒）');
    if (gmGet('ccauto_wake', '') === '1') acquireWakeLock();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && gmGet('ccauto_wake', '') === '1' && !wakeLockObj) acquireWakeLock();
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
    try { location.reload(); } catch (e) { /* ignore */ }
  }
  setInterval(loadWatchdog, 5000);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(boot, 3000);
  } else {
    window.addEventListener('load', function () { setTimeout(boot, 3000); });
  }
})();
