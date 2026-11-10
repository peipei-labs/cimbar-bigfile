'use strict';
// Run: PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-send-clipboard.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const runCases = async (page) => {
  const requests = [];
  const onRequest = request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(page.url()).origin) requests.push(request.url()); };
  page.on('request', onRequest);
  const results = await page.evaluate(async () => {
    const checks = [];
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const test = async (name, body) => { try { await body(); checks.push({name, pass:true}); } catch (error) { checks.push({name, pass:false, error:String(error)}); } };
    const reset = () => { $('btnClearBundle').click(); };
    const paths = () => State.bundleItems.map(item => item.path);
    const txtItems = () => State.bundleItems.filter(item => item.file.type.startsWith('text/plain'));
    const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9sAAAAASUVORK5CYII='), c=>c.charCodeAt(0));
    const image = (name='picture.png', bytes=pngBytes) => new File([bytes], name, {type:'image/png'});
    const file = (name='existing.bin', content='existing') => new File([content], name, {type:'application/octet-stream'});
    const transfer = ({files=[],text='',html=''}={}) => {
      const data = new DataTransfer();
      for (const f of files) data.items.add(f);
      if (text) data.setData('text/plain',text);
      if (html) data.setData('text/html',html);
      return data;
    };
    let lastPaste = null;
    const originalStageClipboard = stageClipboard;
    stageClipboard = data => (lastPaste = originalStageClipboard(data));
    const paste = async (options, target=document.body) => {
      lastPaste = null;
      const event = new ClipboardEvent('paste', {clipboardData:transfer(options),bubbles:true,cancelable:true});
      target.dispatchEvent(event);
      if (lastPaste) await lastPaste;
      return event.defaultPrevented;
    };
    await test('ordinary file paste ignores accompanying file-manager path text', async () => {
      reset();await paste({files:[file('report.pdf')],text:'C:\\documents\\report.pdf'});
      assert(State.bundleItems.length===1 && paths()[0]==='report.pdf','file-only paste gained a TXT');
    });
    await test('new direct selection cancels pending pasted images', async () => {
      reset();await stageFiles([file('previous.bin')]);
      const nativeFetch=window.fetch;let release;
      window.fetch=(...args)=>new Promise(resolve=>{release=()=>resolve(nativeFetch(...args));});
      try {
        const pending=stageClipboard(transfer({text:'stale',html:'stale<img src="data:image/png;base64,'+btoa(String.fromCharCode(...pngBytes))+'">'}));
        await Promise.resolve();await prepareFile(file('replacement.bin'));release();await pending;
        assert(State.bundleItems.length===0 && State.file.name==='replacement.bin' && State.chunks.length===1,'stale paste replaced new file');
      } finally {window.fetch=nativeFetch;}
    });
    await test('adding during single-file preparation preserves both selected files', async () => {
      reset();const slow=file('preparing.bin');const nativeRead=slow.arrayBuffer.bind(slow);let release;
      Object.defineProperty(slow,'arrayBuffer',{value:()=>new Promise(resolve=>{release=()=>resolve(nativeRead());})});
      const pending=prepareFile(slow);await stageFiles([file('added.bin')]);release();await pending;
      assert(paths().join(',')==='preparing.bin,added.bin' && State.chunks.length===0,'preparing file or new item lost');
    });
    await test('numeric text with an embedded image still stages both', async () => {
      reset();const src='data:image/png;base64,'+btoa(String.fromCharCode(...pngBytes));
      assert(await paste({text:'12',html:'<p>12<img src="'+src+'"></p>'},$('fps')),'mixed number/image paste ignored');
      assert(State.bundleItems.length===2 && (await txtItems()[0].file.text()).startsWith('12'),'number or image dropped');
    });
    await test('numbered list markers survive mixed clipboard conversion', async () => {
      reset();await paste({text:'1. First\n2. Second\nEnd',html:'<ol><li>First</li><li>Second</li></ol><img src="remote.png"><p>End</p>'});
      assert(await txtItems()[0].file.text()==='1. First\n2. Second\n[Image not extracted: remote.png]\nEnd','ordered list numbers lost');
    });
    await test('ordered lists preserve start, item values and reversed counting', async () => {
      for (const [markup,expected] of [
        ['<ol start="3"><li>Third<img src="cid:0"></li><li value="8">Eighth</li><li>Ninth</li></ol>','3. Thirdpicture.png\n8. Eighth\n9. Ninth'],
        ['<ol reversed><li>Third</li><li>Second</li><li>First<img src="cid:0"></li></ol>','3. Third\n2. Second\n1. Firstpicture.png'],
        ['<ol reversed start="0"><li>Zero<img src="cid:0"></li><li>Negative</li></ol>','0. Zeropicture.png\n-1. Negative'],
      ]) {
        reset();await paste({files:[image()],text:'list',html:markup});
        assert(await txtItems()[0].file.text()===expected,'list ordinal changed: '+markup);
      }
    });
    await test('alphabetic and Roman ordered-list labels are preserved', async () => {
      for (const [type,start,expected] of [['a',26,'z. Firstpicture.png\naa. Second'],['A',26,'Z. Firstpicture.png\nAA. Second'],['i',4,'iv. Firstpicture.png\nv. Second'],['I',9,'IX. Firstpicture.png\nX. Second']]) {
        reset();await paste({files:[image()],text:'list',html:'<ol type="'+type+'" start="'+start+'"><li>First<img src="cid:0"></li><li>Second</li></ol>'});
        assert(await txtItems()[0].file.text()===expected,'list label style changed: '+type);
      }
    });
    await test('nested unordered lists keep bullets and indentation', async () => {
      reset();await paste({files:[image()],text:'Parent Child Next',html:'<ol><li>Parent<ul><li>Child<img src="cid:0"></li><li>Child2</li></ul></li><li>Next</li></ol>'});
      assert(await txtItems()[0].file.text()==='1. Parent\n  • Childpicture.png\n  • Child2\n2. Next','nested list structure lost');
    });
    await test('paragraphs inside list items keep their first-line markers', async () => {
      reset();await paste({files:[image()],text:'1. First\nMore\n2. Next',html:'<ol><li><p>First<img src="cid:0"></p><p>More</p></li><li><div>Next</div></li></ol>'});
      assert(await txtItems()[0].file.text()==='1. Firstpicture.png\nMore\n2. Next','list paragraph separated from marker');
    });
    await test('empty list items retain their ordinal positions', async () => {
      reset();await paste({files:[image()],text:'1.\n2. Text',html:'<ol><li></li><li>Text<img src="cid:0"></li></ol>'});
      assert(await txtItems()[0].file.text()==='1.\n2. Textpicture.png','empty item numbering lost');
    });
    await test('invalid list counters fall back without blocking extraction', async () => {
      reset();const huge='9'.repeat(400);
      await paste({files:[image()],text:'list',html:'<ol type="a" start="'+huge+'"><li value="'+huge+'">First<img src="cid:0"></li><li>Second</li></ol>'});
      assert(await txtItems()[0].file.text()==='a. Firstpicture.png\nb. Second','invalid counters did not fall back');
    });
    let mixedExample;
    await test('existing multiple files + text paste from Add files focus', async () => {
      reset(); await stageFiles([file('one.bin'), file('two.bin')]);
      $('btnAddFiles').focus();
      assert(await paste({text:'第三项\nkeep all'}, document.activeElement), 'paste not handled');
      assert(State.bundleItems.length===3, 'existing files lost');
      assert(await txtItems()[0].file.text()==='第三项\nkeep all', 'text changed');
    });
    await test('paste on file picker, dropdown, FPS and redundancy controls', async () => {
      for (const id of ['bundleFileInput','bundleDirInput','fileInput','chunkSize','fps','redundancy']) {
        const before=State.bundleItems.length;
        assert(await paste({text:'non-numeric note'}, $(id)), id+' skipped');
        assert(State.bundleItems.length===before+1,id+' did not append');
      }
    });
    await test('numeric parameter paste and real text editing remain native', async () => {
      const before=State.bundleItems.length;
      assert(!await paste({text:'18'},$('fps')),'number paste intercepted');
      assert(!await paste({text:'12',html:'<span>12</span>'},$('fps')),'rich numeric paste intercepted');
      const input=document.createElement('textarea'); document.body.appendChild(input);
      try { assert(!await paste({text:'editable note'},input),'text editor paste intercepted'); }
      finally { input.remove(); }
      assert(State.bundleItems.length===before,'native paste staged data');
    });
    await test('prepare a single file then add files preserves original', async () => {
      reset(); await prepareFile(file('prepared.bin','original'));
      assert(State.chunks.length===1,'single file not prepared');
      await stageFiles([file('added.bin')]);
      assert(paths().join(',')==='prepared.bin,added.bin','prepared file lost');
      assert(State.chunks.length===0,'old transfer remained ready');
    });
    await test('prepare a single file then paste text preserves original', async () => {
      reset(); await prepareFile(file('prepared.bin'));
      await paste({text:'append text'});
      assert(paths()[0]==='prepared.bin' && State.bundleItems.length===2,'original lost on paste');
    });
    await test('folder paths and direct/archive rules', async () => {
      reset(); const f=file('a.bin');
      Object.defineProperty(f,'webkitRelativePath',{value:'folder/a.bin'});
      await stageFiles([f]);
      assert(paths()[0]==='folder/a.bin' && shouldArchiveBundle(State.bundleItems),'folder path lost');
      await stageFiles([]); assert(State.bundleItems.length===1,'cancel cleared selection');
      reset(); await stageFiles([file()]);
      assert(!shouldArchiveBundle(State.bundleItems),'single ordinary file archived');
    });
    await test('mixed CID image, collision filename, full text and exact bytes', async () => {
      reset(); await stageFiles([file('picture.png','old')]);
      await paste({files:[image()],text:'前文 后文\n第二行',html:'<p>前文 <img src="cid:0"> 后文</p><p>第二行</p>'});
      const textItem=txtItems()[0]; const text=await textItem.file.text();
      assert(text==='前文 picture-2.png 后文\n第二行','wrong inline filename or paragraph: '+text);
      assert(State.bundleItems.length===3,'wrong number of files');
      const bytes=new Uint8Array(await State.bundleItems[1].file.arrayBuffer());
      assert(bytes.every((b,i)=>b===pngBytes[i]) && bytes.length===pngBytes.length,'image changed');
      mixedExample={paths:paths(),text};
    });
    await test('same-name same-size images map to distinct CID items', async () => {
      reset();
      await paste({files:[image('same.png',new Uint8Array([1,2])),image('same.png',new Uint8Array([3,4]))],text:'left right',html:'<div>left<img src="cid:0">middle<img src="cid:1">right</div>'});
      assert(await txtItems()[0].file.text()==='leftsame.pngmiddlesame-2.pngright','CID image mapping confused');
      assert(new Uint8Array(await State.bundleItems[1].file.arrayBuffer())[0]===3,'second image bytes lost');
    });
    await test('CID indices include preceding clipboard text items', async () => {
      reset(); const d=new DataTransfer(); d.setData('text/plain','a b');d.items.add(image()); d.setData('text/html','a<img src="cid:1">b');
      await stageClipboard(d);
      assert(State.clipboardMissingImages===0,'CID string index treated as file index');
      assert(await txtItems()[0].file.text()==='apicture.pngb','CID index wrong');
    });
    await test('Word-style file references and named CID references', async () => {
      for (const src of ['file:///C:/Temp/image001.png','cid:image001.png@document']) {
        reset(); await paste({files:[image('image001.png'),image('other.png')],text:'before after',html:'<p>before<img src="'+src+'">after</p>'});
        assert(State.clipboardMissingImages===0,'reference did not match '+src);
        assert((await txtItems()[0].file.text()).includes('beforeimage001.pngafter'),'wrong named reference');
      }
    });
    await test('repeated HTML image references reuse one file', async () => {
      reset(); await paste({files:[image()],text:'a b c',html:'a<img src="cid:0">b<img src="cid:0">c'});
      assert(State.bundleItems.length===2,'duplicate image file');
      assert(await txtItems()[0].file.text()==='apicture.pngbpicture.pngc','repeated image not referenced');
    });
    await test('embedded data image extraction and repeated-source deduplication', async () => {
      reset(); const src='data:image/png;base64,'+btoa(String.fromCharCode(...pngBytes));
      await paste({text:'before middle after',html:'<p>before<img src="'+src+'">middle<img src="'+src+'">after</p>'});
      assert(State.bundleItems.length===2,'embedded image duplicated');
      const path=State.bundleItems[0].path;
      assert(await txtItems()[0].file.text()==='before'+path+'middle'+path+'after','embedded positions lost');
      const bytes=new Uint8Array(await State.bundleItems[0].file.arrayBuffer());
      assert(bytes.length===pngBytes.length && bytes.every((b,i)=>b===pngBytes[i]),'embedded bytes changed');
    });
    await test('clipboard file and embedded representation deduplicate by content', async () => {
      reset();const src='data:image/png;base64,'+btoa(String.fromCharCode(...pngBytes));
      await paste({files:[image('original.png')],text:'start end',html:'start<img src="'+src+'">end'});
      assert(State.bundleItems.length===2,'same data saved twice');
      assert(await txtItems()[0].file.text()==='startoriginal.pngend','original filename not used');
    });
    await test('plain mixed paste appends actual collision-resolved image names', async () => {
      reset(); await stageFiles([file('picture.png')]);
      await paste({files:[image()],text:'plain\ntext'});
      assert(await txtItems()[0].file.text()==='plain\ntext\n\npicture-2.png','plain fallback wrong');
    });
    await test('pure text exact whitespace and image-only paste', async () => {
      reset(); await paste({text:'  缩进\r\nsecond\tline\n'});
      assert(await txtItems()[0].file.text()==='  缩进\r\nsecond\tline\n','plain text changed');
      reset(); await paste({files:[image()]});
      assert(State.bundleItems.length===1 && txtItems().length===0,'image-only gained a text file');
      reset(); await paste({html:'<img src="data:image/png;base64,'+btoa(String.fromCharCode(...pngBytes))+'">'});
      assert(State.bundleItems.length===1 && txtItems().length===0,'embedded image-only gained text file');
    });
    await test('HTML-only paragraphs and table cells retain text order', async () => {
      reset();await paste({html:'<div>one<br>two</div><table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>'});
      assert(await txtItems()[0].file.text()==='one\ntwo\nA\tB\nC\tD','HTML text layout wrong');
    });
    await test('unavailable images have text markers and visible translated notice', async () => {
      reset();await paste({text:'before after',html:'<p>before<img alt="diagram" src="https://example.invalid/private.png">after</p><script>window.__clipboardScriptRan=true</script><iframe src="https://example.invalid/frame"></iframe>'});
      assert(State.clipboardMissingImages===1,'missing count wrong');
      assert(!$('clipboardNotice').hidden,'warning invisible');
      assert((await txtItems()[0].file.text()).includes('[Image not extracted: diagram]'),'missing image unmarked');
      assert(!window.__clipboardScriptRan,'clipboard script ran');
      applyLocale('zh-CN',false);
      assert($('clipboardNotice').textContent.includes('未能从剪贴板提取'),'warning locale stale');
      applyLocale('en',false); reset();
      assert($('clipboardNotice').hidden,'clear did not clear warning');
    });
    await test('ambiguous images retain files and mark positions without guessing', async () => {
      reset();await paste({files:[image('one.png'),image('two.png')],text:'text',html:'<p>A<img src="https://example.invalid/a.png">B<img src="https://example.invalid/b.png">C</p>'});
      const text=await txtItems()[0].file.text();
      assert(State.clipboardMissingImages===2,'ambiguous images guessed');
      assert(text.includes('one.png\ntwo.png'),'unmapped files missing from text');
      assert(State.bundleItems.length===3,'available files dropped');
    });
    await test('malformed embedded image reports failure without losing text', async () => {
      reset();await paste({text:'kept',html:'<p>kept<img src="data:image/png;base64,!!!"></p>'});
      assert(State.clipboardMissingImages===1 && State.bundleItems.length===1,'invalid image mishandled');
      assert((await txtItems()[0].file.text()).startsWith('kept'),'text discarded');
    });
    await test('archive names, text references and image bytes match', async () => {
      reset();await paste({files:[image()],text:'before after',html:'before<img src="cid:0">after'});
      const tar=await createTarFile(State.bundleItems);const bytes=new Uint8Array(await tar.arrayBuffer());
      const dec=new TextDecoder();const entries=new Map();
      for(let offset=0;offset+512<=bytes.length;){
        const h=bytes.subarray(offset,offset+512);
        const name=dec.decode(h.subarray(0,100)).replace(/\0.*$/,'');
        if(!name)break;
        const prefix=dec.decode(h.subarray(345,500)).replace(/\0.*$/,'');
        const size=parseInt(dec.decode(h.subarray(124,136)).replace(/\0.*$/,'').trim(),8)||0;
        entries.set(prefix?prefix+'/'+name:name,bytes.slice(offset+512,offset+512+size));
        offset+=512+Math.ceil(size/512)*512;
      }
      assert(entries.size===2,'wrong TAR entries');
      assert(entries.get('picture.png').every((b,i)=>b===pngBytes[i]),'TAR image changed');
      const txt=State.bundleItems.find(i=>i.path.endsWith('.txt'));
      assert(dec.decode(entries.get(txt.path))==='beforepicture.pngafter','TAR text filename reference wrong');
    });
    await test('clear cancels pending image extraction', async () => {
      reset();await stageFiles([file()]);
      const nativeFetch=window.fetch;let release;
      window.fetch=(...args)=>new Promise(resolve=>{release=()=>resolve(nativeFetch(...args));});
      try{
        const pending=stageClipboard(transfer({text:'late',html:'late<img src="data:image/png;base64,'+btoa(String.fromCharCode(...pngBytes))+'">'}));
        await Promise.resolve();$('btnClearBundle').click();release();await pending;
        assert(State.bundleItems.length===0,'cleared paste returned');
      }finally{window.fetch=nativeFetch;}
    });
    await test('new additions survive concurrent pending image extraction', async () => {
      reset();const nativeFetch=window.fetch;let release;
      window.fetch=(...args)=>new Promise(resolve=>{release=()=>resolve(nativeFetch(...args));});
      try{
        const pending=stageClipboard(transfer({text:'late',html:'late<img src="data:image/png;base64,'+btoa(String.fromCharCode(...pngBytes))+'">'}));
        await Promise.resolve();await stageFiles([file('added-while-pasting.bin')]);release();await pending;
        assert(State.bundleItems.length===3 && paths().includes('added-while-pasting.bin'),'concurrent addition lost');
      }finally{window.fetch=nativeFetch;}
    });
    reset();await stageFiles([file('existing-report.pdf'),file('existing-data.csv')]);
    await paste({files:[image('diagram.png')],text:'说明\n图片\n后续文字',html:'<p>说明</p><p><img src="cid:0"></p><p>后续文字</p>'});
    stageClipboard=originalStageClipboard;
    return {checks,mixedExample,finalPaths:paths(),ready:wasmReady};
  });
  page.off('request', onRequest);
  return {...results,unexpectedNetworkRequests:requests};
};
async function main() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + decodeURIComponent(pathname));
      if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const bytes = await fs.promises.readFile(file);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' }[path.extname(file)] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type }); response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'cimbar-clipboard-'));
    for (const standalone of [false, true]) {
      const context = await browser.newContext({ offline: standalone, viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        const target = standalone ? pathToFileURL(path.join(root, 'send.standalone.html')).href
          : 'http://127.0.0.1:' + server.address().port + '/send.html';
        await page.goto(target);
        await page.waitForFunction(() => typeof wasmReady !== 'undefined' && wasmReady);
        assert.equal(await page.title(), 'cimbar-bigfile · Sender');
        assert.ok(await page.locator('#btnAddFiles').isVisible(), 'sender must render');
        const result = await runCases(page);
        const failed = result.checks.filter(check => !check.pass);
        console.log(JSON.stringify({ target, cases: result.checks.length, failed, errors, network: result.unexpectedNetworkRequests }));
        await page.screenshot({ path: path.join(evidence, standalone ? 'standalone.png' : 'source.png'), fullPage: true });
        assert.deepEqual(failed, [], 'clipboard scenarios must pass');
        assert.deepEqual(errors, [], 'no unexpected application errors');
        assert.deepEqual(result.unexpectedNetworkRequests, [], 'clipboard markup must not request remote resources');
      } finally { await context.close(); }
    }
    console.log('Browser screenshots: ' + evidence);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
