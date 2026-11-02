import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'node_modules/@ffmpeg/core/dist/umd')
const destination = resolve(root, 'public/ffmpeg')

await mkdir(destination, { recursive: true })
for (const filename of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await copyFile(resolve(source, filename), resolve(destination, filename))
}
