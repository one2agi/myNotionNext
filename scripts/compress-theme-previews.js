#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs')
const path = require('node:path')

let sharp
try {
  sharp = require('sharp')
} catch (error) {
  console.error(
    'Missing dependency "sharp". This script is OPTIONAL (not used by yarn build / yarn export).'
  )
  console.error(
    'To use this perf tool, install sharp locally: yarn add -D sharp'
  )
  console.error(
    '(sharp is removed from package.json devDependencies because EdgeOne build container has limited /dev/shm disk, and yarn 1.x downloads all 24 sharp platform variants regardless of build target.)'
  )
  process.exit(1)
}

const previewDir = path.join(process.cwd(), 'public/images/themes-preview')
const quality = Number(process.env.THEME_PREVIEW_WEBP_QUALITY || 78)

async function main() {
  if (!fs.existsSync(previewDir)) {
    console.error('Theme preview directory not found:', previewDir)
    process.exit(1)
  }

  const pngFiles = fs
    .readdirSync(previewDir)
    .filter(name => name.toLowerCase().endsWith('.png'))

  if (pngFiles.length === 0) {
    console.log('No PNG preview files found.')
    return
  }

  let totalSaved = 0
  for (const fileName of pngFiles) {
    const sourcePath = path.join(previewDir, fileName)
    const targetPath = sourcePath.replace(/\.png$/i, '.webp')

    const before = fs.statSync(sourcePath).size
    await sharp(sourcePath).webp({ quality }).toFile(targetPath)
    const after = fs.statSync(targetPath).size
    totalSaved += Math.max(0, before - after)

    console.log(
      `${fileName} -> ${path.basename(targetPath)} | ${Math.round(
        (1 - after / before) * 100
      )}% smaller`
    )
  }

  console.log(`Done. Total estimated savings: ${(totalSaved / 1024).toFixed(1)} KB`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
