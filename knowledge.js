// Base de conocimiento desde archivos .txt (uno por tema). Cada línea: palabra = respuesta
// Los busca en la carpeta conocimiento/ y también en la raíz (archivos conocimiento-*.txt).
// Las líneas vacías o que empiezan con # se ignoran.
const fs = require('fs');
const path = require('path');

function parseFile(fp, out) {
  let txt = '';
  try { txt = fs.readFileSync(fp, 'utf8'); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i < 0) continue;
    const match = l.slice(0, i).trim(), reply = l.slice(i + 1).trim();
    if (match && reply) out.push({ match, reply });
  }
}

function loadKnowledge(baseDir) {
  const out = [], files = [];
  try { for (const f of fs.readdirSync(path.join(baseDir, 'conocimiento'))) if (f.toLowerCase().endsWith('.txt')) files.push(path.join(baseDir, 'conocimiento', f)); } catch {}
  try { for (const f of fs.readdirSync(baseDir)) if (/^conocimiento.*\.txt$/i.test(f)) files.push(path.join(baseDir, f)); } catch {}
  for (const fp of files) parseFile(fp, out);
  console.info(`[Conocimiento] ${out.length} respuestas cargadas de ${files.length} archivo(s).`);
  return out;
}
module.exports = { loadKnowledge };
