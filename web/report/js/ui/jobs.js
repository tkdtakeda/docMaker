/* =========================================================
   js/ui/jobs.js : 処理の進み具合の表示（基本設計 1-14・1-19〜1-21）
   ── 進み具合の表示（progressView） ──
     どの画面にも置ける 1 処理ぶんの表示。状態（アイコン＋文字＋色）・工程 n / m・バー・件数と経過・
     停止の可能性・待機の理由・中止・完了後の結果を出す。終わっても消さずに結果を残す
   ── 上部バーの「実行中」 ──
     画面やモーダルを切り替えても処理を見失わないように、上部バーに要約を出し、押すと一覧を開く
   状態は CDB.jobs が持つ。ここは描くだけ
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const UI = CDB.ui;
  const { el, icon, fmt } = U;
  const JB = CDB.jobs;

  const p2 = (n) => String(n).padStart(2, '0');
  /** 経過時間 00:18 ／ 1:02:03 */
  function elapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    return (h ? h + ':' : '') + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60);
  }
  /** 時刻 14:32:18 */
  function clock(ts) {
    const d = new Date(ts);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  }
  function cssMs(name, fallback) {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
    return Number.isFinite(v) ? v : fallback;
  }

  /** 件数の要約（対象・成功・除外・失敗） */
  function countsText(c) {
    if (!c) return '';
    const u = c.unit || '件';
    const parts = [];
    if (c.target !== undefined) parts.push(`対象 ${fmt(c.target)} ${u}`);
    if (c.ok !== undefined) parts.push(`成功 ${fmt(c.ok)} ${u}`);
    if (c.excluded) parts.push(`除外 ${fmt(c.excluded)} ${u}`);
    if (c.failed) parts.push(`失敗 ${fmt(c.failed)} ${u}`);
    return parts.join('・');
  }

  /** 状態の札（アイコン＋文字＋色） */
  function stateBadge(stateKey, extraText) {
    const s = JB.STATES[stateKey] || JB.STATES.idle;
    return el('span', { class: 'badge job-badge is-tone-' + s.tone }, [icon(s.icon), extraText || s.label]);
  }

  /* ── 進み具合の表示 ── */
  const views = new Set();
  const MANY_STEPS = 5; // これより工程が多いときは、一覧を折りたたむ
  const STEP_ICON = { done: 'fa-check', doing: 'fa-circle-dot', todo: 'fa-circle', skip: 'fa-minus', stop: 'fa-circle-stop', err: 'fa-xmark' };

  /**
   * @param {object} api CDB.jobs.start の戻り値
   * @param {{compact?:boolean, onReveal?:Function}} [opt]
   */
  function progressView(api, opt) {
    const o = opt || {};
    const node = el('div', { class: 'job' + (o.compact ? ' is-compact' : ''), role: 'status', 'aria-live': 'polite' });
    const view = { api, node, o };
    views.add(view);
    paintView(view);
    ensureTick();
    return node;
  }

  /** 状態が変わっていなければ、経過時間などの文字だけを差し替える（ボタンを作り直さない） */
  function paintView(view) {
    const j = view.api.job;
    const vs = JB.viewState(j, Date.now());
    // 件数・割合が変わっただけなら、バーと文字だけを書き換える（中止ボタンを押しそこねないように）
    const sig = [vs, j.stepIdx, !!j.total, j.ended, j.steps.map((x) => x.status).join(',')].join('|');
    if (sig === view.sig) {
      const live = view.node.querySelector('.job-meta.is-live');
      if (live) live.textContent = metaText(j, Date.now());
      const bar = view.node.querySelector('.progress');
      if (bar && j.total) {
        const pct = Math.min(100, Math.floor(j.done / j.total * 100));
        bar.firstChild.style.width = pct + '%';
        bar.setAttribute('aria-valuenow', String(pct));
      }
      return;
    }
    view.sig = sig;
    fullPaint(view);
  }

  function metaText(j, now) {
    const pct = j.total ? Math.min(100, Math.floor(j.done / j.total * 100)) : null;
    const cur = j.steps[j.stepIdx];
    const parts = [];
    if (j.total) parts.push(`${fmt(j.done)} / ${fmt(j.total)} ${j.unit}`, `${pct}%`);
    else if (j.done) parts.push(`${fmt(j.done)} ${j.unit}`);
    if (cur) parts.push(`現在：${cur.label}`);
    parts.push(`経過 ${elapsed(now - j.started)}`);
    if (!j.total) parts.push(`最終更新 ${clock(j.updated)}`);
    return parts.join('、');
  }

  function fullPaint(view) {
    const { api, node, o } = view;
    const j = api.job;
    const now = Date.now();
    const vs = JB.viewState(j, now);
    const st = JB.STATES[vs];
    node.className = 'job is-tone-' + st.tone + (o.compact ? ' is-compact' : '');
    node.innerHTML = '';
    const finished = !!j.ended;

    // 見出し：状態・処理名・操作
    const actions = el('div', { class: 'job-actions' });
    if (!finished && j.canCancel) {
      actions.appendChild(el('button', {
        class: 'btn btn-sm', type: 'button', disabled: j.state === 'aborting',
        title: j.state === 'aborting' ? '中止を受け付けました。止まるまでお待ちください' : 'この処理を中止します',
        onclick: () => api.cancel()
      }, [icon('fa-circle-stop'), j.state === 'aborting' ? '中止処理中…' : '中止']));
    }
    if (!finished && j.reveal && o.onReveal !== false) {
      actions.appendChild(el('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', title: 'この処理を始めた画面を開きます',
        onclick: () => { j.reveal(); if (typeof o.onReveal === 'function') o.onReveal(); }
      }, [icon('fa-arrow-up-right-from-square'), '元の画面へ']));
    }
    const waitLabel = vs === 'waiting' ? j.waitText : '';
    node.appendChild(el('div', { class: 'job-head' }, [
      stateBadge(vs, waitLabel ? `待機中：${waitLabel}` : ''),
      el('b', { class: 'job-name', text: j.name, title: j.name }),
      actions
    ]));

    // 工程 n / m（工程が 2 つ以上のときだけ）。工程が多いときは今の工程だけを出し、一覧は折りたたむ
    if (j.steps.length > 1 && !(finished && o.compact && j.state !== 'failed')) {
      const cur = j.steps[j.stepIdx];
      const doneN = j.steps.filter((x) => x.status === 'done').length;
      const list = el('ol', { class: 'job-step-list' + (j.steps.length > MANY_STEPS ? ' is-vertical' : '') }, j.steps.map((s) => el('li', { class: 'is-' + s.status, title: `${s.label}：${JB.STEP[s.status]}` }, [
        icon(STEP_ICON[s.status]), `${s.label}`, el('span', { class: 'sr', text: `（${JB.STEP[s.status]}）` })
      ])));
      const now = el('span', { class: 'job-step-now', text: finished ? `工程 ${fmt(doneN)} / ${fmt(j.steps.length)} 完了` : `工程 ${j.stepIdx + 1} / ${j.steps.length}：${cur ? cur.label : ''}` });
      if (j.steps.length > MANY_STEPS) {
        const det = el('details', { class: 'job-step-more' }, [el('summary', { text: '工程の詳細' }), list]);
        if (view.moreOpen) det.open = true;
        det.addEventListener('toggle', () => { view.moreOpen = det.open; });
        node.appendChild(el('div', { class: 'job-steps' }, [now, det]));
      } else node.appendChild(el('div', { class: 'job-steps' }, [now, list]));
    }

    if (!finished) {
      // バー：総量が分かるときは割合、分からないときは不確定（根拠のない割合は出さない）
      const pct = j.total ? Math.min(100, Math.floor(j.done / j.total * 100)) : null;
      const bar = el('div', { class: 'progress' + (pct === null ? ' is-indeterminate' : ''), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [
        el('div', { class: 'progress-fill', style: pct === null ? '' : `width:${pct}%;` })
      ]);
      if (pct !== null) bar.setAttribute('aria-valuenow', String(pct));
      node.appendChild(bar);
      node.appendChild(el('div', { class: 'job-meta is-live', text: metaText(j, now) }));

      if (vs === 'stalled') {
        node.appendChild(el('div', { class: 'job-note is-warn' }, [icon('fa-triangle-exclamation'),
          el('span', { text: `${clock(j.updated)} から進捗が更新されていません。停止している可能性があります（処理の応答を確認しています）。${j.canCancel ? 'しばらく待つか、中止してください' : 'しばらく待ってください。変わらないときは画面を再読み込みしてください'}` })]));
      } else if (vs === 'waiting') {
        node.appendChild(el('div', { class: 'job-note' }, [icon('fa-hourglass-half'), el('span', { text: `${j.waitText}です（停止ではありません）` })]));
      }
      if (!j.canCancel && j.noCancelReason) {
        node.appendChild(el('div', { class: 'job-note is-mute' }, [icon('fa-circle-info'), el('span', { text: '中止できません：' + j.noCancelReason })]));
      }
    } else if (o.compact) {
      // 小さい表示：結果の要約と出力先だけ。件数・時刻はツールチップ、すべては実行の履歴で見られる
      const r = j.result || {};
      node.title = [countsText(r.counts), `${clock(j.started)} 開始・${clock(j.ended)} 終了（所要 ${elapsed(j.ended - j.started)}）`, '詳しくは上部バーの「実行の履歴」で見られます'].filter(Boolean).join('\n');
      const main = r.error || r.summary || (r.warnings || [])[0] || '';
      if (main) node.appendChild(el('div', { class: r.error ? 'job-note is-err' : 'job-meta', text: main }));
      if (r.warnings && r.warnings.length && !r.error) node.appendChild(el('div', { class: 'job-note is-warn' }, [icon('fa-triangle-exclamation'), el('span', { text: r.warnings[0] + (r.warnings.length > 1 ? ` ほか ${r.warnings.length - 1} 件` : '') })]));
    } else {
      // 終わったら結果を残す（件数・出力先・警告・失敗箇所・次にできること）
      const r = j.result || {};
      const lines = [];
      if (r.summary) lines.push(el('div', { text: r.summary }));
      const ct = countsText(r.counts);
      if (ct) lines.push(el('div', { class: 'job-meta', text: ct }));
      if (r.output) lines.push(el('div', { class: 'job-meta' }, [icon('fa-location-dot'), ' 出力先：' + r.output]));
      (r.warnings || []).slice(0, 3).forEach((w) => lines.push(el('div', { class: 'job-note is-warn' }, [icon('fa-triangle-exclamation'), el('span', { text: w })])));
      if (r.error) lines.push(el('div', { class: 'job-note is-err' }, [icon('fa-circle-xmark'), el('span', { text: r.error })]));
      if (r.next) lines.push(el('div', { class: 'job-meta' }, [icon('fa-arrow-right'), ' ' + r.next]));
      lines.push(el('div', { class: 'job-meta', text: `${clock(j.started)} 開始・${clock(j.ended)} 終了（所要 ${elapsed(j.ended - j.started)}）` }));
      lines.forEach((n) => node.appendChild(n));
    }
  }

  /* ── 上部バーの「実行中」 ── */
  let host = null;
  let pop = null;
  let lastEnded = null; // 最後に終わった処理（しばらく上部バーに結果を出す）

  function mount(target) {
    host = target;
    CDB.bus.on('jobs:changed', onChanged);
    paintChip();
  }

  function onChanged() {
    const recent = JB.recentList()[0];
    if (recent && recent.job.ended && (!lastEnded || lastEnded.job.id !== recent.job.id) && Date.now() - recent.job.ended < 1000) lastEnded = recent;
    // 一覧の顔ぶれが変わったときだけ一覧を組み直す
    const members = JB.list().concat(JB.recentList().slice(0, 3)).map((a) => a.job.id + ':' + (a.job.ended ? 1 : 0)).join(',');
    if (pop && !pop.hidden && members !== popMembers) paintPop();
    paintAll();
    ensureTick();
  }
  let popMembers = '';

  function paintAll() {
    views.forEach((v) => { if (!v.node.isConnected) views.delete(v); else paintView(v); });
    paintChip();
  }

  let chipSig = null;
  function paintChip() {
    if (!host) return;
    const act = JB.list();
    const now = Date.now();
    let content = null;
    let tone = 'info';
    if (act.length) {
      const stalled = act.some((a) => JB.viewState(a.job, now) === 'stalled');
      if (act.length === 1) {
        const j = act[0].job;
        const vs = JB.viewState(j, now);
        const pct = j.total ? `${Math.min(100, Math.floor(j.done / j.total * 100))}%` : '';
        const step = j.steps.length > 1 ? `：${j.steps[j.stepIdx].label}` : '';
        content = [icon(JB.STATES[vs].icon), el('span', { class: 'job-chip-text', text: vs === 'stalled' ? `${j.name}：進捗が更新されていません` : `${j.name}${step} ${pct}`.trim() })];
        tone = JB.STATES[vs].tone;
      } else {
        content = [icon(stalled ? 'fa-triangle-exclamation' : 'fa-spinner fa-spin'), el('span', { class: 'job-chip-text', text: `実行中 ${act.length} 件${stalled ? '（更新のないものあり）' : ''}` })];
        tone = stalled ? 'warn' : 'info';
      }
    } else if (lastEnded && now - lastEnded.job.ended < cssMs('--t-recent-job', 8000)) {
      const j = lastEnded.job;
      const s = JB.STATES[j.state];
      content = [icon(s.icon), el('span', { class: 'job-chip-text', text: `${s.label}：${j.name}` })];
      tone = s.tone;
    }
    const sig = content ? tone + '|' + content[1].textContent + '|' + (pop && !pop.hidden) : '';
    if (sig === chipSig) return;
    chipSig = sig;
    host.innerHTML = '';
    if (!content) return;
    host.appendChild(el('button', {
      class: 'job-chip is-tone-' + tone, type: 'button', 'aria-haspopup': 'true', 'aria-expanded': String(!!(pop && !pop.hidden)),
      title: '実行中・直近の処理を表示します', onclick: (e) => { e.stopPropagation(); togglePop(); }
    }, content));
  }

  function togglePop(force) {
    if (!pop) {
      pop = el('div', { class: 'jobs-pop', hidden: true, role: 'dialog', 'aria-label': '実行中・直近の処理' });
      document.body.appendChild(pop);
      // ほかの場所を押したら閉じる（メニューのボタンはクリックの伝わりを止めるので、押し始めで判定する）
      document.addEventListener('pointerdown', (e) => {
        if (pop.hidden || pop.contains(e.target) || (host && host.contains(e.target))) return;
        pop.hidden = true;
        paintChip();
      }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); pop.hidden = true; paintChip(); } }, true);
    }
    pop.hidden = force === undefined ? !pop.hidden : !force;
    if (!pop.hidden) paintPop();
    paintChip();
  }

  function paintPop() {
    pop.innerHTML = '';
    const act = JB.list();
    const rec = JB.recentList();
    popMembers = act.concat(rec.slice(0, 3)).map((a) => a.job.id + ':' + (a.job.ended ? 1 : 0)).join(',');
    pop.appendChild(el('div', { class: 'jobs-pop-head' }, [icon('fa-list-check'), el('b', { text: act.length ? `実行中 ${act.length} 件` : '実行中の処理はありません' })]));
    const close = () => { pop.hidden = true; paintChip(); };
    act.forEach((a) => pop.appendChild(progressView(a, { onReveal: close })));
    if (rec.length) {
      pop.appendChild(el('div', { class: 'jobs-pop-label', text: '直近に終わった処理' }));
      rec.slice(0, 3).forEach((a) => pop.appendChild(progressView(a, { compact: true })));
    }
    pop.appendChild(el('div', { class: 'jobs-pop-foot' }, [el('button', {
      class: 'btn btn-sm', type: 'button', onclick: () => { close(); UI.history.open(); }
    }, [icon('fa-clock-rotate-left'), '実行の履歴をすべて見る'])]));
  }

  /* ── 経過時間と停止の可能性を 1 秒ごとに描き直す（処理がある間だけ） ── */
  let tick = 0;
  function ensureTick() {
    if (tick) return;
    tick = setInterval(() => {
      const busy = JB.runningCount() > 0;
      const showingRecent = lastEnded && Date.now() - lastEnded.job.ended < cssMs('--t-recent-job', 8000) + 1000;
      paintAll();
      if (!busy && !showingRecent) { clearInterval(tick); tick = 0; }
    }, 1000);
  }

  UI.jobs = { mount, progressView, stateBadge, countsText, elapsed, clock };
})();
