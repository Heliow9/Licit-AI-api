const fs = require('fs');
const path = require('path');

const ALLOWED_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff']);

function walkFiles(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    const ents = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of ents) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ALLOWED_EXTS.has(path.extname(ent.name).toLowerCase())) out.push(p);
    }
  }
  return out;
}

module.exports = { walkFiles, ALLOWED_EXTS };
