// Genera los iconos PWA a partir de public/img/dotbot-header.png.
//
// Salidas (en public/img/):
//   - icon-192.png         — Android home screen, install prompt
//   - icon-512.png         — Splash screen, store
//   - icon-maskable-192.png — Android adaptive icons (safe zone 60%)
//   - icon-maskable-512.png
//   - apple-touch-180.png  — iOS Home screen
//
// Para regenerar: node scripts/generate-pwa-icons.js
//
// Si en el futuro tenes un logo fuente de mayor resolucion (>=512), reemplaza
// dotbot-header.png — el script va a producir iconos mas nitidos sin cambios.

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const SRC = path.join(__dirname, '..', 'public', 'img', 'dotbot-header.png');
const OUT_DIR = path.join(__dirname, '..', 'public', 'img');

const BG = { r: 2, g: 6, b: 23, alpha: 1 }; // slate-950 #020617 (matchea theme_color del manifest)

async function genStandard(size) {
  // Estandar (purpose: any) — el logo ocupa todo el canvas.
  // El logo fuente ya tiene su propio fondo oscuro asi que no necesita padding.
  const out = path.join(OUT_DIR, `icon-${size}.png`);
  await sharp(SRC)
    .resize(size, size, { kernel: 'lanczos3', fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(out);
  return out;
}

async function genMaskable(size) {
  // Maskable — Android puede recortar bordes para forms circular/squircle.
  // Safe zone = 80% central. Para estar seguros, el logo ocupa 60% del canvas.
  const out = path.join(OUT_DIR, `icon-maskable-${size}.png`);
  const inner = Math.round(size * 0.6);
  const innerBuf = await sharp(SRC)
    .resize(inner, inner, { kernel: 'lanczos3' })
    .png()
    .toBuffer();

  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: innerBuf, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  return out;
}

async function genAppleTouch() {
  // iOS recomienda 180×180 sin mascara — Safari aplica esquinas redondeadas
  // automaticamente si el ícono tiene bordes cuadrados.
  const out = path.join(OUT_DIR, 'apple-touch-180.png');
  await sharp(SRC)
    .resize(180, 180, { kernel: 'lanczos3', fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(out);
  return out;
}

async function genFavicon() {
  // Favicon 32×32 PNG (la mayoria de browsers ya lo aceptan; .ico legacy queda intacto).
  const out = path.join(OUT_DIR, 'favicon-32.png');
  await sharp(SRC)
    .resize(32, 32, { kernel: 'lanczos3', fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(out);
  return out;
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`[!] Source no existe: ${SRC}`);
    process.exit(1);
  }
  const meta = await sharp(SRC).metadata();
  console.log(`Source: ${path.basename(SRC)} (${meta.width}×${meta.height})`);
  if (meta.width < 512 || meta.height < 512) {
    console.warn(
      `[!] Source es ${meta.width}×${meta.height}. Para mejor calidad de icon-512 conviene un fuente >=512×512.`
    );
  }

  const outputs = await Promise.all([
    genStandard(192),
    genStandard(512),
    genMaskable(192),
    genMaskable(512),
    genAppleTouch(),
    genFavicon(),
  ]);

  for (const f of outputs) {
    const sz = fs.statSync(f).size;
    console.log(`  ${path.relative(process.cwd(), f)}  (${sz} bytes)`);
  }
  console.log('OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
