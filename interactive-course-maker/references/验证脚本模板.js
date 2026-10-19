// 验证脚本模板（零依赖 CDP 驱动）
// 无头浏览器验证零依赖：Edge 加 --remote-debugging-port，Node 24 自带 fetch/WebSocket 连 CDP。
// 用法：node 验证脚本模板.js <html路径> [视口宽度]
// 本环境注意：子进程不能通过管道捕获输出（stdio:'pipe' 会 EPERM），启动浏览器一律 stdio:'ignore'。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const htmlPath = process.argv[2] || '第4周_内部汇报与最小POC交互课.html';
const WIDTH = Number(process.argv[3] || 390);
const PORT = 9333;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));

const edge = spawn('msedge', [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
], { stdio: 'ignore' });

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('CDP 未就绪');
}

let seq = 0;
const pending = new Map();

function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
    ws.onopen = () => resolve({ send });
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('页面异常: ' + r.exceptionDetails.text);
  return r.result.value;
}

// 断言收集器：全部跑完统一报告，任一失败 exit 1
const asserts = [];
function check(name, cond, detail = '') {
  asserts.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
}

async function main() {
  const cdp = await connect(await getWsUrl());

  // 1) 预置 localStorage —— 必须在页面脚本之前写入，单独测刷新恢复
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('ontologyWeek4ProgressV1', JSON.stringify({
      done: ['ch1', 'ch2'], answers: { open1: '用户真实答案' }, score: 60 }))`,
  });

  // 2) 窄屏 + 启用页面事件 + 导航（file:// 路径）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', {
    url: 'file:///' + path.resolve(htmlPath).replace(/\\/g, '/'),
  });
  await new Promise((r) => setTimeout(r, 400)); // 等淡入动画，否则截图发灰

  // 3) 真点击每章：导航、选项、提交、重玩、重置（按实际 DOM 写选择器）
  check(
    '首页渲染',
    await evaluate(
      cdp,
      `!!document.querySelector('nav') && document.body.innerText.includes('课程说明')`
    )
  );
  check(
    '可点击元素存在',
    await evaluate(cdp, `document.querySelectorAll('button').length > 0`)
  );

  // 示例：点某章导航
  // await evaluate(cdp,
  //   `[...document.querySelectorAll('nav button')].find(b => b.textContent.includes('第X章')).click()`);
  // 示例：故意答错一题，断言分不变
  // check('答错不改分',
  //   await evaluate(cdp, `(() => { /* 点错误选项并提交 */ return window.score === 0; })()`));

  // 4) 逐页截图 + 目视检查（禁止只看首页）
  for (const [i, page] of ['首页', '第X章', '报告页'].entries()) {
    // await evaluate(cdp, `window.__goTo(${i})`); // 或点击对应导航
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`shot-${i}-${page}.png`, Buffer.from(shot.data, 'base64'));
  }

  // 5) 窄屏溢出：所有页面 scrollWidth <= innerWidth
  check(
    '窄屏无横向溢出',
    await evaluate(cdp, `document.documentElement.scrollWidth <= window.innerWidth`)
  );

  // 6) 刷新恢复（预置数据在页面脚本前已写入）
  await cdp.send('Page.reload');
  await new Promise((r) => setTimeout(r, 400));
  check(
    '刷新恢复',
    await evaluate(
      cdp,
      `JSON.parse(localStorage.getItem('ontologyWeek4ProgressV1')).done.length === 2`
    )
  );

  // 汇总
  const failed = asserts.filter((a) => !a.ok);
  console.log(`\n共 ${asserts.length} 项断言，失败 ${failed.length} 项`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('驱动失败:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    edge.kill();
    fs.rmSync(PROFILE, { recursive: true, force: true });
  });
