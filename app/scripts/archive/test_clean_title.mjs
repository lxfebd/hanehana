// 与 src/main/games.ts 的 cleanTitle 保持一致（本测试不 import Electron 依赖链）
function cleanTitle(raw) {
  let t = raw.trim()
  t = t.replace(/[（(][^）)]*[）)]/g, ' ')
  t = t.replace(/[+\s]*\d+(?:\.\d+){1,}(?:\s*[+\-–].*)?$/i, ' ')
  t = t.replace(/[+\s]*v?\d+(?:\.\d+)+/gi, ' ')
  t = t.replace(
    /(汉化(?:补丁)?(?:全[面们]?|版)?|整合包|完整版|绿色版|免安装|硬盘版|简体中文|繁体中文|步兵|骑兵|fff?mod|小黑盒|叮卜|上色|白[色版]|DLC\+.*|全\.? unlock.*|ver\s*\d+(?:\.\d+)*)/gi,
    ' ',
  )
  t = t.replace(/\s*\d+(?:\.\d+)+(?:[+\-][^ ]*)+/g, ' ')
  t = t
    .replace(/[+_…_/\\|,;:：，、]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t || raw.trim()
}

const samples = [
  '妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（全部使用daseson上色）',
  "Yog-Sothoth's Yard",
  'Living With SIster Monochrome Fantasy',
  'Magpie-v0.11.2-x64',
]
let bad = 0
for (const s of samples) {
  const out = cleanTitle(s)
  console.log(JSON.stringify(s), '->', JSON.stringify(out))
  if (!out) bad++
}
process.exit(bad ? 1 : 0)
