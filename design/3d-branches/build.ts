// Bundles src/main.js with three.js and inlines it, with the textures, into one index.html.
const dir = import.meta.dir;
const out = await Bun.build({ entrypoints: [dir + '/src/main.js'], minify: true, target: 'browser', format: 'iife' });
if (!out.success) { for (const l of out.logs) console.error(l); process.exit(1); }
const js = (await out.outputs[0].text()).replaceAll('</script', '<\\/script');
const b64 = async (f: string) => 'data:image/jpeg;base64,' + Buffer.from(await Bun.file(dir + '/assets/' + f).arrayBuffer()).toString('base64');
const assets = { barkDiff: await b64('bark_diff_512.jpg'), barkNor: await b64('bark_nor_512.jpg'), barkRough: await b64('bark_rough_512.jpg') };
let html = await Bun.file(dir + '/src/page.html').text();
html = html.replace('/*ASSETS*/', () => 'window.__ASSETS=' + JSON.stringify(assets) + ';').replace('/*APP*/', () => js);
await Bun.write(dir + '/index.html', html);
console.log('index.html', (html.length / 1024).toFixed(0) + ' KB');
