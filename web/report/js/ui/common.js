/* =========================================================
   js/ui/common.js : 共通UI部品（モーダル・トースト・メニュー・バッジ・理由表示）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const { el, icon } = U;

  /* ---------- モーダル ---------- */
  const stack = [];

  /**
   * @param {{title:string, icon?:string, size?:'sm'|'md'|'lg', body:Node, foot?:Node, headExtra?:Node, onClose?:Function}} opt
   */
  function openModal(opt) {
    const closeBtn = el('button', { class: 'icon-btn', title: '閉じる（Esc）', type: 'button' }, [icon('fa-xmark')]);
    const modal = el('div', { class: 'modal' + (opt.size ? ' is-' + opt.size : ''), role: 'dialog' }, [
      el('div', { class: 'modal-head' }, [
        opt.icon ? icon(opt.icon) : null,
        el('h2', { text: opt.title }),
        el('div', { class: 'spacer' }),
        opt.headExtra || null,
        closeBtn
      ]),
      el('div', { class: 'modal-body' }, [opt.body]),
      opt.foot ? el('div', { class: 'modal-foot' }, [opt.foot]) : null
    ]);
    const backdrop = el('div', { class: 'modal-backdrop' }, [modal]);
    const handle = {
      root: modal,
      close() {
        const i = stack.indexOf(handle);
        if (i >= 0) stack.splice(i, 1);
        backdrop.remove();
        if (opt.onClose) opt.onClose();
      }
    };
    closeBtn.addEventListener('click', () => handle.close());
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) handle.close(); });
    document.getElementById('modalRoot').appendChild(backdrop);
    stack.push(handle);
    U.enableFormNav(modal);
    const first = modal.querySelector('[autofocus]') || modal.querySelector('.modal-body input, .modal-body select, .modal-body button');
    if (first) setTimeout(() => first.focus(), 0);
    return handle;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stack.length) {
      e.preventDefault();
      stack[stack.length - 1].close();
    }
  });

  /* ---------- トースト（取り消し付き） ---------- */
  const TOAST_ICON = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', err: 'fa-circle-xmark', info: 'fa-circle-info' };
  const TOAST_MAX = 3;
  const TOAST_WORD = { ok: '完了', warn: '注意', err: '失敗', info: 'お知らせ' };

  /**
   * @param {{type?:'ok'|'warn'|'err'|'info', text:string, undo?:Function, duration?:number, noHistory?:boolean}} opt
   *   取り消したときは実行の履歴に残す（noHistory：列幅など、履歴に残すほどでない操作）
   */
  function toast(opt) {
    const type = opt.type || 'ok';
    const root = document.getElementById('toastRoot');
    const node = el('div', { class: 'toast is-' + type, role: 'status' }, [
      icon(TOAST_ICON[type]),
      el('div', { class: 'grow' }, [el('b', { text: TOAST_WORD[type] + '：' }), opt.text])
    ]);
    let timer = 0;
    const remove = () => { clearTimeout(timer); node.remove(); };
    if (opt.undo) {
      node.appendChild(el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => {
          remove();
          const log = (status, extra) => {
            if (opt.noHistory || !CDB.jobs) return;
            CDB.jobs.record({ name: '取り消し：' + opt.text, kind: 'undo', status }, extra);
          };
          try {
            await opt.undo();
            toast({ type: 'info', text: '取り消しました' });
            log('done', { summary: '直前の操作を取り消しました' });
            CDB.bus.emit('data:changed');
          } catch (err) {
            toast({ type: 'err', text: '取り消しに失敗しました：' + err.message });
            log('failed', { error: err.message });
          }
        }
      }, [icon('fa-rotate-left'), '取り消し']));
    }
    node.appendChild(el('button', { class: 'icon-btn', type: 'button', title: '閉じる', onclick: remove }, [icon('fa-xmark')]));
    root.appendChild(node);
    while (root.children.length > TOAST_MAX) root.firstElementChild.remove();
    const cssMs = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--t-toast'), 10) || 6000;
    timer = setTimeout(remove, opt.duration || (opt.undo ? cssMs * 1.5 : cssMs));
  }

  /* ---------- ポップアップメニュー ---------- */
  function bindMenu(button, menu) {
    const close = () => { menu.hidden = true; };
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('button')) close(); });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
    return { close };
  }

  /* ---------- 状態バッジ（アイコン＋文字＋色） ---------- */
  function badge(kind, iconName, text, opts) {
    const o = opts || {};
    const tag = o.onclick ? 'button' : 'span';
    return el(tag, {
      class: 'badge badge-' + kind + (o.active ? ' is-active' : ''),
      type: o.onclick ? 'button' : null,
      title: o.title || null,
      onclick: o.onclick || null
    }, [icon(iconName), text]);
  }

  /** disabled 理由の表示 */
  function reasonList(reasons) {
    return el('div', { class: 'row wrap' }, reasons.map((r) => el('span', { class: 'reason' }, [icon('fa-circle-exclamation'), r])));
  }

  /** 折りたたみセクション */
  function section(title, iconName, body, open) {
    return el('details', { class: 'sec', open: !!open }, [
      el('summary', {}, [icon(iconName), title, icon('fa-chevron-right', 'chev')]),
      el('div', { class: 'sec-body' }, [body])
    ]);
  }

  /** select 要素の生成 */
  function select(options, value, attrs) {
    const s = el('select', Object.assign({ class: 'select' }, attrs || {}),
      options.map((o) => el('option', { value: o.value, text: o.label })));
    s.value = value;
    return s;
  }

  CDB.ui = Object.assign(CDB.ui || {}, { openModal, toast, bindMenu, badge, reasonList, section, select });
})();
