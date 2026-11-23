import { cp, mkdir, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Nitro's traced node_modules contain absolute symlinks back into the build
 * checkout (e.g. server/node_modules/<pkg> -> <source>/server/node_modules/.nf3/<pkg>).
 * Rewritten to relative links pointing at the mirrored path inside the packaged
 * tree so the result stays portable. Links escaping the source tree are left
 * for the host packager's assertPortableLinks check to refuse. */
async function relativizeSourceLinks(source, directory) {
  const sourceReal = await realpath(source)
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      if (item.isSymbolicLink()) {
        const link = await readlink(path)
        if (isAbsolute(link)) {
          const mirrored = relative(sourceReal, resolve(dirname(path), link))
          if (mirrored !== '..' && !mirrored.startsWith('../') && !isAbsolute(mirrored)) {
            await unlink(path)
            await symlink(relative(dirname(path), join(directory, mirrored)), path)
          }
        }
      } else if (item.isDirectory()) await walk(path)
    }
  }
  await walk(directory)
}

/** Package the separately built Eve Node output beside the app and copy its
 * runtime resources. Both outputs must have come from the same revision. */
export async function packageEve({ root = process.cwd(), preset = process.env.NITRO_PRESET || 'node-server' } = {}) {
  if (preset !== 'node-server') throw new Error('EVE_BUILD_PRESET_INVALID')
  const source = join(root, 'apps/eve/.output')
  const output = join(root, '.output')
  const agent = JSON.parse(await readFile(join(source, 'mikka-eve-build.json'), 'utf8'))
  const appPath = join(output, 'mikka-build.json')
  const app = JSON.parse(await readFile(appPath, 'utf8'))
  if (agent.version !== 1 || agent.eve !== '1.3.0' || agent.revision !== app.revision || agent.preset !== preset) throw new Error('EVE_APP_BUILD_MISMATCH')
  await cp(source, join(output, 'eve'), { recursive: true, verbatimSymlinks: true })
  await relativizeSourceLinks(source, join(output, 'eve'))
  for (const resource of app.resources) {
    const destination = join(output, 'eve', resource.path)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(output, resource.path), destination)
  }
  app.eve = agent
  await writeFile(appPath, `${JSON.stringify(app, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageEve()
