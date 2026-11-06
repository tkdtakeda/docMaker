/* =========================================================
   js/ui/density.js : 表示密度（コンパクト・標準・ゆったり）の切り替え（基本設計 1-9）
   ・ルート要素に data-density を付け、文字・余白・行の高さ・入力欄とボタンの高さを一体で切り替える（値は css/tokens.css）
   ・選んだ密度はこの PC のブラウザに覚え、次に開いたときも同じにする
   ・切り替えたら bus に 'density:changed' を出す（表は列幅を測り直し、見ていた行の位置を保つ）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const UI = CDB.ui;
  const { el, icon } = U;

  const PREF = 'cdb.density';
  /** 密度の登録簿（並び順＝メニューの順） */
  const LEVELS = [
    { id: 'compact', label: 'コンパクト', desc: '一覧を多く見る（文字・行を小さく）', icon: 'fa-compress' },
    { id: 'standard', label: '標準', desc: 'ふだんの大きさ（初期値）', icon: 'fa-equals' },
    { id: 'comfortable', label: 'ゆったり', desc: '読みやすく、押しやすく（文字・行を大きく）', icon: 'fa-expand' }
  ];
  const DEFAULT = 'standard';

  function read() {
    try {
      const v = localStorage.getItem(PREF);
      return LEVELS.some((l) => l.id === v) ? v : DEFAULT;
    } catch (_) { return DEFAULT; }
  }

  function apply(id) {
    document.documentElement.setAttribute('data-density', id);
  }

  const current = () => document.documentElement.getAttribute('data-density') || DEFAULT;

  function set(id) {
    if (id === current()) return;
    apply(id);
    try { localStorage.setItem(PREF, id); } catch (_) { /* 保存できない環境では今回限り */ }
    CDB.bus.emit('density:changed', { id });
  }

  // 最初の描画の前に当てる（ちらつかせない）
  apply(read());

  /** 上部バーのボタンとメニュー */
  function mount(host) {
    const btn = el('button', { class: 'icon-btn', type: 'button', 'aria-haspopup': 'true' }, [icon('fa-text-height')]);
    const menu = el('div', { class: 'menu density-menu', hidden: true, role: 'menu' });
    const wrap = el('div', { class: 'menu-wrap' }, [btn, menu]);
    host.appendChild(wrap);

    function render() {
      const cur = current();
      const lv = LEVELS.find((l) => l.id === cur);
      btn.title = `表示の密度：${lv.label}（文字の大きさと余白）`;
      menu.innerHTML = '';
      menu.appendChild(el('div', { class: 'menu-label', text: '表示の密度（文字の大きさと余白）' }));
      LEVELS.forEach((l) => {
        const on = l.id === cur;
        menu.appendChild(el('button', {
          type: 'button', role: 'menuitemradio', 'aria-checked': String(on), class: on ? 'is-current' : '',
          onclick: () => { set(l.id); render(); } // 反映は画面全体の変化で分かるため、通知は出さない（通知で表の上が隠れないように）
        }, [icon(on ? 'fa-check' : l.icon), el('span', { class: 'grow' }, [el('b', { text: l.label }), el('span', { class: 'menu-desc', text: l.desc })])]));
      });
    }
    render();
    UI.bindMenu(btn, menu);
    // 開いたら今の密度にフォーカスを置く（↑↓・Enter で選べる）
    btn.addEventListener('click', () => {
      if (menu.hidden) return;
      const cur = menu.querySelector('.is-current');
      if (cur) setTimeout(() => cur.focus(), 0);
    });
    menu.addEventListener('keydown', (e) => {
      const items = Array.from(menu.querySelectorAll('button'));
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const to = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[to].focus();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        menu.hidden = true;
        btn.focus();
      }
    });
  }

  UI.density = { LEVELS, mount, current, set };
})();
