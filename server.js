const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 数据文件路径
const DATA_FILE = path.join(__dirname, 'data', 'personnel.json');

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 工具函数：读取人员名单 ──
function loadPersonnel() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('读取人员名单失败:', err.message);
    return [];
  }
}

// ── 工具函数：保存人员名单 ──
function savePersonnel(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ── API: 验证人员 ──
// GET /api/verify?name=张三&id=001
app.get('/api/verify', (req, res) => {
  const { name, id } = req.query;

  if (!name || !id) {
    return res.json({
      success: false,
      authorized: false,
      message: '请输入姓名和工号'
    });
  }

  const list = loadPersonnel();
  const found = list.find(
    p => p.name.trim() === name.trim() && p.id.trim() === id.trim()
  );

  if (found) {
    return res.json({
      success: true,
      authorized: true,
      message: '已授权',
      person: { name: found.name, id: found.id, department: found.department }
    });
  }

  return res.json({
    success: true,
    authorized: false,
    message: '未授权'
  });
});

// ── API: 获取全部人员名单 ──
app.get('/api/personnel', (req, res) => {
  const list = loadPersonnel();
  res.json({ success: true, data: list, total: list.length });
});

// ── API: 添加人员 ──
app.post('/api/personnel', (req, res) => {
  const { name, id, department } = req.body;

  if (!name || !id) {
    return res.status(400).json({ success: false, message: '姓名和工号不能为空' });
  }

  const list = loadPersonnel();

  // 检查是否已存在
  const exists = list.find(p => p.id.trim() === id.trim());
  if (exists) {
    return res.status(400).json({ success: false, message: `工号 ${id} 已存在` });
  }

  const newPerson = {
    id: id.trim(),
    name: name.trim(),
    department: department ? department.trim() : ''
  };

  list.push(newPerson);
  savePersonnel(list);

  res.json({ success: true, message: '添加成功', person: newPerson });
});

// ── API: 批量导入人员 ──
app.post('/api/personnel/batch', (req, res) => {
  const { persons } = req.body;

  if (!Array.isArray(persons) || persons.length === 0) {
    return res.status(400).json({ success: false, message: '请提供人员数组' });
  }

  const list = loadPersonnel();
  let added = 0;
  let skipped = 0;

  for (const p of persons) {
    if (!p.name || !p.id) continue;
    const exists = list.find(existing => existing.id.trim() === p.id.trim());
    if (exists) {
      skipped++;
      continue;
    }
    list.push({
      id: p.id.trim(),
      name: p.name.trim(),
      department: (p.department || '').trim()
    });
    added++;
  }

  savePersonnel(list);
  res.json({ success: true, message: `导入完成：新增 ${added} 人，跳过 ${skipped} 人（工号重复）` });
});

// ── API: 删除人员 ──
app.delete('/api/personnel/:id', (req, res) => {
  const { id } = req.params;
  const list = loadPersonnel();
  const index = list.findIndex(p => p.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, message: '未找到该人员' });
  }

  list.splice(index, 1);
  savePersonnel(list);

  res.json({ success: true, message: '删除成功' });
});

// ── API: 清空名单 ──
app.post('/api/personnel/clear', (req, res) => {
  savePersonnel([]);
  res.json({ success: true, message: '名单已清空' });
});

// ── SPA fallback ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 启动服务 ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 验证系统已启动: http://0.0.0.0:${PORT}`);
  console.log(`📱 用手机扫码访问（同局域网）`);
  console.log(`👥 当前名单人数: ${loadPersonnel().length}`);
  console.log(`📝 编辑名单: ${DATA_FILE}`);
});
