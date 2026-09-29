/**
 * 复现连接更新「拒绝后串改」问题：
 * 把一条连接的两端改成另一条现存无向连接的端点（同时改耗时），接口返回 409 后，
 * 检查内存（GET /api/data）与数据文件是否保持原样；再做一次合法保存，
 * 检查脏状态是否被写入文件；最后验证合法编辑一次生效且走位校验按新连接重算。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-edge-fix-'));
const PORT = 3456;

function fail(msg) {
  console.error('❌ FAIL:', msg);
  process.exitCode = 1;
}
function ok(msg) {
  console.log('✅', msg);
}

async function api(p, method = 'GET', body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function waitForServer(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/data`);
      if (r.ok) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('server did not start');
}

async function main() {
  const env = { ...process.env, DATA_DIR: TMP, PORT: String(PORT) };
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  await waitForServer(proc);

  try {
    // 初始状态：edge-center-down 为 舞台中央↔舞台前区 耗时 3；edge-wingr-center 为 侧台右↔舞台中央 耗时 4
    const e1 = (await api('/api/data')).json.edges.find((e) => e.id === 'edge-center-down');
    const e2 = (await api('/api/data')).json.edges.find((e) => e.id === 'edge-wingr-center');
    if (e1.a !== 'area-center' || e1.b !== 'area-downstage' || e1.seconds !== 3) fail('初始数据不符合预期 edge-center-down');

    // 校验基线（种子数据刻意包含超时 / 不可达演示区段）：409 后结果必须与之逐字一致
    // generatedAt 为每次请求的时间戳，比对时剔除
    const stable = (r) => JSON.stringify({ ...r, generatedAt: null });
    const validationBaseline = stable((await api('/api/validate?mode=classic')).json);
    const validationBaselineP = stable((await api('/api/validate?mode=propagate')).json);

    const fileBefore = fs.readFileSync(path.join(TMP, 'data.json'), 'utf8');
    const mtimeBefore = fs.statSync(path.join(TMP, 'data.json')).mtimeMs;

    // 1) 冲突编辑：两端改成另一条现存连接（含反方向），同时把耗时改成 99、容量改成 9、加封闭时段
    const conflictBody = {
      a: 'area-wing-r',
      b: 'area-center', // 与 e2 的端点对完全相同（无向）
      seconds: 99,
      capacity: 9,
      closures: [{ start: 100, end: 200 }],
    };
    const r1 = await api(`/api/edges/${e1.id}`, 'PUT', conflictBody);
    if (r1.status !== 409) fail(`冲突编辑应返回 409，实际 ${r1.status}`);
    else ok('冲突编辑返回 409');

    // 2) 409 后内存状态必须保持原样（GET 查询）
    const after = (await api('/api/data')).json.edges;
    const a1 = after.find((e) => e.id === e1.id);
    const a2 = after.find((e) => e.id === e2.id);
    const memClean =
      a1.a === 'area-center' && a1.b === 'area-downstage' && a1.seconds === 3 &&
      (!a1.capacity || a1.capacity === 1) &&
      JSON.stringify(a1.closures || []) === '[]' &&
      a2.a === 'area-wing-r' && a2.b === 'area-center' && a2.seconds === 4 &&
      JSON.stringify(a2.closures || []) === JSON.stringify([{ start: 10, end: 14 }]) &&
      after.length === 11;
    if (!memClean) {
      fail(`409 后内存被串改：\n${JSON.stringify({ a1, a2, n: after.length }, null, 2)}`);
    } else ok('409 后 GET 查询读到的连接仍为原样（内存未变）');

    // 3) 409 后走位校验必须与冲突前完全一致（两种模式），不能读到串改后的连接
    const vNow = stable((await api('/api/validate?mode=classic')).json);
    const vNowP = stable((await api('/api/validate?mode=propagate')).json);
    if (vNow !== validationBaseline || vNowP !== validationBaselineP) {
      fail('409 后走位校验结果发生变化，说明读到了串改后的连接');
    } else ok('409 后两种模式的走位校验结果均与冲突前完全一致');

    // 4) 数据文件不应在 409 请求中被写入
    const fileAfter409 = fs.readFileSync(path.join(TMP, 'data.json'), 'utf8');
    if (fileAfter409 !== fileBefore || fs.statSync(path.join(TMP, 'data.json')).mtimeMs !== mtimeBefore) {
      fail('409 请求改写了数据文件');
    } else ok('409 请求未触碰数据文件');

    // 5) 下一次成功的保存（无关编辑）不得把脏状态写入文件
    const r2 = await api('/api/areas', 'POST', { name: '临时备注区域' });
    if (r2.status !== 201) fail(`无关保存失败：${r2.status}`);
    const persisted = JSON.parse(fs.readFileSync(path.join(TMP, 'data.json'), 'utf8'));
    const p1 = persisted.edges.find((e) => e.id === e1.id);
    const p2 = persisted.edges.find((e) => e.id === e2.id);
    const fileClean =
      p1.a === 'area-center' && p1.b === 'area-downstage' && p1.seconds === 3 &&
      JSON.stringify(p1.closures || []) === '[]' &&
      p2.seconds === 4 && persisted.edges.length === 11;
    if (!fileClean) fail(`成功保存后脏状态进入数据文件：\n${JSON.stringify({ p1, p2 }, null, 2)}`);
    else ok('后续成功保存未把冲突编辑写入数据文件');

    // 6) 反方向端点对同样判重：把 e1 改成 center / wing-r（与上面方向相反）
    const r3 = await api(`/api/edges/${e1.id}`, 'PUT', {
      a: 'area-center', b: 'area-wing-r', seconds: 99, capacity: 9, closures: [],
    });
    if (r3.status !== 409) fail(`反方向端点对也应 409，实际 ${r3.status}`);
    else ok('反方向端点对视为同一对，同样返回 409');

    // 6b) 409 之后其他集合的数据（刚新增的区域）仍在，连接数不变
    const afterAll = (await api('/api/data')).json;
    if (!afterAll.areas.some((a) => a.name === '临时备注区域') || afterAll.edges.length !== 11) {
      fail('409 影响了其他数据的内存状态');
    } else ok('409 后其他数据（新增区域）保留、连接集合不变');

    // 6c) 保持原端点、只改耗时/容量/封闭时段是合法编辑，应当生效（端点对与自身不判重）
    const r3c = await api(`/api/edges/${e1.id}`, 'PUT', {
      a: 'area-center', b: 'area-downstage', seconds: 5, capacity: 3, closures: [{ start: 1, end: 2 }],
    });
    if (r3c.status !== 200 || r3c.json.seconds !== 5 || r3c.json.capacity !== 3) {
      fail(`保持端点改属性应成功：${r3c.status} ${JSON.stringify(r3c.json)}`);
    } else ok('保持原端点仅修改耗时/容量/封闭时段：正常生效（不与自身判重）');

    // 6d) 不改端点、省略可选字段（页面始终全量提交；此用例模拟 API 局部更新）：capacity 保留原值
    const r3d = await api(`/api/edges/${e1.id}`, 'PUT', {
      a: 'area-center', b: 'area-downstage', seconds: 6, closures: [{ start: 1, end: 2 }],
    });
    if (r3d.status !== 200 || r3d.json.seconds !== 6 || r3d.json.capacity !== 3) {
      fail(`局部更新应保留 capacity：${r3d.status} ${JSON.stringify(r3d.json)}`);
    } else ok('局部更新（不传 capacity）保留原值，端点不冲突时正常生效');

    // 6e) 入参非法（400）与记录不存在（404）同样不改动任何状态
    const beforeBad = JSON.stringify((await api('/api/data')).json.edges);
    const r3e = await api(`/api/edges/${e1.id}`, 'PUT', {
      a: 'area-center', b: 'area-wing-r', seconds: -1, capacity: 3, closures: [],
    });
    if (r3e.status !== 400) fail(`非法耗时应返回 400，实际 ${r3e.status}`);
    const r3f = await api('/api/edges/not-exist', 'PUT', {
      a: 'area-center', b: 'area-downstage', seconds: 6, capacity: 3, closures: [],
    });
    if (r3f.status !== 404) fail(`不存在记录应返回 404，实际 ${r3f.status}`);
    if (JSON.stringify((await api('/api/data')).json.edges) !== beforeBad) {
      fail('400 / 404 请求改动了内存状态');
    } else ok('400 入参错误与 404 记录不存在均不改动任何状态');

    // 7) 合法编辑一次生效：把 中央↔前区 耗时改为 7（页面编辑始终全量提交：含容量与封闭时段）
    const r4 = await api(`/api/edges/${e1.id}`, 'PUT', {
      a: 'area-center', b: 'area-downstage', seconds: 7, capacity: 1, closures: [],
    });
    if (r4.status !== 200 || r4.json.seconds !== 7) fail(`合法编辑未生效：${r4.status} ${JSON.stringify(r4.json)}`);
    const now = (await api('/api/data')).json.edges.find((e) => e.id === e1.id);
    if (now.seconds !== 7) fail('合法编辑后 GET 读到的仍是旧耗时');
    else ok('合法编辑一次生效，GET 读到新耗时 7 秒');

    // 走位校验按新连接重算：耗时 3→7 后，两种模式结果都应相对冲突前基线发生变化
    const v2 = stable((await api('/api/validate?mode=classic')).json);
    const v2p = stable((await api('/api/validate?mode=propagate')).json);
    if (v2 === validationBaseline && v2p === validationBaselineP) {
      fail('合法编辑后校验结果未变化，未按新连接重算');
    } else ok('合法编辑后走位校验按新连接重算（两种模式结果均相对基线变化）');

    // 合法编辑已持久化
    const persisted2 = JSON.parse(fs.readFileSync(path.join(TMP, 'data.json'), 'utf8'));
    if (persisted2.edges.find((e) => e.id === e1.id).seconds !== 7) fail('合法编辑未持久化到数据文件');
    else ok('合法编辑已写入数据文件');
  } catch (err) {
    fail(`异常: ${err.stack || err}`);
  } finally {
    proc.kill();
    if (process.exitCode) console.error('\n--- server logs ---\n', logs);
  }
}

main().then(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 100);
});
