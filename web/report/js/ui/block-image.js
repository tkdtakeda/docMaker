/* =========================================================
   js/ui/block-image.js : 画像の取り込み（ファイル選択・ドラッグ＆ドロップ・Ctrl+V の共通処理）
   読み込んだ画像は PNG／JPEG の data URL にそろえ、大きすぎるときは縮める（帳票に保存するため）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const UI = CDB.ui;

  const MAX_BYTES = 10 * 1024 * 1024; // 取り込むファイルの上限
  const MAX_SIDE = 1600; // 長い辺の上限（px）

  /** 画像のファイルか（Excel でも使える PNG・JPEG・GIF と、WebP に変換して使うもの） */
  const isImageFile = (f) => !!f && /^image\/(png|jpeg|gif|webp|bmp)$/.test(f.type);

  /**
   * ファイル → { src, w, h, name }
   * @param {File} file
   */
  function read(file) {
    return new Promise((resolve, reject) => {
      if (!isImageFile(file)) { reject(new Error('画像（PNG・JPEG・GIF・WebP・BMP）を選んでください')); return; }
      if (file.size > MAX_BYTES) { reject(new Error('画像が大きすぎます（10MB まで）。小さくしてから入れてください')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * k));
        const h = Math.max(1, Math.round(img.naturalHeight * k));
        const keep = /^image\/(png|jpeg)$/.test(file.type) && k === 1; // そのまま使える
        if (keep) {
          const fr = new FileReader();
          fr.onload = () => resolve({ src: String(fr.result), w, h, name: file.name.replace(/\.[^.]+$/, '') });
          fr.onerror = () => reject(new Error('画像を読めませんでした'));
          fr.readAsDataURL(file);
          return;
        }
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        if (file.type !== 'image/jpeg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); } // 透明は白に（Excel・印刷で黒くならないように）
        cx.drawImage(img, 0, 0, w, h);
        resolve({ src: cv.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.92), w, h, name: file.name.replace(/\.[^.]+$/, '') });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読めませんでした')); };
      img.src = url;
    });
  }

  /** ファイルの選択ダイアログを開く。選んだら onPick(img) */
  function choose(onPick) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      try { onPick(await read(f)); } catch (err) { UI.toast({ type: 'warn', text: err.message }); }
    });
    input.click();
  }

  UI.blockImage = { read, choose, isImageFile };
})();
