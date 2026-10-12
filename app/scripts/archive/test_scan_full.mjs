import { scanDir } from '../src/main/scanner.ts'

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

const hits = await scanDir('J:\\ggame')
console.log('hits', hits.length)
for (const h of hits) {
  console.log(JSON.stringify({ clean: cleanTitle(h.rawTitle), raw: h.rawTitle, exe: h.exePath }))
}
