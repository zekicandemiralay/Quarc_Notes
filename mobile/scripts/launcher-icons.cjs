// Android launcher icons, from resources/launcher/{background,foreground,monochrome}.png.
//
// Each source is 1024 px = one full 108 dp adaptive-icon layer. The launcher
// shows only the middle 72 dp and cuts it to its own shape (rounded square,
// circle, squircle...), so the background is edge to edge and the glyph sits
// in the middle. "monochrome" is the flat glyph Android 13+ tints for themed
// icons. Masters: QuarcNet/logos/adaptive/.
//
// Runs as the last step of `npm run icons` (after capacitor-assets, which
// makes the splash screens but would otherwise leave the old icon style).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = path.join(__dirname, '..', 'resources', 'launcher');
const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const DENSITIES = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const ADAPTIVE = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`;
const mask = (s, shape) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">${shape}</svg>`);

(async () => {
  const src = (name) => path.join(SRC, `${name}.png`);
  // Legacy icon (Android 7.1 and older): the visible 72 dp of both layers.
  const layered = await sharp(src('background')).composite([{ input: src('foreground') }]).png().toBuffer();
  const visible = await sharp(layered).extract({ left: 171, top: 171, width: 682, height: 682 }).png().toBuffer();

  for (const [density, k] of Object.entries(DENSITIES)) {
    const dir = path.join(RES, `mipmap-${density}`);
    fs.mkdirSync(dir, { recursive: true });
    const layer = Math.round(108 * k);
    const legacy = Math.round(48 * k);
    for (const name of ['background', 'foreground', 'monochrome']) {
      await sharp(src(name)).resize(layer, layer).png().toFile(path.join(dir, `ic_launcher_${name}.png`));
    }
    const icon = await sharp(visible).resize(legacy, legacy).png().toBuffer();
    await sharp(icon)
      .composite([{ input: mask(legacy, `<rect width="${legacy}" height="${legacy}" rx="${legacy * 0.22}"/>`), blend: 'dest-in' }])
      .png()
      .toFile(path.join(dir, 'ic_launcher.png'));
    await sharp(icon)
      .composite([{ input: mask(legacy, `<circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}"/>`), blend: 'dest-in' }])
      .png()
      .toFile(path.join(dir, 'ic_launcher_round.png'));
  }

  const anydpi = path.join(RES, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpi, { recursive: true });
  fs.writeFileSync(path.join(anydpi, 'ic_launcher.xml'), ADAPTIVE);
  fs.writeFileSync(path.join(anydpi, 'ic_launcher_round.xml'), ADAPTIVE);
  console.log('Android launcher icons written (adaptive + monochrome + legacy).');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
