// 文件管理器：远端脚本在本机 sh 里跑（HOME 指向临时目录），覆盖列目录、新建改名、
// 回收站、读文件、上传下载。macOS 上走「逐个 stat」那条路，Linux（CI）上走 GNU find。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  FileError, assertName, attachmentHeader, currentSha, downloadScript, listDir, listTrash, makeDir,
  normalizePath, places, protectedPath, purgeTrash, readText, renameEntry, restoreTrash, runScript,
  statPath, trashEntries, uploadFile,
} from '../lib/filemgr.js'

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-files-'))
  const spawnSsh = (_alias, script) => spawn('sh', ['-c', script], {
    env: { ...process.env, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const root = join(home, 'site')
  await mkdir(root)
  return { home, root, spawnSsh, alias: 'hk' }
}

const modeOf = async (p) => (await stat(p)).mode & 0o777

test('路径与名字校验', () => {
  assert.equal(normalizePath('/var//www/./a/../b/'), '/var/www/b')
  assert.equal(normalizePath('/'), '/')
  assert.throws(() => normalizePath('var/www'), FileError)
  assert.throws(() => normalizePath('/a\nb'), FileError)
  assert.equal(assertName('新建 文件夹'), '新建 文件夹')
  for (const bad of ['', '.', '..', 'a/b', 'a\0b']) assert.throws(() => assertName(bad), FileError, bad)
  assert.equal(protectedPath('/etc/'), true)
  assert.equal(protectedPath('/etc/nginx'), false)
  assert.equal(protectedPath('/usr/local'), true)
})

test('列目录：类型、大小、隐藏文件、链接、特殊名字都认得', async () => {
  const s = await sandbox()
  await writeFile(join(s.root, 'index.html'), '<h1>hi</h1>')
  await writeFile(join(s.root, '.env'), 'SECRET=1')
  await writeFile(join(s.root, '中文 名字.txt'), '内容')
  await writeFile(join(s.root, 'tab\there'), 'x')
  await mkdir(join(s.root, 'assets'))
  await symlink(join(s.root, 'assets'), join(s.root, 'link-to-dir'))
  await symlink(join(s.root, 'nowhere'), join(s.root, 'broken'))

  const res = await listDir({ alias: s.alias, path: s.root, spawnSsh: s.spawnSsh })
  assert.equal(res.path, s.root)
  assert.equal(res.home, s.home)
  assert.equal(res.writable, true)
  assert.ok(res.freeBytes > 0, '要带磁盘剩余空间')
  const by = Object.fromEntries(res.entries.map((e) => [e.name, e]))
  assert.deepEqual(Object.keys(by).sort(), ['.env', 'assets', 'broken', 'index.html', 'link-to-dir', 'tab\there', '中文 名字.txt'].sort())
  assert.equal(by['index.html'].type, 'file')
  assert.equal(by['index.html'].size, 11)
  assert.ok(by['index.html'].mtime > 1_600_000_000)
  assert.match(by['index.html'].mode, /^[0-7]{3,4}$/)
  assert.equal(by.assets.type, 'dir')
  assert.equal(by['link-to-dir'].type, 'link')
  assert.equal(by['link-to-dir'].target, 'dir', '指向文件夹的链接要能点进去')
  assert.equal(by.broken.target, 'broken')
  assert.equal(by['中文 名字.txt'].lossy, false)
})

test('列目录：不存在、不是文件夹，都说清楚', async () => {
  const s = await sandbox()
  await writeFile(join(s.root, 'a.txt'), 'x')
  await assert.rejects(listDir({ alias: s.alias, path: join(s.root, 'nope'), spawnSsh: s.spawnSsh }), /目录不存在/)
  await assert.rejects(listDir({ alias: s.alias, path: join(s.root, 'a.txt'), spawnSsh: s.spawnSsh }), /不是文件夹/)
})

test('常用位置：家目录、网站目录、回收站数量', async () => {
  const s = await sandbox()
  const res = await places({ alias: s.alias, spawnSsh: s.spawnSsh })
  assert.equal(res.home, s.home)
  assert.equal(res.trash, 0)
  assert.equal(typeof res.web, 'string')
})

test('新建文件夹是 755（网站要能读），同名就拒绝', async () => {
  const s = await sandbox()
  const res = await makeDir({ alias: s.alias, dir: s.root, name: 'uploads', spawnSsh: s.spawnSsh })
  assert.equal(res.path, join(s.root, 'uploads'))
  assert.equal(await modeOf(res.path), 0o755)
  await assert.rejects(makeDir({ alias: s.alias, dir: s.root, name: 'uploads', spawnSsh: s.spawnSsh }), /同名/)
  await assert.rejects(makeDir({ alias: s.alias, dir: s.root, name: 'a/b', spawnSsh: s.spawnSsh }), FileError)
})

test('改名：成功、重名拒绝、原文件不在了也说清楚', async () => {
  const s = await sandbox()
  await writeFile(join(s.root, 'old.conf'), 'x')
  await writeFile(join(s.root, 'taken.conf'), 'y')
  await renameEntry({ alias: s.alias, dir: s.root, from: 'old.conf', to: 'new.conf', spawnSsh: s.spawnSsh })
  assert.equal(await readFile(join(s.root, 'new.conf'), 'utf8'), 'x')
  await assert.rejects(renameEntry({ alias: s.alias, dir: s.root, from: 'new.conf', to: 'taken.conf', spawnSsh: s.spawnSsh }), /同名/)
  assert.equal(await readFile(join(s.root, 'taken.conf'), 'utf8'), 'y', '重名时不能把别人覆盖掉')
  await assert.rejects(renameEntry({ alias: s.alias, dir: s.root, from: 'ghost', to: 'x', spawnSsh: s.spawnSsh }), /不在了/)
})

test('回收站：删了能还原，原位置被占就不覆盖，彻底删除只动回收站', async () => {
  const s = await sandbox()
  await writeFile(join(s.root, 'a.txt'), 'A')
  await mkdir(join(s.root, 'dir'))
  await writeFile(join(s.root, 'dir', 'inner.txt'), 'I')

  const trashed = await trashEntries({ alias: s.alias, paths: [join(s.root, 'a.txt'), join(s.root, 'dir'), join(s.root, 'ghost')], spawnSsh: s.spawnSsh })
  assert.equal(trashed.moved.length, 2)
  assert.deepEqual(trashed.failed.map((f) => f.reason), ['已经不在了'])
  assert.deepEqual((await readdir(s.root)).sort(), [], '删掉的东西离开了原目录')

  const { items } = await listTrash({ alias: s.alias, spawnSsh: s.spawnSsh })
  assert.equal(items.length, 2)
  const file = items.find((i) => i.name === 'a.txt')
  assert.equal(file.origin, join(s.root, 'a.txt'))
  assert.equal(file.type, 'file')
  assert.equal(file.size, 1)
  assert.ok(file.deletedAt > 0)
  assert.equal(items.find((i) => i.name === 'dir').type, 'dir')
  assert.equal((await places({ alias: s.alias, spawnSsh: s.spawnSsh })).trash, 2)

  // 原位置又有了同名文件：不覆盖
  await writeFile(join(s.root, 'a.txt'), 'NEW')
  const clash = await restoreTrash({ alias: s.alias, ids: [file.id], spawnSsh: s.spawnSsh })
  assert.equal(clash.restored.length, 0)
  assert.match(clash.failed[0].reason, /同名/)
  assert.equal(await readFile(join(s.root, 'a.txt'), 'utf8'), 'NEW')

  // 文件夹还原，连里面的东西一起回来
  const dirItem = items.find((i) => i.name === 'dir')
  const back = await restoreTrash({ alias: s.alias, ids: [dirItem.id], spawnSsh: s.spawnSsh })
  assert.deepEqual(back.restored.map((r) => r.path), [join(s.root, 'dir')])
  assert.equal(await readFile(join(s.root, 'dir', 'inner.txt'), 'utf8'), 'I')

  await purgeTrash({ alias: s.alias, ids: [file.id], spawnSsh: s.spawnSsh })
  assert.equal((await listTrash({ alias: s.alias, spawnSsh: s.spawnSsh })).items.length, 0)
  assert.equal(await readFile(join(s.root, 'a.txt'), 'utf8'), 'NEW', '彻底删除只动回收站')
})

test('回收站：清空；编号不对、系统目录、家目录一律拒绝', async () => {
  const s = await sandbox()
  await writeFile(join(s.root, 'x'), '1')
  await writeFile(join(s.root, 'y'), '2')
  await trashEntries({ alias: s.alias, paths: [join(s.root, 'x'), join(s.root, 'y')], spawnSsh: s.spawnSsh })
  await purgeTrash({ alias: s.alias, all: true, spawnSsh: s.spawnSsh })
  assert.equal((await listTrash({ alias: s.alias, spawnSsh: s.spawnSsh })).items.length, 0)

  await assert.rejects(purgeTrash({ alias: s.alias, ids: ['../../etc'], spawnSsh: s.spawnSsh }), /编号不对/)
  await assert.rejects(trashEntries({ alias: s.alias, paths: ['/etc'], spawnSsh: s.spawnSsh }), /系统目录/)
  const home = await trashEntries({ alias: s.alias, paths: [s.home], spawnSsh: s.spawnSsh })
  assert.equal(home.moved.length, 0)
  assert.match(home.failed[0].reason, /家目录/)
  await lstat(s.home) // 还在
})

test('读文件：完整内容带指纹；太大拒绝；日志取结尾；二进制和非 UTF-8 拒绝', async () => {
  const s = await sandbox()
  const conf = join(s.root, 'nginx.conf')
  await writeFile(conf, 'server {\n  listen 80; # 中文注释\n}\n')
  const full = await readText({ alias: s.alias, path: conf, spawnSsh: s.spawnSsh })
  assert.equal(full.content, 'server {\n  listen 80; # 中文注释\n}\n')
  assert.equal(full.truncated, false)
  assert.match(full.sha, /^[0-9a-f]{64}$/)
  assert.equal(await currentSha({ alias: s.alias, path: conf, spawnSsh: s.spawnSsh }), full.sha)

  const big = join(s.root, 'big.log')
  await writeFile(big, `${'前面的行\n'.repeat(2000)}最后一行\n`)
  await assert.rejects(readText({ alias: s.alias, path: big, limit: 1000, spawnSsh: s.spawnSsh }), /超过了/)
  const tail = await readText({ alias: s.alias, path: big, limit: 1000, mode: 'tail', spawnSsh: s.spawnSsh })
  assert.equal(tail.truncated, true)
  assert.ok(tail.content.endsWith('最后一行\n'))
  assert.ok(Buffer.byteLength(tail.content) <= 1000)
  assert.ok(!tail.content.includes('�'), '从中间截开的汉字要丢掉，不留乱码')

  const bin = join(s.root, 'a.bin')
  await writeFile(bin, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]))
  await assert.rejects(readText({ alias: s.alias, path: bin, spawnSsh: s.spawnSsh }), /二进制/)
  const gbk = join(s.root, 'gbk.txt')
  await writeFile(gbk, Buffer.from([0xc4, 0xe3, 0xba, 0xc3])) // 「你好」的 GBK
  await assert.rejects(readText({ alias: s.alias, path: gbk, spawnSsh: s.spawnSsh }), /不是 UTF-8/)
  await assert.rejects(readText({ alias: s.alias, path: s.root, spawnSsh: s.spawnSsh }), /不是一个普通文件/)
})

test('上传新文件：内容对、权限 644', async () => {
  const s = await sandbox()
  const body = Buffer.from('hello 世界\n')
  const res = await uploadFile({ alias: s.alias, path: join(s.root, 'hello.txt'), size: body.length, stream: Readable.from([body]), spawnSsh: s.spawnSsh })
  assert.equal(res.backupPath, null)
  assert.deepEqual(await readFile(join(s.root, 'hello.txt')), body)
  assert.equal(await modeOf(join(s.root, 'hello.txt')), 0o644)
})

test('上传覆盖：原文件先备份，新文件沿用原来的权限；目录里不留临时文件', async () => {
  const s = await sandbox()
  const target = join(s.root, 'secret.conf')
  await writeFile(target, 'old')
  await chmod(target, 0o600)
  const body = Buffer.from('new content')
  const res = await uploadFile({ alias: s.alias, path: target, size: body.length, stream: Readable.from([body]), spawnSsh: s.spawnSsh })
  assert.ok(res.backupPath?.includes('/.cache/dsh-vps/backups/'))
  assert.equal(await readFile(res.backupPath, 'utf8'), 'old')
  assert.equal(await readFile(target, 'utf8'), 'new content')
  assert.equal(await modeOf(target), 0o600, '覆盖不能改掉原来的权限')
  assert.deepEqual(await readdir(s.root), ['secret.conf'])
})

test('上传不完整（中途断了）：原文件不动，临时文件清掉', async () => {
  const s = await sandbox()
  const target = join(s.root, 'index.html')
  await writeFile(target, 'original')
  await assert.rejects(
    uploadFile({ alias: s.alias, path: target, size: 100, stream: Readable.from([Buffer.from('only 20 bytes here..')]), spawnSsh: s.spawnSsh }),
    /不完整/,
  )
  assert.equal(await readFile(target, 'utf8'), 'original')
  assert.deepEqual(await readdir(s.root), ['index.html'])
  await assert.rejects(
    uploadFile({ alias: s.alias, path: join(s.root, 'nope', 'x.txt'), size: 1, stream: Readable.from([Buffer.from('x')]), spawnSsh: s.spawnSsh }),
    /目标文件夹不存在/,
  )
})

test('下载：文件原样；文件夹打成 tar.gz；下载前能看出类型和大小', async () => {
  const s = await sandbox()
  await writeFile(join(s.root, 'a.txt'), 'AAA')
  await mkdir(join(s.root, 'pack'))
  await writeFile(join(s.root, 'pack', 'b.txt'), 'BBB')

  const info = await statPath({ alias: s.alias, path: join(s.root, 'a.txt'), spawnSsh: s.spawnSsh })
  assert.deepEqual({ type: info.type, size: info.size, name: info.name }, { type: 'file', size: 3, name: 'a.txt' })
  assert.equal((await statPath({ alias: s.alias, path: join(s.root, 'pack'), spawnSsh: s.spawnSsh })).type, 'dir')
  await assert.rejects(statPath({ alias: s.alias, path: join(s.root, 'nope'), spawnSsh: s.spawnSsh }), /不存在/)

  const file = await runScript(s.alias, downloadScript({ path: join(s.root, 'a.txt'), type: 'file' }), { spawnSsh: s.spawnSsh })
  assert.equal(file.stdout.toString(), 'AAA')

  const tgz = await runScript(s.alias, downloadScript({ path: join(s.root, 'pack'), type: 'dir' }), { spawnSsh: s.spawnSsh })
  assert.equal(tgz.code, 0)
  assert.equal(tgz.stdout[0], 0x1f)
  assert.equal(tgz.stdout[1], 0x8b, '是 gzip')
  const listing = await new Promise((resolve) => {
    const tar = spawn('tar', ['-tzf', '-'])
    let out = ''
    tar.stdout.on('data', (d) => { out += d })
    tar.on('close', () => resolve(out))
    tar.stdin.end(tgz.stdout)
  })
  assert.match(listing, /pack\/b\.txt/)
  assert.throws(() => downloadScript({ path: '/', type: 'dir' }), /根目录/)
})

test('下载文件名：中文按 RFC 5987 编码', () => {
  const header = attachmentHeader('配置 备份.tar.gz')
  assert.match(header, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/)
  assert.ok(header.includes(encodeURIComponent('配置 备份.tar.gz')))
})
