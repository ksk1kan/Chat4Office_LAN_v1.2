const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const multer = require("multer");

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "data", "db.json");
const DB_SAMPLE_PATH = path.join(__dirname, "data", "db.sample.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const UPLOAD_FILES_DIR = path.join(UPLOAD_DIR, "files");
const UPLOAD_AVATARS_DIR = path.join(UPLOAD_DIR, "avatars");

for (const p of [UPLOAD_DIR, UPLOAD_FILES_DIR, UPLOAD_AVATARS_DIR]) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
if (!fs.existsSync(DB_PATH)) {
  fs.copyFileSync(DB_SAMPLE_PATH, DB_PATH);
}

function nowMs(){ return Date.now(); }
function uid(prefix="id"){ return `${prefix}_${crypto.randomBytes(8).toString("hex")}`; }
function dmKey(a,b){ return [String(a),String(b)].sort().join("__"); }

function normalizeDb(db){
  db.users = Array.isArray(db.users) ? db.users : [];
  db.messages = Array.isArray(db.messages) ? db.messages : [];
  db.dmConversations = Array.isArray(db.dmConversations) ? db.dmConversations : [];
  db.groups = Array.isArray(db.groups) ? db.groups : [];
  db.groupMessages = Array.isArray(db.groupMessages) ? db.groupMessages : [];
  db.groupConversations = Array.isArray(db.groupConversations) ? db.groupConversations : [];
  db.notes = Array.isArray(db.notes) ? db.notes : [];
  db.activity = Array.isArray(db.activity) ? db.activity : [];

  db.settings = db.settings || {};
  if (!db.settings.officeName) db.settings.officeName = "Chat4Office";

  if (db.settings.soundUrl && !db.settings.reminderSoundUrl) {
    db.settings.reminderSoundUrl = db.settings.soundUrl;
    delete db.settings.soundUrl;
  }
  if (!db.settings.reminderSoundUrl) db.settings.reminderSoundUrl = "/sounds/notify.wav";
  if (!db.settings.dmSoundUrl) db.settings.dmSoundUrl = "/sounds/dm.wav";
  if (!db.settings.maxUploadMb) db.settings.maxUploadMb = 15;

  for(const u of db.users){
    if(u.avatarUrl === undefined) u.avatarUrl = null;
  }
  for(const m of db.messages){
    if(m.readAt === undefined) m.readAt = null;
    if(m.attachments === undefined) m.attachments = [];
  }
  for(const c of db.dmConversations){
    if(!c.clearedAtBy || typeof c.clearedAtBy !== "object") c.clearedAtBy = {};
  }
  for(const g of db.groups){
    g.members = Array.isArray(g.members) ? g.members : [];
    if(!g.createdAt) g.createdAt = nowMs();
    if(!g.updatedAt) g.updatedAt = g.createdAt;
  }
  for(const gm of db.groupMessages){
    if(gm.attachments === undefined) gm.attachments = [];
    if(!gm.seenBy || typeof gm.seenBy !== "object") gm.seenBy = {};
  }
  for(const gc of db.groupConversations){
    if(!gc.clearedAtBy || typeof gc.clearedAtBy !== "object") gc.clearedAtBy = {};
  }
  for(const n of db.notes){
    if(!n.seenBy || typeof n.seenBy !== "object") n.seenBy = {};
    if(n.attachments === undefined) n.attachments = [];
  }
  return db;
}

function readDb(){
  const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  return normalizeDb(raw);
}

let writeQueue = Promise.resolve();
function writeDbAtomic(db){
  db = normalizeDb(db);
  writeQueue = writeQueue.then(() => new Promise((resolve, reject) => {
    try{
      const tmp = DB_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
      fs.renameSync(tmp, DB_PATH);
      resolve();
    }catch(e){ reject(e); }
  }));
  return writeQueue;
}

function scryptHash(password, saltHex){
  const salt = Buffer.from(saltHex, "hex");
  const key = crypto.scryptSync(String(password), salt, 32, { N: 2**14, r: 8, p: 1 });
  return key.toString("hex");
}

function addLog(db, type, actorId, payload){
  db.activity.push({ id: uid("a"), type, actorId, payload: payload || {}, at: nowMs() });
  if(db.activity.length > 4000) db.activity.splice(0, db.activity.length - 4000);
}

function requireAuth(req,res,next){
  if(!req.session || !req.session.userId) return res.status(401).json({error:"auth_required"});
  next();
}
function requireAdmin(req,res,next){
  const db = readDb();
  const u = db.users.find(x=>x.id===req.session.userId);
  if(!u || u.role!=="admin") return res.status(403).json({error:"admin_required"});
  next();
}
function isGroupManager(db, meId, group){
  const me = db.users.find(u=>u.id===meId);
  const isAdmin = me && me.role==="admin";
  return isAdmin || group.ownerId===meId;
}
function getOrCreateDmConversation(db, userA, userB){
  const key = dmKey(userA, userB);
  let c = db.dmConversations.find(x=>x.id===key);
  if(!c){
    const sorted = [String(userA),String(userB)].sort();
    c = { id:key, userA: sorted[0], userB: sorted[1], clearedAtBy:{} };
    db.dmConversations.push(c);
  }
  return c;
}
function getOrCreateGroupConversation(db, groupId){
  let c = db.groupConversations.find(x=>x.id===String(groupId));
  if(!c){
    c = { id:String(groupId), groupId:String(groupId), clearedAtBy:{} };
    db.groupConversations.push(c);
  }
  return c;
}

const app = express();
app.use(express.json({limit:"2mb"}));

const sessionMw = session({
  secret: process.env.SESSION_SECRET || "chat4office_change_me",
  resave:false,
  saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax"}
});
app.use(sessionMw);

app.use(express.static(path.join(__dirname,"public")));
app.use("/uploads", express.static(UPLOAD_DIR));

const baseUpload = multer({
  storage: multer.diskStorage({
    destination: (req,file,cb)=> cb(null, UPLOAD_FILES_DIR),
    filename: (req,file,cb)=>{
      const ext = path.extname(file.originalname || "");
      cb(null, `${uid("f")}${ext}`);
    }
  })
});

function assertUploadLimit(req,res,next){
  const db = readDb();
  const maxMb = Number(db.settings.maxUploadMb||15);
  req._maxUploadBytes = Math.max(1, Math.min(50, maxMb)) * 1024 * 1024;
  next();
}

app.post("/api/upload/dm", requireAuth, assertUploadLimit, (req,res)=>{
  const up = multer({
    storage: baseUpload.storage,
    limits: { fileSize: req._maxUploadBytes }
  }).single("file");
  up(req,res,(err)=>{
    if(err) return res.status(400).json({error:"upload_failed", detail:String(err.message||err)});
    if(!req.file) return res.status(400).json({error:"no_file"});
    const url = `/uploads/files/${req.file.filename}`;
    res.json({ok:true, file:{ url, mime:req.file.mimetype||"application/octet-stream", name:req.file.originalname, size:req.file.size }});
  });
});

app.post("/api/upload/avatar", requireAuth, (req,res)=>{
  const up = multer({
    storage: multer.diskStorage({
      destination: (req,file,cb)=>cb(null, UPLOAD_AVATARS_DIR),
      filename: (req,file,cb)=>{
        const ext = path.extname(file.originalname || ".png");
        cb(null, `${req.session.userId}${ext}`);
      }
    }),
    limits: { fileSize: 3 * 1024 * 1024 }
  }).single("file");

  up(req,res, async (err)=>{
    if(err) return res.status(400).json({error:"upload_failed", detail:String(err.message||err)});
    if(!req.file) return res.status(400).json({error:"no_file"});
    const db = readDb();
    const me = db.users.find(u=>u.id===req.session.userId);
    if(!me) return res.status(401).json({error:"auth_required"});
    me.avatarUrl = `/uploads/avatars/${req.file.filename}`;
    addLog(db, "avatar_updated", me.id, {});
    await writeDbAtomic(db);
    res.json({ok:true, avatarUrl: me.avatarUrl});
  });
});

app.get("/api/me", requireAuth, (req,res)=>{
  const db = readDb();
  const u = db.users.find(x=>x.id===req.session.userId);
  if(!u) return res.status(401).json({error:"auth_required"});
  res.json({id:u.id,username:u.username,displayName:u.displayName,role:u.role,avatarUrl:u.avatarUrl||null});
});
app.get("/api/users", requireAuth, (req,res)=>{
  const db = readDb();
  res.json({users: db.users.map(u=>({id:u.id,username:u.username,displayName:u.displayName,role:u.role,avatarUrl:u.avatarUrl||null}))});
});
app.get("/api/settings", requireAuth, (req,res)=>{
  const db = readDb();
  res.json({settings: db.settings || {}});
});

app.post("/api/login",(req,res)=>{
  const {username,password} = req.body || {};
  if(!username || !password) return res.status(400).json({error:"missing_fields"});
  const db = readDb();
  const u = db.users.find(x=>x.username.toLowerCase()===String(username).toLowerCase());
  if(!u) return res.status(401).json({error:"invalid_credentials"});
  const candidate = scryptHash(password, u.pwSalt);
  if(candidate !== u.pwHash) return res.status(401).json({error:"invalid_credentials"});
  req.session.userId = u.id;
  res.json({ok:true});
});
app.post("/api/logout", requireAuth, (req,res)=> req.session.destroy(()=>res.json({ok:true})));

/** Admin: users **/
app.post("/api/admin/users", requireAuth, requireAdmin, async (req,res)=>{
  const {username,displayName,password,role} = req.body || {};
  if(!username || !password) return res.status(400).json({error:"missing_fields"});
  const db = readDb();
  if(db.users.some(u=>u.username.toLowerCase()===String(username).toLowerCase())) return res.status(409).json({error:"username_taken"});
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = scryptHash(password, salt);
  const user = {id:uid("u"),username:String(username),displayName:displayName?String(displayName):String(username),role:(role==="admin"?"admin":"user"),pwSalt:salt,pwHash:hash,avatarUrl:null,createdAt:nowMs()};
  db.users.push(user);
  addLog(db, "user_created", req.session.userId, { userId:user.id, username:user.username, role:user.role });
  await writeDbAtomic(db);
  res.json({ok:true,user:{id:user.id,username:user.username,displayName:user.displayName,role:user.role,avatarUrl:null}});
});

app.patch("/api/admin/users/:id", requireAuth, requireAdmin, async (req,res)=>{
  const {role, displayName} = req.body || {};
  const db = readDb();
  const u = db.users.find(x=>x.id===req.params.id);
  if(!u) return res.status(404).json({error:"not_found"});
  if(req.params.id==="u_admin" && role && role!=="admin") return res.status(400).json({error:"cannot_downgrade_default_admin"});
  if(role !== undefined) u.role = (role==="admin" ? "admin" : "user");
  if(displayName !== undefined) u.displayName = String(displayName);
  addLog(db, "user_updated", req.session.userId, { userId:u.id, role:u.role, displayName:u.displayName });
  await writeDbAtomic(db);
  res.json({ok:true, user:{id:u.id,username:u.username,displayName:u.displayName,role:u.role,avatarUrl:u.avatarUrl||null}});
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req,res)=>{
  const id = req.params.id;
  if(id==="u_admin") return res.status(400).json({error:"cannot_delete_default_admin"});
  const db = readDb();
  db.users = db.users.filter(u=>u.id!==id);
  db.notes = db.notes.filter(n=>n.creatorId!==id && !(n.assignees||[]).includes(id));
  for(const g of db.groups){
    g.members = (g.members||[]).filter(x=>x!==id);
    if(g.ownerId===id) g.ownerId = "u_admin";
  }
  addLog(db, "user_deleted", req.session.userId, { userId:id });
  await writeDbAtomic(db);
  res.json({ok:true});
});

app.post("/api/admin/users/:id/reset_password", requireAuth, requireAdmin, async (req,res)=>{
  const {newPassword} = req.body || {};
  if(!newPassword) return res.status(400).json({error:"missing_fields"});
  const db = readDb();
  const u = db.users.find(x=>x.id===req.params.id);
  if(!u) return res.status(404).json({error:"not_found"});
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = scryptHash(newPassword, salt);
  u.pwSalt = salt; u.pwHash = hash;
  addLog(db, "password_reset", req.session.userId, { userId:u.id });
  await writeDbAtomic(db);
  res.json({ok:true});
});

app.post("/api/admin/settings", requireAuth, requireAdmin, async (req,res)=>{
  const {officeName, reminderSoundUrl, dmSoundUrl, maxUploadMb} = req.body || {};
  const db = readDb();
  db.settings = db.settings || {};
  if(officeName !== undefined) db.settings.officeName = String(officeName);
  if(reminderSoundUrl !== undefined) db.settings.reminderSoundUrl = String(reminderSoundUrl);
  if(dmSoundUrl !== undefined) db.settings.dmSoundUrl = String(dmSoundUrl);
  if(maxUploadMb !== undefined){
    const v = Number(maxUploadMb);
    db.settings.maxUploadMb = Math.max(1, Math.min(50, isFinite(v)?v:15));
  }
  addLog(db, "settings_updated", req.session.userId, { officeName:db.settings.officeName, reminderSoundUrl:db.settings.reminderSoundUrl, dmSoundUrl:db.settings.dmSoundUrl, maxUploadMb:db.settings.maxUploadMb });
  await writeDbAtomic(db);
  res.json({ok:true,settings:db.settings});
});

app.get("/api/admin/activity", requireAuth, requireAdmin, (req,res)=>{
  const db = readDb();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit)||200));
  const items = (db.activity||[]).slice(-limit).reverse();
  res.json({items});
});

app.get("/api/unread_counts", requireAuth, (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const counts = {};
  for(const m of db.messages){
    if(m.toId===me && !m.readAt){
      counts[m.fromId] = (counts[m.fromId]||0) + 1;
    }
  }
  res.json({counts});
});

app.get("/api/messages/:otherUserId", requireAuth, (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const other = req.params.otherUserId;
  const c = getOrCreateDmConversation(db, me, other);
  const clearedAt = Number(c.clearedAtBy[me]||0);

  const msgs = db.messages
    .filter(m => (
      ((m.fromId===me && m.toId===other) || (m.fromId===other && m.toId===me)) &&
      (m.createdAt > clearedAt)
    ))
    .sort((a,b)=>a.createdAt-b.createdAt)
    .slice(-500);
  res.json({messages:msgs, clearedAt});
});

app.post("/api/messages/:otherUserId/clear", requireAuth, async (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const other = req.params.otherUserId;
  const c = getOrCreateDmConversation(db, me, other);
  c.clearedAtBy[me] = nowMs();
  addLog(db, "dm_cleared", me, { otherId:String(other) });
  await writeDbAtomic(db);
  res.json({ok:true});
});

/** Groups **/
app.get("/api/groups", requireAuth, (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const groups = (db.groups||[]).filter(g => (g.members||[]).includes(me));
  res.json({groups});
});

app.post("/api/groups", requireAuth, async (req,res)=>{
  const {name, members} = req.body || {};
  const db = readDb();
  const me = req.session.userId;
  const nm = String(name||"Grup").trim().slice(0,60) || "Grup";
  const mem = Array.isArray(members) ? members.map(String) : [];
  const unique = Array.from(new Set([me, ...mem]));
  const g = { id: uid("g"), name: nm, ownerId: me, members: unique, createdAt: nowMs(), updatedAt: nowMs() };
  db.groups.push(g);
  getOrCreateGroupConversation(db, g.id);
  addLog(db, "group_created", me, { groupId:g.id, name:g.name, members:g.members });
  await writeDbAtomic(db);
  res.json({ok:true, group:g});
});

app.patch("/api/groups/:id", requireAuth, async (req,res)=>{
  const {name, addMembers, removeMembers} = req.body || {};
  const db = readDb();
  const me = req.session.userId;
  const g = db.groups.find(x=>x.id===req.params.id);
  if(!g) return res.status(404).json({error:"not_found"});
  if(!isGroupManager(db, me, g)) return res.status(403).json({error:"forbidden"});

  if(name !== undefined) g.name = String(name).trim().slice(0,60) || g.name;

  const add = Array.isArray(addMembers) ? addMembers.map(String) : [];
  const rem = Array.isArray(removeMembers) ? removeMembers.map(String) : [];

  if(add.length){
    for(const id of add) if(!g.members.includes(id)) g.members.push(id);
  }
  if(rem.length){
    g.members = g.members.filter(id => !rem.includes(id));
    if(!g.members.includes(g.ownerId)) g.members.push(g.ownerId);
  }
  g.updatedAt = nowMs();
  addLog(db, "group_updated", me, { groupId:g.id, name:g.name, addMembers:add, removeMembers:rem });
  await writeDbAtomic(db);
  res.json({ok:true, group:g});
});

app.get("/api/group_messages/:groupId", requireAuth, (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const gid = req.params.groupId;
  const g = db.groups.find(x=>x.id===gid);
  if(!g || !(g.members||[]).includes(me)) return res.status(403).json({error:"forbidden"});
  const c = getOrCreateGroupConversation(db, gid);
  const clearedAt = Number(c.clearedAtBy[me]||0);

  const msgs = (db.groupMessages||[])
    .filter(m => m.groupId===gid && m.createdAt > clearedAt)
    .sort((a,b)=>a.createdAt-b.createdAt)
    .slice(-600);
  res.json({messages:msgs, clearedAt});
});

app.post("/api/group_messages/:groupId/clear", requireAuth, async (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const gid = req.params.groupId;
  const g = db.groups.find(x=>x.id===gid);
  if(!g || !(g.members||[]).includes(me)) return res.status(403).json({error:"forbidden"});
  const c = getOrCreateGroupConversation(db, gid);
  c.clearedAtBy[me] = nowMs();
  addLog(db, "group_cleared", me, { groupId:gid });
  await writeDbAtomic(db);
  res.json({ok:true});
});

/** Notes **/
app.get("/api/notes", requireAuth, (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const scope = String(req.query.scope||"inbox");
  let notes = db.notes || [];
  if(scope==="created") notes = notes.filter(n=>n.creatorId===me);
  else if(scope==="all"){
    const u = db.users.find(x=>x.id===me);
    if(!(u && u.role==="admin")) notes = notes.filter(n=>(n.assignees||[]).includes(me) || n.creatorId===me);
  }else notes = notes.filter(n=>(n.assignees||[]).includes(me) || n.creatorId===me);
  notes = notes.sort((a,b)=>(a.dueAt||9e15)-(b.dueAt||9e15));
  res.json({notes});
});

app.post("/api/notes/mark_seen", requireAuth, async (req,res)=>{
  const noteIds = Array.isArray((req.body||{}).noteIds) ? (req.body||{}).noteIds.map(String) : [];
  const db = readDb();
  const me = req.session.userId;
  const now = nowMs();
  let changed = false;
  for(const id of noteIds){
    const n = db.notes.find(x=>x.id===id);
    if(!n) continue;
    const allowed = (n.creatorId===me) || (n.assignees||[]).includes(me);
    if(!allowed) continue;
    n.seenBy = n.seenBy && typeof n.seenBy==="object" ? n.seenBy : {};
    n.seenBy[me] = now;
    changed = true;
  }
  if(changed) await writeDbAtomic(db);
  res.json({ok:true});
});

app.post("/api/notes", requireAuth, async (req,res)=>{
  const {text,assignees,dueAt,important} = req.body || {};
  if(!text || !String(text).trim()) return res.status(400).json({error:"empty"});
  const db = readDb();
  const me = req.session.userId;
  const ass = Array.isArray(assignees) ? assignees.map(String) : [];
  const finalAssignees = (ass.length?ass:[me]).filter((v,i,a)=>a.indexOf(v)===i);
  const n = {id:uid("n"),creatorId:me,assignees:finalAssignees,text:String(text).trim(),important:!!important,dueAt:dueAt?Number(dueAt):null,status:"open",snoozeUntil:null,lastTriggeredAt:null,seenBy:{},createdAt:nowMs(),updatedAt:nowMs(),doneById:null,doneAt:null};
  n.seenBy[me] = n.createdAt;
  db.notes.push(n);
  addLog(db, "note_created", me, { noteId:n.id, dueAt:n.dueAt, important:n.important, assignees:n.assignees });
  await writeDbAtomic(db);
  res.json({ok:true,note:n});
});

app.patch("/api/notes/:id", requireAuth, async (req,res)=>{
  const {text,assignees,dueAt,important} = req.body || {};
  const db = readDb();
  const me = req.session.userId;
  const note = db.notes.find(x=>x.id===req.params.id);
  if(!note) return res.status(404).json({error:"not_found"});
  const u = db.users.find(x=>x.id===me);
  const isAdmin = u && u.role==="admin";
  if(!(note.creatorId===me || isAdmin)) return res.status(403).json({error:"forbidden"});
  if(text !== undefined) note.text = String(text).trim();
  if(important !== undefined) note.important = !!important;
  if(dueAt !== undefined) note.dueAt = dueAt ? Number(dueAt) : null;
  if(assignees !== undefined){
    const ass = Array.isArray(assignees) ? assignees.map(String) : [];
    note.assignees = (ass.length?ass:[note.creatorId]).filter((v,i,a)=>a.indexOf(v)===i);
  }
  note.updatedAt = nowMs();
  note.lastTriggeredAt = null;
  addLog(db, "note_updated", me, { noteId:note.id, dueAt:note.dueAt, important:note.important, assignees:note.assignees });
  await writeDbAtomic(db);
  res.json({ok:true,note});
});

app.post("/api/notes/:id/done", requireAuth, async (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const note = db.notes.find(x=>x.id===req.params.id);
  if(!note) return res.status(404).json({error:"not_found"});
  const u = db.users.find(x=>x.id===me);
  const isAdmin = u && u.role==="admin";
  const allowed = isAdmin || note.creatorId===me || (note.assignees||[]).includes(me);
  if(!allowed) return res.status(403).json({error:"forbidden"});
  note.status="done";
  note.doneById=me;
  note.doneAt=nowMs();
  note.updatedAt=nowMs();
  addLog(db, "note_done", me, { noteId:note.id });
  await writeDbAtomic(db);
  res.json({ok:true,note});
});

app.post("/api/notes/:id/snooze", requireAuth, async (req,res)=>{
  const mins = Number((req.body||{}).minutes);
  if(!mins || mins<1 || mins>1440) return res.status(400).json({error:"invalid_minutes"});
  const db = readDb();
  const me = req.session.userId;
  const note = db.notes.find(x=>x.id===req.params.id);
  if(!note) return res.status(404).json({error:"not_found"});
  const u = db.users.find(x=>x.id===me);
  const isAdmin = u && u.role==="admin";
  const allowed = isAdmin || note.creatorId===me || (note.assignees||[]).includes(me);
  if(!allowed) return res.status(403).json({error:"forbidden"});
  note.snoozeUntil = nowMs() + mins*60*1000;
  note.lastTriggeredAt = null;
  note.updatedAt = nowMs();
  addLog(db, "note_snoozed", me, { noteId:note.id, minutes:mins });
  await writeDbAtomic(db);
  res.json({ok:true,note});
});

app.delete("/api/notes/:id", requireAuth, async (req,res)=>{
  const db = readDb();
  const me = req.session.userId;
  const note = db.notes.find(x=>x.id===req.params.id);
  if(!note) return res.status(404).json({error:"not_found"});
  const u = db.users.find(x=>x.id===me);
  const isAdmin = u && u.role==="admin";
  const allowed = isAdmin || note.creatorId===me;
  if(!allowed) return res.status(403).json({error:"forbidden"});
  db.notes = db.notes.filter(x=>x.id!==req.params.id);
  addLog(db, "note_deleted", me, { noteId:note.id });
  await writeDbAtomic(db);
  res.json({ok:true});
});

const server = http.createServer(app);
const io = new Server(server);

const onlineByUserId = new Map(); // userId -> Set(socketId)
const groupRoom = (gid)=>`group_${gid}`;

io.use((socket,next)=>sessionMw(socket.request, socket.request.res||{}, next));

function emitPresence(){
  io.emit("presence",{online:Array.from(onlineByUserId.keys())});
}
function emitToUser(userId, event, payload){
  const set = onlineByUserId.get(userId);
  if(set) for(const sid of set) io.to(sid).emit(event, payload);
}

io.on("connection",(socket)=>{
  const userId = socket.request.session && socket.request.session.userId;
  if(!userId){ socket.disconnect(true); return; }

  if(!onlineByUserId.has(userId)) onlineByUserId.set(userId, new Set());
  onlineByUserId.get(userId).add(socket.id);

  try{
    const db = readDb();
    const groups = (db.groups||[]).filter(g=>(g.members||[]).includes(userId));
    for(const g of groups) socket.join(groupRoom(g.id));
  }catch(e){}

  emitPresence();

  socket.on("dm_send", async ({toId,text,attachments})=>{
    if(!toId) return;
    const cleanText = text ? String(text).trim() : "";
    const atts = Array.isArray(attachments) ? attachments : [];
    if(!cleanText && atts.length===0) return;
    const db = readDb();
    const msg = {id:uid("m"),fromId:userId,toId:String(toId),text:cleanText,attachments:atts,createdAt:nowMs(),readAt:null};
    db.messages.push(msg);
    getOrCreateDmConversation(db, userId, String(toId));
    addLog(db, "dm_sent", userId, { toId:String(toId), messageId:msg.id, hasAttachments:atts.length>0 });
    await writeDbAtomic(db);
    emitToUser(userId, "dm_new", msg);
    emitToUser(String(toId), "dm_new", msg);
  });

  socket.on("dm_mark_read", async ({otherId})=>{
    if(!otherId) return;
    const db = readDb();
    const now = nowMs();
    let changed = false;
    for(const m of db.messages){
      if(m.fromId===String(otherId) && m.toId===userId && !m.readAt){
        m.readAt = now;
        changed = true;
      }
    }
    if(changed){
      addLog(db, "dm_read", userId, { otherId:String(otherId) });
      await writeDbAtomic(db);
      emitToUser(String(otherId), "dm_read", { readerId:userId, otherId:String(otherId), readAt: now });
      emitToUser(userId, "dm_counts_changed", {});
    }
  });

  socket.on("group_send", async ({groupId, text, attachments})=>{
    if(!groupId) return;
    const cleanText = text ? String(text).trim() : "";
    const atts = Array.isArray(attachments) ? attachments : [];
    if(!cleanText && atts.length===0) return;

    const db = readDb();
    const g = db.groups.find(x=>x.id===String(groupId));
    if(!g || !(g.members||[]).includes(userId)) return;

    const gm = {id:uid("gm"), groupId:String(groupId), fromId:userId, text:cleanText, attachments:atts, createdAt:nowMs(), seenBy:{}};
    gm.seenBy[userId] = gm.createdAt;
    db.groupMessages.push(gm);
    addLog(db, "group_message_sent", userId, { groupId:String(groupId), messageId:gm.id, hasAttachments:atts.length>0 });
    await writeDbAtomic(db);
    io.to(groupRoom(groupId)).emit("group_new", gm);
  });

  socket.on("group_mark_seen", async ({groupId})=>{
    if(!groupId) return;
    const db = readDb();
    const g = db.groups.find(x=>x.id===String(groupId));
    if(!g || !(g.members||[]).includes(userId)) return;

    const now = nowMs();
    let changed = false;
    for(const gm of db.groupMessages){
      if(gm.groupId===String(groupId)){
        gm.seenBy = gm.seenBy && typeof gm.seenBy==="object" ? gm.seenBy : {};
        if(!gm.seenBy[userId]){
          gm.seenBy[userId] = now;
          changed = true;
        }
      }
    }
    if(changed){
      addLog(db, "group_seen", userId, { groupId:String(groupId) });
      await writeDbAtomic(db);
      io.to(groupRoom(groupId)).emit("group_seen", { groupId:String(groupId), userId, at: now });
    }
  });

  socket.on("disconnect",()=>{
    const set = onlineByUserId.get(userId);
    if(set){
      set.delete(socket.id);
      if(set.size===0) onlineByUserId.delete(userId);
    }
    emitPresence();
  });
});

setInterval(async ()=>{
  try{
    const db = readDb();
    const now = nowMs();
    let changed=false;
    for(const n of (db.notes||[])){
      if(n.status!=="open" || !n.dueAt) continue;
      const snoozeOk = (!n.snoozeUntil) || (n.snoozeUntil<=now);
      if(!snoozeOk) continue;
      if(n.dueAt<=now){
        if(n.lastTriggeredAt) continue;
        n.lastTriggeredAt = now;
        n.updatedAt = now;
        changed=true;
        for(const aid of (n.assignees||[])){
          emitToUser(aid, "reminder_due",{noteId:n.id});
        }
      }
    }
    if(changed) await writeDbAtomic(db);
  }catch(e){}
}, 4000);

server.listen(PORT, "0.0.0.0", ()=>console.log(`Chat4Office running on http://localhost:${PORT}`));