/**
 * saves.ts 纯函数契约：isSaveFile（存档识别）+ webdavUrlError（WebDAV 地址校验）。
 *
 * isSaveFile 是备份的「什么东西算存档」判定：漏一个扩展名 = 该类型存档从此
 * 不进备份；误判本体 = 把 10GB 游戏资源包拖进快照。webdavUrlError 是安全
 * 校验：Basic 凭据 base64 明文，走 http 等于密码裸奔，只放行 https + 本机回环。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSaveFile, webdavUrlError } from '../src/main/saveRules.js'

test('存档扩展名全部识别', () => {
  for (const name of [
    'save.dat',
    'config.sav',
    'global.save',
    'memory.srm',
    'settings.cfg',
    'options.ini',
    'data.xml',
    'profile.json',
    'note.txt',
    'game.rom',
    'state.sna',
    'cart.slt',
    'save.sgo',
    'slot.sfs',
    'story.qst',
    'save.mem',
    'record.rec',
  ]) {
    assert.equal(isSaveFile(name), true, name)
  }
})

test('.dat 后缀单独放行（大资源包走大小上限拦截，不在扩展名这层卡）', () => {
  assert.equal(isSaveFile('archive.dat'), true)
  assert.equal(isSaveFile('SCENE.dat'), true)
})

test('本体/媒体文件一律不是存档', () => {
  for (const name of [
    'game.exe',
    'main.dll',
    'assets.pak',
    'data.pck',
    'big.wad',
    'game.iso',
    'res.bin', // .bin 在存档和本体两个表里都有——本体判定优先（galgame 里 .bin 几乎总是资源包）
    'movie.mp4',
    'clip.avi',
    'splash.webm',
    'cover.png',
    'bg.jpg',
    'icon.jpeg',
    'music.bmp',
    'voice.ogg',
    'bgm.wav',
    'op.flac',
    'patch.mp3',
    'archive.zip',
    'mod.7z',
    'cab.rar',
    'data.gz',
    'game.cab',
  ]) {
    assert.equal(isSaveFile(name), false, name)
  }
})

test('无扩展名/未知扩展名不是存档', () => {
  assert.equal(isSaveFile('savefile'), false)
  assert.equal(isSaveFile('data.db'), false)
  assert.equal(isSaveFile(''), false)
})

test('大小写不敏感', () => {
  assert.equal(isSaveFile('SAVE.DAT'), true)
  assert.equal(isSaveFile('Game.EXE'), false)
})

test('webdavUrlError：https 放行', () => {
  assert.equal(webdavUrlError('https://dav.example.com/hanehana'), null)
  assert.equal(webdavUrlError('https://dav.example.com:8443/x'), null)
})

test('webdavUrlError：http 拒绝（明文 Basic 凭据）', () => {
  const e = webdavUrlError('http://dav.example.com/')
  assert.ok(e && e.includes('https'))
})

test('webdavUrlError：本机回环 http 放行（自建测试服）', () => {
  assert.equal(webdavUrlError('http://localhost:8080/dav'), null)
  assert.equal(webdavUrlError('http://127.0.0.1:8080/dav'), null)
})

test('webdavUrlError：非 URL 报合法错误', () => {
  const e1 = webdavUrlError('not a url')
  assert.ok(e1 && e1.includes('合法'))
  const e2 = webdavUrlError('')
  assert.ok(e2 && e2.includes('合法'))
})
