import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { ROOT } from './config.js';
export async function buildPage() {
 const pageData = JSON.parse(readFileSync(resolve(ROOT,'owner-promote/release-data.json'),'utf8'));
 const bundle = await build({entryPoints:[resolve(ROOT,'scripts/owner-promote-browser.ts')],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',minify:true,legalComments:'none',define:{'__PAGE_DATA__':JSON.stringify(pageData)}});
 const template=readFileSync(resolve(ROOT,'scripts/owner-promote-template.html'),'utf8');
 writeFileSync(resolve(ROOT,'owner-promote/index.html'),template.replace('/* BUNDLE */',bundle.outputFiles[0].text.replaceAll('</script','<\\/script')));
}
await buildPage();
