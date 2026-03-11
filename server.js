'use strict';

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const Database     = require('better-sqlite3');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT    || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pulse_secret_change_me_in_production';
const DB_DIR     = path.join(__dirname, 'data');
const DB_PATH    = path.join(DB_DIR, 'pulse.db');
const BCRYPT_ROUNDS = 10;
const TOKEN_TTL     = '7d';
const PRESENCE_TTL  = 35000;

// ─── Express ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  maxHttpBufferSize: 12 * 1024 * 1024,
  pingTimeout: 20000, pingInterval: 10000,
  cors: { origin: '*' }
});

app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());

// ─── Database ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password   TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#5b9fff',
    avatar     TEXT,
    status     TEXT NOT NULL DEFAULT 'online',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
  );

  CREATE TABLE IF NOT EXISTS chats (
    id       TEXT PRIMARY KEY,
    type     TEXT NOT NULL CHECK(type IN ('channel','group','dm')),
    name     TEXT,
    desc     TEXT DEFAULT '',
    icon     TEXT DEFAULT '💬',
    creator  TEXT,
    created  INTEGER NOT NULL,
    mods     TEXT NOT NULL DEFAULT '{}',
    banned   TEXT NOT NULL DEFAULT '{}',
    members  TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS messages (
    id        TEXT PRIMARY KEY,
    chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user      TEXT NOT NULL,
    color     TEXT NOT NULL DEFAULT '#5b9fff',
    avatar    TEXT,
    role      TEXT NOT NULL DEFAULT 'member',
    type      TEXT NOT NULL DEFAULT 'text',
    text      TEXT,
    img       TEXT,
    audio     TEXT,
    duration  TEXT,
    edited    INTEGER NOT NULL DEFAULT 0,
    ts        INTEGER NOT NULL,
    reply_to  TEXT,
    reactions TEXT NOT NULL DEFAULT '{}',
    link_prev TEXT,
    options   TEXT,
    votes     TEXT NOT NULL DEFAULT '{}',
    question  TEXT,
    title     TEXT,
    datetime  INTEGER,
    desc2     TEXT,
    rsvp      TEXT NOT NULL DEFAULT '{"yes":{},"no":{}}'
  );

  CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages(chat_id, ts);

  CREATE TABLE IF NOT EXISTS pinned (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    msg_id  TEXT NOT NULL,
    user    TEXT NOT NULL,
    text    TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS presence (
    username TEXT PRIMARY KEY,
    status   TEXT NOT NULL DEFAULT 'online',
    ts       INTEGER NOT NULL
  );
`);

// Default channels
const defChans = [
  { id:'general', name:'Общий',      icon:'💬', desc:'Главный чат' },
  { id:'dev',     name:'Разработка', icon:'⚡', desc:'Код и технологии' },
  { id:'random',  name:'Флуд',       icon:'🎲', desc:'Обо всём' },
];
const _insDef = db.prepare(
  `INSERT OR IGNORE INTO chats (id,type,name,desc,icon,created) VALUES (?,?,?,?,?,?)`
);
defChans.forEach(c => _insDef.run(c.id,'channel',c.name,c.desc,c.icon,Date.now()));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pj(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
function genId(p='id') { return `${p}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }
function clean(s, max=500) { return typeof s==='string' ? s.trim().slice(0,max) : ''; }
function isValidColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c); }

function parseChat(r) {
  if (!r) return null;
  return { ...r, mods:pj(r.mods,{}), banned:pj(r.banned,{}), members:pj(r.members,{}) };
}
function parseMsg(r) {
  if (!r) return null;
  return {
    ...r, edited:!!r.edited,
    reactions: pj(r.reactions,{}), reply_to: pj(r.reply_to,null),
    link_prev: pj(r.link_prev,null), options: pj(r.options,null),
    votes: pj(r.votes,{}), rsvp: pj(r.rsvp,{yes:{},no:{}}),
  };
}

const q = {
  userByName:   db.prepare(`SELECT * FROM users WHERE username=? COLLATE NOCASE`),
  userById:     db.prepare(`SELECT * FROM users WHERE id=?`),
  insertUser:   db.prepare(`INSERT INTO users (username,password,color) VALUES (?,?,?)`),
  updateAvatar: db.prepare(`UPDATE users SET avatar=? WHERE username=?`),
  updateStatus: db.prepare(`UPDATE users SET status=? WHERE username=?`),

  allChats:  db.prepare(`SELECT * FROM chats ORDER BY created ASC`),
  chatById:  db.prepare(`SELECT * FROM chats WHERE id=?`),
  msgs:      db.prepare(`SELECT * FROM messages WHERE chat_id=? ORDER BY ts ASC LIMIT 300`),
  msgById:   db.prepare(`SELECT * FROM messages WHERE id=?`),
  pinned:    db.prepare(`SELECT * FROM pinned WHERE chat_id=?`),

  upsertPresence: db.prepare(`INSERT OR REPLACE INTO presence (username,status,ts) VALUES (?,?,?)`),
  delPresence:    db.prepare(`DELETE FROM presence WHERE username=?`),
  cleanPresence:  db.prepare(`DELETE FROM presence WHERE ts<?`),
  allPresence:    db.prepare(`SELECT p.username,p.status,u.color,u.avatar
                               FROM presence p JOIN users u ON u.username=p.username`),

  insertMsg: db.prepare(`
    INSERT INTO messages
      (id,chat_id,user,color,avatar,role,type,text,img,audio,duration,ts,
       reply_to,link_prev,options,votes,question,title,datetime,desc2,rsvp)
    VALUES
      (@id,@chat_id,@user,@color,@avatar,@role,@type,@text,@img,@audio,@duration,@ts,
       @reply_to,@link_prev,@options,@votes,@question,@title,@datetime,@desc2,@rsvp)`),

  editMsg:    db.prepare(`UPDATE messages SET text=@text,edited=1 WHERE id=@id AND user=@user`),
  deleteMsg:  db.prepare(`DELETE FROM messages WHERE id=@id AND user=@user`),
  setReacts:  db.prepare(`UPDATE messages SET reactions=? WHERE id=?`),
  setVotes:   db.prepare(`UPDATE messages SET votes=? WHERE id=?`),
  setRsvp:    db.prepare(`UPDATE messages SET rsvp=? WHERE id=?`),
  upsertPin:  db.prepare(`INSERT OR REPLACE INTO pinned (chat_id,msg_id,user,text) VALUES (?,?,?,?)`),
  delPin:     db.prepare(`DELETE FROM pinned WHERE chat_id=?`),
  setChatMods:    db.prepare(`UPDATE chats SET mods=?   WHERE id=?`),
  setChatBanned:  db.prepare(`UPDATE chats SET banned=? WHERE id=?`),
};

function getPresenceMap() {
  const map = {};
  q.allPresence.all().forEach(r => { map[r.username] = r; });
  return map;
}
function getAllChats() { return q.allChats.all().map(parseChat); }
function getChat(id)  { return parseChat(q.chatById.get(id)); }

// ─── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers?.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('token');
    res.status(401).json({ error: 'Сессия истекла' });
  }
}

// ─── REST: Auth ────────────────────────────────────────────────────────────────
// Регистрация
app.post('/api/register', async (req, res) => {
  const username = clean(req.body?.username || '', 30);
  const password = clean(req.body?.password || '', 100);

  if (!username) return res.status(400).json({ error: 'Введи имя пользователя' });
  if (username.length < 2) return res.status(400).json({ error: 'Имя минимум 2 символа' });
  if (!/^[a-zA-Zа-яёА-ЯЁ0-9_.\- ]+$/.test(username))
    return res.status(400).json({ error: 'Недопустимые символы в имени' });
  if (!password) return res.status(400).json({ error: 'Введи пароль' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });

  const exists = q.userByName.get(username);
  if (exists) return res.status(409).json({ error: 'Имя уже занято' });

  const COLORS = ['#5b9fff','#a259ff','#ff5fa0','#36d9a0','#ff8c42','#38e8ff','#ffd060','#ff6b6b'];
  const color  = COLORS[Math.floor(Math.random() * COLORS.length)];
  const hash   = await bcrypt.hash(password, BCRYPT_ROUNDS);

  q.insertUser.run(username, hash, color);
  const user  = q.userByName.get(username);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });

  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7*24*3600*1000 });
  res.json({ ok: true, user: { id: user.id, username: user.username, color: user.color, avatar: user.avatar, status: user.status } });
});

// Вход
app.post('/api/login', async (req, res) => {
  const username = clean(req.body?.username || '', 30);
  const password = clean(req.body?.password || '', 100);

  if (!username || !password)
    return res.status(400).json({ error: 'Заполни все поля' });

  const user = q.userByName.get(username);
  if (!user) return res.status(401).json({ error: 'Неверное имя или пароль' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Неверное имя или пароль' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7*24*3600*1000 });
  res.json({ ok: true, user: { id: user.id, username: user.username, color: user.color, avatar: user.avatar, status: user.status } });
});

// Выход
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// Проверка сессии (при обновлении страницы)
app.get('/api/me', authMiddleware, (req, res) => {
  const user = q.userById.get(req.user.id);
  if (!user) { res.clearCookie('token'); return res.status(401).json({ error: 'Пользователь не найден' }); }
  res.json({ user: { id: user.id, username: user.username, color: user.color, avatar: user.avatar, status: user.status } });
});

// Health-check для Replit keepalive
app.get('/ping', (_req, res) => res.json({ ok: true }));

// ─── Serve HTML ────────────────────────────────────────────────────────────────
// Весь клиент инлайном — единственный HTML файл
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.io auth middleware ────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.cookie
    ?.split(';').find(c => c.trim().startsWith('token='))?.split('=')[1];
  if (!token) return next(new Error('AUTH_REQUIRED'));
  try {
    socket.data.auth = jwt.verify(token, JWT_SECRET);
    const user = q.userById.get(socket.data.auth.id);
    if (!user) return next(new Error('USER_NOT_FOUND'));
    socket.data.user = user;
    next();
  } catch {
    next(new Error('TOKEN_INVALID'));
  }
});

// ─── Socket.io events ─────────────────────────────────────────────────────────
io.on('connection', socket => {
  const u = socket.data.user;

  // Присутствие
  q.upsertPresence.run(u.username, u.status || 'online', Date.now());
  io.emit('presence_update', getPresenceMap());

  socket.emit('init', { chats: getAllChats(), presence: getPresenceMap() });

  // ── Presence update ────────────────────────────────────────────────────────
  socket.on('set_status', ({ status }) => {
    if (!['online','busy','away'].includes(status)) return;
    q.updateStatus.run(status, u.username);
    socket.data.user = { ...u, status };
    q.upsertPresence.run(u.username, status, Date.now());
    io.emit('presence_update', getPresenceMap());
  });

  socket.on('set_avatar', ({ avatar }) => {
    if (typeof avatar !== 'string' || avatar.length > 3*1024*1024) return;
    q.updateAvatar.run(avatar || null, u.username);
    socket.data.user = { ...socket.data.user, avatar: avatar || null };
    io.emit('presence_update', getPresenceMap());
  });

  // ── Load messages ──────────────────────────────────────────────────────────
  socket.on('load_messages', ({ chatId }) => {
    if (!chatId) return;
    const chat = getChat(String(chatId));
    if (!chat) return;
    const msgs   = q.msgs.all(chatId).map(parseMsg);
    const pinned = q.pinned.get(chatId) || null;
    socket.emit('messages_loaded', { chatId, messages: msgs, pinned });
  });

  // ── Join chat room ─────────────────────────────────────────────────────────
  socket.on('join_chat', ({ chatId }) => {
    socket.rooms.forEach(r => { if (r.startsWith('chat:')) socket.leave(r); });
    socket.join(`chat:${chatId}`);
  });

  // ── Send message ───────────────────────────────────────────────────────────
  socket.on('send_message', payload => {
    if (!payload?.chatId) return;
    const chatId = String(payload.chatId);
    const chat   = getChat(chatId);
    if (!chat) return;
    if (chat.banned?.[u.username]) return;

    const type = ['text','poll','sched','voice'].includes(payload.type) ? payload.type : 'text';
    const text = type === 'text' ? clean(payload.text || '', 2000) : null;
    if (type === 'text' && !text && !payload.img) return;

    let replyTo = null;
    if (payload.replyTo && typeof payload.replyTo === 'object') {
      replyTo = { id: String(payload.replyTo.id||''), user: clean(payload.replyTo.user||'',30), text: clean(payload.replyTo.text||'',300) };
    }

    // Role
    let role = 'member';
    if (chat.creator === u.username) role = 'owner';
    else if ((chat.mods||{})[u.username]) role = 'mod';

    const id = genId('msg');
    q.insertMsg.run({
      id, chat_id: chatId, user: u.username, color: u.color,
      avatar: u.avatar || null, role, type, text: text || null,
      img: payload.img || null, audio: payload.audio || null, duration: payload.duration || null,
      ts: Date.now(),
      reply_to:  replyTo ? JSON.stringify(replyTo) : null,
      link_prev: payload.linkPreview ? JSON.stringify(payload.linkPreview) : null,
      options:   payload.options  ? JSON.stringify(payload.options)  : null,
      votes:     '{}',
      question:  payload.question ? clean(payload.question, 300) : null,
      title:     payload.title    ? clean(payload.title, 200)    : null,
      datetime:  Number(payload.datetime) || null,
      desc2:     payload.desc     ? clean(payload.desc, 500)     : null,
      rsvp:      '{"yes":{},"no":{}}',
    });

    const msg = parseMsg(q.msgById.get(id));
    io.to(`chat:${chatId}`).emit('new_message', { chatId, message: msg });
  });

  // ── Edit ───────────────────────────────────────────────────────────────────
  socket.on('edit_message', ({ chatId, msgId, text }) => {
    const t = clean(text || '', 2000); if (!t) return;
    const info = q.editMsg.run({ text: t, id: msgId, user: u.username });
    if (!info.changes) return;
    const msg = parseMsg(q.msgById.get(msgId));
    if (msg) io.to(`chat:${chatId}`).emit('message_updated', { chatId, message: msg });
  });

  // ── Delete ─────────────────────────────────────────────────────────────────
  socket.on('delete_message', ({ chatId, msgId }) => {
    const info = q.deleteMsg.run({ id: msgId, user: u.username });
    if (!info.changes) return;
    io.to(`chat:${chatId}`).emit('message_deleted', { chatId, msgId });
  });

  // ── React ──────────────────────────────────────────────────────────────────
  socket.on('react', ({ chatId, msgId, emoji }) => {
    if (!emoji) return;
    const row = q.msgById.get(msgId); if (!row) return;
    const reactions = pj(row.reactions, {});
    const e = String(emoji).slice(0, 8);
    if (!reactions[e]) reactions[e] = {};
    if (reactions[e][u.username]) delete reactions[e][u.username];
    else reactions[e][u.username] = true;
    if (!Object.keys(reactions[e]).length) delete reactions[e];
    q.setReacts.run(JSON.stringify(reactions), msgId);
    const msg = parseMsg(q.msgById.get(msgId));
    if (msg) io.to(`chat:${chatId}`).emit('message_updated', { chatId, message: msg });
  });

  // ── Vote poll ──────────────────────────────────────────────────────────────
  socket.on('vote_poll', ({ chatId, msgId, idx }) => {
    const i = parseInt(idx); if (isNaN(i) || i < 0 || i > 20) return;
    const row = q.msgById.get(msgId); if (!row) return;
    const votes = pj(row.votes, {});
    Object.keys(votes).forEach(k => { if (votes[k]) delete votes[k][u.username]; });
    const already = !!(votes[i] || {})[u.username];
    if (!already) { if (!votes[i]) votes[i] = {}; votes[i][u.username] = true; }
    q.setVotes.run(JSON.stringify(votes), msgId);
    const msg = parseMsg(q.msgById.get(msgId));
    if (msg) io.to(`chat:${chatId}`).emit('message_updated', { chatId, message: msg });
  });

  // ── RSVP ───────────────────────────────────────────────────────────────────
  socket.on('rsvp', ({ chatId, msgId, ans }) => {
    if (!['yes','no'].includes(ans)) return;
    const row = q.msgById.get(msgId); if (!row) return;
    const rsvp = pj(row.rsvp, {yes:{},no:{}});
    if (!rsvp.yes) rsvp.yes = {}; if (!rsvp.no) rsvp.no = {};
    const other = ans === 'yes' ? 'no' : 'yes';
    delete rsvp[other][u.username];
    if (rsvp[ans][u.username]) delete rsvp[ans][u.username];
    else rsvp[ans][u.username] = true;
    q.setRsvp.run(JSON.stringify(rsvp), msgId);
    const msg = parseMsg(q.msgById.get(msgId));
    if (msg) io.to(`chat:${chatId}`).emit('message_updated', { chatId, message: msg });
  });

  // ── Pin ────────────────────────────────────────────────────────────────────
  socket.on('pin_message', ({ chatId, msgId, text }) => {
    if (!chatId || !msgId) return;
    const t = clean(text || '', 200);
    q.upsertPin.run(chatId, msgId, u.username, t);
    io.to(`chat:${chatId}`).emit('pinned_updated', { chatId, pinned: { msg_id: msgId, user: u.username, text: t } });
  });
  socket.on('unpin_message', ({ chatId }) => {
    if (!chatId) return;
    q.delPin.run(chatId);
    io.to(`chat:${chatId}`).emit('pinned_updated', { chatId, pinned: null });
  });

  // ── Typing ─────────────────────────────────────────────────────────────────
  socket.on('typing',      ({ chatId }) => { if (chatId) socket.to(`chat:${chatId}`).emit('typing',      { chatId, user: u.username }); });
  socket.on('stop_typing', ({ chatId }) => { if (chatId) socket.to(`chat:${chatId}`).emit('stop_typing', { chatId, user: u.username }); });

  // ── Create chat ────────────────────────────────────────────────────────────
  socket.on('create_chat', data => {
    if (!data?.type) return;
    if (data.type === 'dm') {
      const other = clean(String(data.members?.[0]||''), 30);
      if (!other || other === u.username) return;
      const id = 'dm_' + [u.username, other].sort().join('__');
      if (!getChat(id)) {
        db.prepare(`INSERT OR IGNORE INTO chats (id,type,name,desc,icon,created,members) VALUES (?,?,NULL,'','💬',?,?)`)
          .run(id, 'dm', Date.now(), JSON.stringify({ [u.username]: true, [other]: true }));
      }
      io.emit('chats_updated', getAllChats());
      socket.emit('chat_open', getChat(id));
    } else if (data.type === 'group') {
      const name = clean(data.name||'', 50); if (!name) return;
      if (!Array.isArray(data.members) || !data.members.length) return;
      const id = genId('grp');
      const members = { [u.username]: true };
      data.members.forEach(m => { const n = clean(String(m),30); if (n) members[n] = true; });
      db.prepare(`INSERT INTO chats (id,type,name,desc,icon,creator,created,members) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id,'group',name,clean(data.desc||'',200),'👥',u.username,Date.now(),JSON.stringify(members));
      io.emit('chats_updated', getAllChats());
      socket.emit('chat_open', getChat(id));
    } else if (data.type === 'channel') {
      const name = clean(data.name||'', 50); if (!name) return;
      const id = genId('ch');
      db.prepare(`INSERT INTO chats (id,type,name,desc,icon,creator,created) VALUES (?,?,?,?,?,?,?)`)
        .run(id,'channel',name,clean(data.desc||'',200),data.icon||'📢',u.username,Date.now());
      io.emit('chats_updated', getAllChats());
      socket.emit('chat_open', getChat(id));
    }
  });

  // ── Mod actions ────────────────────────────────────────────────────────────
  socket.on('set_mod', ({ chatId, targetUser, isMod }) => {
    const chat = getChat(chatId); if (!chat || chat.creator !== u.username) return;
    const mods = { ...chat.mods };
    if (isMod) mods[targetUser] = true; else delete mods[targetUser];
    q.setChatMods.run(JSON.stringify(mods), chatId);
    io.emit('chats_updated', getAllChats());
  });
  socket.on('ban_user', ({ chatId, targetUser }) => {
    const chat = getChat(chatId); if (!chat || chat.creator !== u.username) return;
    const banned = { ...chat.banned, [targetUser]: true };
    q.setChatBanned.run(JSON.stringify(banned), chatId);
    io.emit('chats_updated', getAllChats());
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    // Проверяем нет ли других сокетов этого пользователя
    const others = [...io.sockets.sockets.values()]
      .filter(s => s.id !== socket.id && s.data.user?.username === u.username);
    if (!others.length) {
      q.delPresence.run(u.username);
      io.emit('presence_update', getPresenceMap());
    }
  });

  socket.on('error', err => console.error('socket err:', err.message));
});

// Периодическая чистка
setInterval(() => q.cleanPresence.run(Date.now() - PRESENCE_TTL), 15000);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => console.log(`\n⚡ Pulse → http://localhost:${PORT}\n`));

process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
process.on('SIGINT',  () => server.close(() => { db.close(); process.exit(0); }));
