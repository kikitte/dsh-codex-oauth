/** Install the distribution, not a linked checkout that hides dependency shadowing. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('DSH host peers and installed development SDKs target the same release', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  for (const [id, version] of Object.entries(manifest.devDependencies)) {
    if (!id.startsWith('@deepseek-ai/dsh-')) continue
    const installed = JSON.parse(await readFile(new URL(import.meta.resolve(`${id}/package.json`)), 'utf8'))
    assert.equal(installed.version, version, `${id}: reinstall development dependencies before testing`)
    if (Object.hasOwn(manifest.peerDependencies, id)) {
      assert.equal(manifest.peerDependencies[id], version, `${id}: host requirement must match the tested SDK`)
    }
  }
})

test('packed plugin keeps host peers external with Harness peer installation disabled in either layout', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codex-packaging-'))
  try {
    const packed = Object.values(JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--cache', join(temp, 'npm-cache'), '--pack-destination', temp], { cwd: root, encoding: 'utf8' })))
    const archive = join(temp, packed[0].filename)
    for (const layout of ['hoisted', 'isolated']) {
      // Harness supplies these peers from its runtime resolution instead of
      // installing copies in the profile. Match its autoInstallPeers policy.
      const profile = join(temp, layout)
      await mkdir(profile)
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        private: true,
        dependencies: { 'dsh-codex-oauth': `file:${archive}` },
      }))
      await writeFile(join(profile, 'pnpm-workspace.yaml'), `packages:\n  - .\nnodeLinker: ${layout}\nautoInstallPeers: false\n`)
      execFileSync('pnpm', ['install', '--offline', '--ignore-scripts'], { cwd: profile, stdio: 'pipe' })
      const modules = join(profile, 'node_modules')
      const installed = join(modules, 'dsh-codex-oauth')
      const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
      for (const field of ['dependencies', 'optionalDependencies']) {
        assert.deepEqual(Object.keys(manifest[field] ?? {}), [], `${layout}: ${field}`)
      }
      for (const id of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-authorization', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-typert-protocol']) {
        assert.equal(typeof manifest.peerDependencies?.[id], 'string', `${layout}: missing shared host peer ${id}`)
        assert.equal(typeof manifest.devDependencies?.[id], 'string', `${layout}: missing development copy ${id}`)
      }
      for (const hook of ['prepare', 'preinstall', 'install', 'postinstall', 'prepack']) {
        assert.equal(manifest.scripts?.[hook], undefined, hook)
      }
      // Both entry points must be distributed even when builds are denied.
      assert.match(await readFile(join(installed, 'lib/index.js'), 'utf8'), /CodexAuthService/)
      assert.match(await readFile(join(installed, 'client/client.js'), 'utf8'), /window\.__ModuleLoader__\.load/)
      const scope = await readdir(join(modules, '@deepseek-ai')).catch(error => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      assert.deepEqual(scope, [], `${layout}: profile must not shadow host services`)
      assert.doesNotMatch(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8'), /^  ['"]?@deepseek-ai\//m)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
