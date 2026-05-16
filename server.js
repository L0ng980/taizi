const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'prince-tiger-2026';

// ── 符号配置（公平赔率：概率×赔率=1.0，庄家优势由返奖率控制） ──
const RING_SYMS = [
  { id:'seven',  e:'7️⃣', name:'幸运7',  odds:24, count:1 },
  { id:'bar',    e:'🎰', name:'BAR',    odds:12, count:2 },
  { id:'bell',   e:'🔔', name:'铃铛',   odds:8,  count:4 },
  { id:'cherry', e:'🍒', name:'樱桃',   odds:8,  count:3 },
  { id:'lemon',  e:'🍋', name:'柠檬',   odds:4,  count:6 },
  { id:'orange', e:'🍊', name:'橙子',   odds:6,  count:4 },
  { id:'grape',  e:'🍇', name:'葡萄',   odds:12, count:2 },
  { id:'melon',  e:'🍈', name:'哈密瓜', odds:12, count:2 },
];

const DEFAULT_PAYOUT_RATE = 0.80;
const MIN_PAYOUT_RATE    = 0.10;
const MAX_PAYOUT_RATE    = 0.90;
const TRACK_GAMES        = 10;
const ROLL_COST_MULT     = { 1:1, 2:2, 3:3, 4:4, 5:5 };
const G_C = 6, G_R = 8;

// ── 环形顺序（与原始版本一致） ──
function buildRingOrder() {
  var order = [];
  for (var c = 0; c < G_C; c++)        order.push([0, c]);
  for (var r = 1; r < G_R-1; r++)      order.push([r, G_C-1]);
  for (var c = G_C-1; c >= 0; c--)     order.push([G_R-1, c]);
  for (var r = G_R-2; r >= 1; r--)     order.push([r, 0]);
  return order;
}

var RING_ORDER = buildRingOrder();
var RING_LEN = RING_ORDER.length; // 24

function buildRingSyms() {
  var pool = [];
  RING_SYMS.forEach(function(s) {
    for (var i = 0; i < s.count; i++) {
      pool.push({ id: s.id, e: s.e, name: s.name, odds: s.odds });
    }
  });
  for (var i = pool.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool;
}

var ringSyms = buildRingSyms();

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  var token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'not logged in' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { return res.status(401).json({ error: 'token expired' }); }
}

function adminOnly(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'need admin' });
  next();
}

function fmtUser(u) {
  return {
    id: u.id, username: u.username,
    isAdmin: u.is_admin === 1,
    balance: u.balance, profit: u.profit,
    payoutRate: u.payout_rate,
    adminSetRate: u.admin_set_rate === 1,
    customPayoutRate: u.custom_payout_rate
  };
}

// ── 游戏配置 ──
app.get('/api/game-config', function(req, res) {
  res.json({
    symbols: RING_SYMS,
    ringSyms: ringSyms,
    ringLength: RING_LEN,
    defaultPayoutRate: DEFAULT_PAYOUT_RATE,
    minPayoutRate: MIN_PAYOUT_RATE,
    maxPayoutRate: MAX_PAYOUT_RATE,
    rollCostMultiplier: ROLL_COST_MULT
  });
});

// 重新生成环（每次页面加载调用）
app.post('/api/new-ring', function(req, res) {
  ringSyms = buildRingSyms();
  res.json({ ringSyms: ringSyms, ringLength: RING_LEN });
});

// ── 认证 ──
app.post('/api/register', function(req, res) {
  var username = req.body.username;
  var password = req.body.password;
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(username))
    return res.status(400).json({ error: '账号2-16位，支持中英文/数字/下划线' });
  if (password.length < 6 || password.length > 20)
    return res.status(400).json({ error: '密码须6-20位' });

  var existing = db.dbGet('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) return res.status(400).json({ error: '账号已被注册' });

  var hash = bcrypt.hashSync(password, 10);
  var count = db.dbGet('SELECT COUNT(*) as c FROM users');
  var isFirst = count && count.c === 0;

  var userId = db.dbRunInsert(
    'INSERT INTO users (username, password_hash, is_admin, balance) VALUES (?, ?, ?, ?)',
    [username, hash, isFirst ? 1 : 0, 20]
  );

  var user = db.dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  var token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.is_admin === 1 }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token: token, user: fmtUser(user) });
});

app.post('/api/login', function(req, res) {
  var username = req.body.username;
  var password = req.body.password;
  var user = db.dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(400).json({ error: '账号不存在或密码错误' });
  var token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.is_admin === 1 }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token: token, user: fmtUser(user) });
});

app.get('/api/user', auth, function(req, res) {
  var user = db.dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'not found' });
  var rg = JSON.parse(user.recent_games || '[]');
  var tb = 0, tw = 0;
  rg.forEach(function(g) { tb += g.bet; tw += g.win; });
  res.json(Object.assign({}, fmtUser(user), { actualPayoutRate: tb > 0 ? tw / tb : null }));
});

// ── 摇奖 ──
app.post('/api/spin', auth, function(req, res) {
  var bets = req.body.bets || {};
  var rollCount = Math.max(1, Math.min(5, req.body.rollCount || 1));

  var totalBet = 0;
  var keys = Object.keys(bets);
  for (var i = 0; i < keys.length; i++) {
    var symId = keys[i];
    var amount = bets[symId];
    if (amount < 0) return res.status(400).json({ error: 'negative bet' });
    if (amount > 0 && !RING_SYMS.find(function(s) { return s.id === symId; }))
      return res.status(400).json({ error: 'invalid symbol' });
    totalBet += amount;
  }
  if (totalBet <= 0) return res.status(400).json({ error: '请先押注！' });

  var user = db.dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  var mul = ROLL_COST_MULT[rollCount] || rollCount;
  var cost = parseFloat((totalBet * mul).toFixed(2));
  if (cost > user.balance)
    return res.status(400).json({ error: 'P点不足！' + rollCount + '次摇奖需 ' + cost + ' P（' + mul + '倍费用）' });

  // 计算返奖率
  var winRate = user.payout_rate || DEFAULT_PAYOUT_RATE;
  if (user.admin_set_rate && user.custom_payout_rate != null)
    winRate = user.custom_payout_rate / 100;
  if (!user.admin_set_rate) winRate = Math.max(0.01, Math.min(MAX_PAYOUT_RATE, winRate));
  else winRate = Math.max(0.01, winRate); // 管理员可设>100%

  var results = [];
  for (var roll = 0; roll < rollCount; roll++) {
    // 检查实际返奖率，决定是否强制不赢
    var forceNoWin = false;
    if (!user.admin_set_rate) {
      var rg = JSON.parse(user.recent_games || '[]');
      var tbR = 0, twR = 0;
      rg.forEach(function(g) { tbR += g.bet; twR += g.win; });
      if (tbR > 0 && (twR / tbR) > winRate * 1.5) forceNoWin = true;
    }

    var targetIdx = -1;
    if (!forceNoWin) {
      for (var si = 0; si < RING_SYMS.length; si++) {
        var sym = RING_SYMS[si];
        var betAmt = bets[sym.id] || 0;
        if (betAmt <= 0) continue;
        var symCount = 0;
        for (var ri = 0; ri < RING_LEN; ri++) { if (ringSyms[ri].id === sym.id) symCount++; }
        var prob = (symCount / RING_LEN) * winRate;
        if (Math.random() < prob) {
          var idxList = [];
          for (var ri2 = 0; ri2 < RING_LEN; ri2++) { if (ringSyms[ri2].id === sym.id) idxList.push(ri2); }
          targetIdx = idxList[Math.floor(Math.random() * idxList.length)];
          break;
        }
      }
    }

    // 未中奖：优先停在非押注符号上
    if (targetIdx === -1) {
      var betIndices = [], nonBetIndices = [];
      for (var ri3 = 0; ri3 < RING_LEN; ri3++) {
        if (bets[ringSyms[ri3].id] > 0) betIndices.push(ri3);
        else nonBetIndices.push(ri3);
      }
      var pool = nonBetIndices.length > 0 ? nonBetIndices : betIndices;
      targetIdx = pool[Math.floor(Math.random() * pool.length)];
    }

    var winSym = ringSyms[targetIdx];
    var betOnWin = bets[winSym.id] || 0;
    var won = betOnWin > 0;
    var winP = won ? parseFloat((betOnWin * winSym.odds).toFixed(2)) : 0;
    results.push({
      idx: targetIdx, won: won, winP: winP,
      symId: winSym.id, symE: winSym.e, symName: winSym.name, symOdds: winSym.odds
    });
  }

  var totalWin = 0;
  results.forEach(function(r) { totalWin += r.winP; });
  var newBal = parseFloat((user.balance - cost + totalWin).toFixed(2));
  var newProf = parseFloat((user.profit - cost + totalWin).toFixed(2));

  // 调整返奖率
  if (!user.admin_set_rate) {
    var nr = user.payout_rate || DEFAULT_PAYOUT_RATE;
    if (totalWin > 0) nr = Math.max(MIN_PAYOUT_RATE, nr - 0.05);
    else nr = Math.min(MAX_PAYOUT_RATE, nr + 0.05);
    var rg2 = JSON.parse(user.recent_games || '[]');
    rg2.unshift({ bet: cost, win: totalWin });
    if (rg2.length > TRACK_GAMES) rg2.length = TRACK_GAMES;
    db.dbRun('UPDATE users SET balance=?, profit=?, payout_rate=?, recent_games=? WHERE id=?',
      [newBal, newProf, nr, JSON.stringify(rg2), user.id]);
  } else {
    var rg3 = JSON.parse(user.recent_games || '[]');
    rg3.unshift({ bet: cost, win: totalWin });
    if (rg3.length > TRACK_GAMES) rg3.length = TRACK_GAMES;
    db.dbRun('UPDATE users SET balance=?, profit=?, recent_games=? WHERE id=?',
      [newBal, newProf, JSON.stringify(rg3), user.id]);
  }

  db.dbRun('INSERT INTO games (user_id, bet_amount, win_amount, cost, roll_count, results) VALUES (?, ?, ?, ?, ?, ?)',
    [user.id, totalBet, totalWin, cost, rollCount, JSON.stringify(results)]);
  db.saveDb();

  var updated = db.dbGet('SELECT * FROM users WHERE id = ?', [user.id]);
  res.json({
    results: results, cost: cost, totalWin: totalWin,
    balance: updated.balance, profit: updated.profit, payoutRate: updated.payout_rate
  });
});

// ── 历史 ──
app.get('/api/history', auth, function(req, res) {
  var games = db.dbAll('SELECT * FROM games WHERE user_id = ? ORDER BY created_at DESC LIMIT 16', [req.user.id]);
  res.json({
    history: games.map(function(g) {
      return { results: JSON.parse(g.results), totalWinP: g.win_amount, bet: g.cost, createdAt: g.created_at };
    })
  });
});

// ── 管理员 ──
app.post('/api/recharge', auth, adminOnly, function(req, res) {
  var username = req.body.username;
  var amount = req.body.amount;
  if (!username || !amount || amount == 0) return res.status(400).json({ error: 'invalid' });
  var target = db.dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!target) return res.status(400).json({ error: 'user not found' });
  if (amount < 0 && target.balance < Math.abs(amount))
    return res.status(400).json({ error: username + ' 余额不足，无法扣除' });
  db.dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, target.id]);
  db.saveDb();
  var u = db.dbGet('SELECT balance FROM users WHERE id = ?', [target.id]);
  res.json({ ok: true, balance: u.balance });
});

app.post('/api/admin/config', auth, adminOnly, function(req, res) {
  var username = req.body.username;
  var payoutRate = req.body.payoutRate;
  if (!username) return res.status(400).json({ error: 'no username' });
  var target = db.dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!target) return res.status(400).json({ error: 'user not found' });
  if (payoutRate !== undefined && payoutRate !== null) {
    var rate = parseFloat(payoutRate); // 管理员可设任意值（如500、1000）
    db.dbRun('UPDATE users SET payout_rate=?, admin_set_rate=1, custom_payout_rate=? WHERE id=?',
      [rate / 100, rate, target.id]);
  } else {
    db.dbRun('UPDATE users SET admin_set_rate=0, custom_payout_rate=NULL, payout_rate=? WHERE id=?',
      [DEFAULT_PAYOUT_RATE, target.id]);
  }
  db.saveDb();
  res.json({ ok: true });
});

app.get('/api/admin/users', auth, adminOnly, function(req, res) {
  var users = db.dbAll('SELECT id,username,is_admin,balance,profit,payout_rate,admin_set_rate,custom_payout_rate,recent_games FROM users ORDER BY id');
  res.json({
    users: users.map(function(u) {
      var rg = JSON.parse(u.recent_games || '[]');
      var tb = 0, tw = 0;
      rg.forEach(function(g) { tb += g.bet; tw += g.win; });
      return Object.assign({}, fmtUser(u), { actualPayoutRate: tb > 0 ? tw / tb : DEFAULT_PAYOUT_RATE });
    })
  });
});

// 删除用户
app.post('/api/admin/delete-user', auth, adminOnly, function(req, res) {
  var username = req.body.username;
  if (!username) return res.status(400).json({ error: '请选择要删除的用户' });
  if (username === req.user.username) return res.status(400).json({ error: '不能删除自己' });
  var target = db.dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!target) return res.status(400).json({ error: 'user not found' });
  if (target.is_admin) return res.status(400).json({ error: '不能删除管理员' });
  db.dbRun('DELETE FROM games WHERE user_id = ?', [target.id]);
  db.dbRun('DELETE FROM users WHERE id = ?', [target.id]);
  db.saveDb();
  res.json({ ok: true });
});

// 修改密码
app.post('/api/admin/change-password', auth, adminOnly, function(req, res) {
  var username = req.body.username;
  var newPassword = req.body.newPassword;
  if (!username || !newPassword) return res.status(400).json({ error: 'invalid' });
  if (newPassword.length < 6 || newPassword.length > 20)
    return res.status(400).json({ error: '密码须6-20位' });
  var target = db.dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!target) return res.status(400).json({ error: 'user not found' });
  var hash = bcrypt.hashSync(newPassword, 10);
  db.dbRun('UPDATE users SET password_hash=? WHERE id=?', [hash, target.id]);
  db.saveDb();
  res.json({ ok: true });
});

// ── SPA fallback ──
app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 启动 ──
(async function() {
  await db.initDb();
  console.log('Slots server running on http://localhost:' + PORT);
  app.listen(PORT);
})();
