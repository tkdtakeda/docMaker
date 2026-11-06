/* =========================================================
   js/domain/jobs.js : 実行中の処理の状態（基本設計 1-14・1-18〜1-22）。画面は持たない
   ・処理ごとに「状態・工程・進み具合・最終更新」を持ち、変わるたびに bus の 'jobs:changed' を出す
   ・終わったら（完了・中止・失敗）履歴（CDB.history）に残す
   ・停止は断定しない：処理中のまま STALL_MS 以上更新がなければ「停止の可能性あり」と判断できるようにする
   使い方：
     const job = CDB.jobs.start({ name, kind, steps:['確認','保存'], cancel, noCancelReason, reveal, input, conditions });
     job.step(1); job.progress(3420, 10000, '行'); job.wait('user', '確認操作待ち');
     job.finish({ counts, output, warnings, summary });  /  job.fail(err)  /  job.aborted()
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});

  /**
   * 状態の定義（登録簿）。tone は色の意味（info/ok/warn/err/mute）。必ずアイコン＋文字と一緒に出す
   * active … まだ終わっていない（上部バーの「実行中」に数える）
   */
  const STATES = {
    idle:     { label: '未実行', icon: 'fa-circle', tone: 'mute', active: false },
    queued:   { label: '開始待ち', icon: 'fa-hourglass-start', tone: 'info', active: true },
    running:  { label: '処理中', icon: 'fa-spinner fa-spin', tone: 'info', active: true },
    paused:   { label: '一時停止中', icon: 'fa-pause', tone: 'warn', active: true },
    waiting:  { label: '待機中', icon: 'fa-hourglass-half', tone: 'info', active: true },
    aborting: { label: '中止処理中', icon: 'fa-spinner fa-spin', tone: 'warn', active: true },
    stalled:  { label: '停止している可能性あり', icon: 'fa-triangle-exclamation', tone: 'warn', active: true },
    done:     { label: '完了', icon: 'fa-circle-check', tone: 'ok', active: false },
    warn:     { label: '完了（注意あり）', icon: 'fa-triangle-exclamation', tone: 'warn', active: false },
    aborted:  { label: '中止', icon: 'fa-circle-stop', tone: 'mute', active: false },
    failed:   { label: '失敗', icon: 'fa-circle-xmark', tone: 'err', active: false }
  };

  /** 待機の理由（正常な待機。停止とは区別する・基本設計 1-21） */
  const WAITS = {
    user: '確認操作待ち',
    external: '応答待ち',
    retry: '再試行まで待機中'
  };

  const STEP = { todo: '未実行', doing: '処理中', done: '完了', skip: '省略', stop: '中止', err: '失敗' };

  const STALL_MS = 10000;
  const RECENT_MAX = 5;

  const active = [];
  const recent = [];
  let seq = 0;
  const emit = () => CDB.bus.emit('jobs:changed');

  /**
   * @param {object} o
   *   name, kind, steps?: string[], cancel?: ()=>void, noCancelReason?: string,
   *   reveal?: ()=>void, input?, conditions?, unit?, history?: true | false | 'problems'（既定 true）, recent?: boolean（既定 true）
   */
  function start(o) {
    const now = Date.now();
    const job = {
      id: ++seq,
      name: o.name,
      kind: o.kind || '',
      state: 'running',
      waitText: '',
      steps: (o.steps || []).map((label, i) => ({ label, status: i === 0 ? 'doing' : 'todo' })),
      stepIdx: 0,
      done: 0,
      total: null,
      unit: o.unit || '件',
      started: now,
      updated: now,
      ended: 0,
      input: o.input || '',
      conditions: o.conditions || '',
      canCancel: typeof o.cancel === 'function',
      noCancelReason: o.noCancelReason || '',
      reveal: o.reveal || null,
      result: null
    };
    const touch = () => { job.updated = Date.now(); emit(); };

    const api = {
      job,
      /** 工程を進める（前の工程は完了にする） */
      step(i) {
        job.steps.forEach((s, k) => {
          if (k < i && s.status !== 'skip') s.status = 'done';
          else if (k === i) s.status = 'doing';
        });
        job.stepIdx = i;
        job.done = 0;
        job.total = null;
        if (job.state === 'waiting' || job.state === 'queued') job.state = 'running';
        touch();
      },
      /** 工程を省略する（取り込みで「紐付け待ちの確定」がないときなど） */
      skip(i) { if (job.steps[i]) job.steps[i].status = 'skip'; touch(); },
      /** 総量が分かれば total を渡す（分からなければ null：割合は出さない） */
      progress(done, total, unit) {
        job.done = done;
        job.total = total === undefined ? job.total : total;
        if (unit) job.unit = unit;
        if (job.state === 'waiting') job.state = 'running';
        touch();
      },
      wait(kind, text) { job.state = 'waiting'; job.waitText = text || WAITS[kind] || WAITS.external; touch(); },
      resume() { job.state = 'running'; job.waitText = ''; touch(); },
      /** 中止を求める。すぐ止まらない処理は「中止処理中」を出し、止まったら aborted() を呼んでもらう */
      cancel() {
        if (!job.canCancel || job.state === 'aborting') return;
        job.state = 'aborting';
        touch();
        o.cancel();
      },
      finish(r) { end(r && r.warnings && r.warnings.length ? 'warn' : 'done', r); },
      fail(err, r) { end('failed', Object.assign({ error: err && err.message ? err.message : String(err || '') }, r)); },
      aborted(r) { end('aborted', r); }
    };

    function end(state, r) {
      if (job.ended) return;
      const res = r || {};
      job.state = state;
      job.ended = Date.now();
      job.steps.forEach((s, k) => {
        if (s.status === 'doing') s.status = state === 'done' || state === 'warn' ? 'done' : state === 'aborted' ? 'stop' : 'err';
        else if (s.status === 'todo' && (state === 'done' || state === 'warn') && k > job.stepIdx) s.status = 'skip';
      });
      job.result = {
        counts: res.counts || null, output: res.output || '', warnings: res.warnings || [],
        error: res.error || '', summary: res.summary || '', next: res.next || ''
      };
      const i = active.indexOf(api);
      if (i >= 0) active.splice(i, 1);
      // recent:false … 終わった後に上部バーへ残さない（照合・再計算のような付随する処理）
      if (o.recent !== false) {
        recent.unshift(api);
        while (recent.length > RECENT_MAX) recent.pop();
      }
      emit();
      // history：false なら残さない、'problems' なら失敗・中止・注意のときだけ残す
      const keep = o.history === false ? false : o.history === 'problems' ? state !== 'done' : true;
      if (keep && CDB.history) {
        CDB.history.add({
          name: job.name, kind: job.kind, status: state, start: job.started, end: job.ended,
          steps: job.steps.map((s) => ({ label: s.label, status: s.status })),
          counts: job.result.counts, input: job.input, conditions: res.conditions || job.conditions,
          output: job.result.output, warnings: job.result.warnings, error: job.result.error, summary: job.result.summary
        }).catch(() => { /* 履歴に残せなくても処理の結果は変わらない */ });
      }
    }

    active.push(api);
    emit();
    return api;
  }

  /** すぐ終わる処理（CSV 出力・削除など）を、終わった状態で記録する */
  function record(o, r) {
    const api = start(Object.assign({}, o, { steps: o.steps || [] }));
    if (o.status === 'failed') api.fail(r && r.error, r);
    else api.finish(r);
    return api;
  }

  /** 画面に出す状態（処理中のまま更新が止まっていれば stalled） */
  function viewState(job, now) {
    if (job.state === 'running' && (now || Date.now()) - job.updated >= STALL_MS) return 'stalled';
    return job.state;
  }

  const list = () => active.slice();
  const recentList = () => recent.slice();
  const runningCount = () => active.length;
  /** 同じ種類の処理が実行中か（二重実行を防ぐ。競合する操作だけを止める・基本設計 1-18） */
  const isRunning = (kind) => active.some((a) => a.job.kind === kind);

  CDB.jobs = { STATES, WAITS, STEP, STALL_MS, start, record, viewState, list, recentList, runningCount, isRunning };
})();
