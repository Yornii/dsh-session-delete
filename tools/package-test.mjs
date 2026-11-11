/**
 * Package metadata test: keeps the published package name, the Client module
 * id, the bundle patch and the export map from drifting apart.
 *
 * Run with `npm test` (or `node tools/package-test.mjs`).
 */
import { readFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let failures = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name} ${detail}`)
  }
}

const read = (path) => readFile(join(root, path), 'utf8')
const pkg = JSON.parse(await read('package.json'))
const client = await read('client.js')
const patch = await read('cordis.patch.yml')

check('package: name is set', typeof pkg.name === 'string' && pkg.name.length > 0)
check('package: is MIT-licensed', pkg.license === 'MIT', String(pkg.license))
check('package: keeps the module entry', pkg.type === 'module' && pkg.exports?.['.'] === './index.js')

const moduleId = client.match(/id:\s*'([^']+)'/u)?.[1]
check('client: module id matches the package name', moduleId === pkg.name, `${moduleId} != ${pkg.name}`)
check('client: factory is registered', /factory\(require\)\s*\{/u.test(client))

check('bundle: patch points at the package', patch.includes(`name: '${pkg.name}'`), patch.trim())
check('bundle: patch declares a plugin id', /-\s+id:\s+\S+/u.test(patch))

check('client: bundle declares the web platform', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('client: bundle declares injections', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0)
check('bundle: package declares a patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')

for (const [subpath, file] of [
  ['./client', './client.js'],
  ['./icon', './icon.svg'],
]) {
  check(`exports: ${subpath} -> ${file}`, pkg.exports?.[subpath] === file)
  let exists = true
  try {
    await access(join(root, file))
  } catch {
    exists = false
  }
  check(`exports: ${file} exists`, exists)
}

for (const locale of ['en', 'zh']) {
  const meta = JSON.parse(await read(`locale/${locale}.json`))
  check(`locale: ${locale} has a title`, typeof meta.meta?.title === 'string' && meta.meta.title.length > 0)
  check(`locale: ${locale} has a description`, typeof meta.meta?.description === 'string' && meta.meta.description.length > 0)
}

check('files: ships the Host and Client halves', ['index.js', 'client.js'].every((file) => pkg.files?.includes(file)))
check('files: ships the bundle patch', pkg.files?.includes('cordis.patch.yml'))

console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
