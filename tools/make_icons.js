/* アイコン書き出し（本体とは別）。使い方: node tools/make_icons.js
   web/img/logo.svg（原本）から、Windows のショートカット用 docmaker.ico と PNG（180・512）を作る。
   playwright が入っている環境で動く。ICO は PNG 埋め込み形式（Windows Vista 以降で読める）。 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const dir = path.resolve(__dirname, "..", "web", "img");
const svg = fs.readFileSync(path.join(dir, "logo.svg"), "utf8");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function ico(pngs) {
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = 6 + 16 * pngs.length;
  const dirs = pngs.map(({ size, buf }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(off, 12); off += buf.length; return e;
  });
  return Buffer.concat([head, ...dirs, ...pngs.map((p) => p.buf)]);
}

(async () => {
  const browser = await chromium.launch();
  const render = async (size) => {
    const p = await browser.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
    const buf = await p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await p.close(); return buf;
  };
  const pngs = []; for (const s of SIZES) pngs.push({ size: s, buf: await render(s) });
  fs.writeFileSync(path.join(dir, "docmaker.ico"), ico(pngs));
  fs.writeFileSync(path.join(dir, "logo-180.png"), await render(180));
  fs.writeFileSync(path.join(dir, "logo-512.png"), await render(512));
  await browser.close();
  console.log("書き出しました:", fs.readdirSync(dir).join(", "));
})();
