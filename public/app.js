const state = {
  me:null, users:[], online:new Set(),
  selected:{type:null, id:null},
  settings:{officeName:"Chat4Office", reminderSoundUrl:"/sounds/notify.wav", dmSoundUrl:"/sounds/dm.wav", maxUploadMb:15},
  soundEnabled:false,
  notes:[], notesTab:"open", editingNoteId:null,
  groups:[],
  socket:null,
  unreadCounts:{},
  attachQueue:[],
  yt:{player:null}
};

const $ = (id)=>document.getElementById(id);
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function fmtTime(ms){
  const d = new Date(ms); const pad=(n)=>String(n).padStart(2,'0');
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
async function api(path, opts={}){
  const r = await fetch(path, opts);
  const j = await r.json().catch(()=> ({}));
  if(!r.ok) throw j;
  return j;
}

function toast(title, body){
  const host = $('toast');
  const div = document.createElement('div');
  div.className = 'toastItem';
  div.innerHTML = `<div style="font-weight:700">${escapeHtml(title)}</div><div class="smallMuted" style="margin-top:6px">${escapeHtml(body||'')}</div>`;
  host.appendChild(div);
  setTimeout(()=>{ try{ div.remove(); }catch(e){} }, 5000);
}

async function init(){
  state.soundEnabled = localStorage.getItem('c4o_sound')==='1';
  updateSoundButton();

  state.me = await api('/api/me').catch(()=>null);
  if(!state.me){ location.href='/login.html'; return; }
  $('meBadge').textContent = `${state.me.displayName} (@${state.me.username})`;

  state.settings = (await api('/api/settings')).settings || state.settings;
  $('officeName').textContent = state.settings.officeName || 'Chat4Office';
  if(state.me.role==='admin') $('adminLink').style.display='inline-flex';

  state.users = (await api('/api/users')).users || [];
  await refreshUnreadCounts();

  await loadGroups();
  fillAssignees();
  fillGroupMemberPickers();

  renderDmList();
  renderGroupList();
  await loadNotes(false);

  state.socket = io();

  state.socket.on('presence', ({online})=>{
    state.online = new Set(online||[]);
    renderDmList();
    renderGroupList();
    updateChatStatus();
    $('onlineCount').textContent = `${state.online.size} online`;
  });

  state.socket.on('dm_new', async (msg)=>{
    const isIncoming = msg.toId===state.me.id;
    const isActiveChat = (state.selected.type==='dm' && state.selected.id===msg.fromId);
    if(isIncoming && !isActiveChat){
      await refreshUnreadCounts();
      renderDmList();
      dmNotify(msg);
    }
    if(state.selected.type==='dm' && (
      (msg.fromId===state.selected.id && msg.toId===state.me.id) ||
      (msg.toId===state.selected.id && msg.fromId===state.me.id)
    )){
      appendMessage(msg);
      scrollChatBottom();
      if(msg.toId===state.me.id){
        state.socket.emit('dm_mark_read',{otherId: state.selected.id});
        await refreshUnreadCounts();
        renderDmList();
        updateAllMessageReadBadges();
      }
    }
  });

  state.socket.on('dm_read', ({readerId})=>{
    if(state.selected.type==='dm' && state.selected.id===readerId){
      updateAllMessageReadBadges();
    }
  });

  state.socket.on('dm_counts_changed', async ()=>{
    await refreshUnreadCounts();
    renderDmList();
  });

  state.socket.on('group_new', async (msg)=>{
    const isIncoming = msg.fromId !== state.me.id;
    const isActive = (state.selected.type==='group' && state.selected.id===msg.groupId);
    if(isIncoming && !isActive){
      groupNotify(msg);
      renderGroupList();
    }
    if(isActive){
      appendGroupMessage(msg);
      scrollChatBottom();
      state.socket.emit('group_mark_seen',{groupId: state.selected.id});
    }
  });

  state.socket.on('reminder_due', async ({noteId})=>{
    await loadNotes(true);
    const note = state.notes.find(n=>n.id===noteId);
    if(note) showReminder(note);
  });

  $('btnLogout').onclick = logout;
  $('btnSend').onclick = sendCurrent;
  $('chatInput').addEventListener('keydown', (e)=>{ if(e.key==='Enter') sendCurrent(); });

  $('btnAttach').onclick = ()=> $('attachFile').click();
  $('attachFile').onchange = async (e)=>{ if(e.target.files && e.target.files[0]) await uploadAttachment(e.target.files[0]); e.target.value=''; };

  $('btnClearChat').onclick = clearCurrentChat;

  document.querySelectorAll('.tab').forEach(t=>{
    t.onclick = async ()=>{
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      state.notesTab = t.getAttribute('data-tab');
      await loadNotes(false);
    };
  });

  document.querySelectorAll('.leftTab').forEach(t=>{
    t.onclick = ()=>{
      document.querySelectorAll('.leftTab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      const which = t.getAttribute('data-left');
      $('dmList').style.display = which==='dm' ? 'block':'none';
      $('groupList').style.display = which==='group' ? 'block':'none';
      $('groupActions').style.display = which==='group' ? 'block':'none';
    };
  });

  $('btnNewGroup').onclick = ()=> openGroupCreate();
  $('groupClose').onclick = closeGroupCreate;
  $('groupBack').addEventListener('click',(e)=>{ if(e.target.id==='groupBack') closeGroupCreate(); });
  $('btnCreateGroup').onclick = createGroup;

  $('groupManageClose').onclick = closeGroupManage;
  $('groupManageBack').addEventListener('click',(e)=>{ if(e.target.id==='groupManageBack') closeGroupManage(); });
  $('btnSaveGroup').onclick = saveGroupManage;

  $('btnNewNote').onclick = ()=> openNoteModal(null);
  $('modalClose').onclick = closeNoteModal;
  $('modalBack').addEventListener('click', (e)=>{ if(e.target.id==='modalBack') closeNoteModal(); });
  $('btnSaveNote').onclick = saveNote;
  $('btnDeleteNote').onclick = deleteNote;

  $('btnSound').onclick = async ()=>{
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('c4o_sound', state.soundEnabled ? '1' : '0');
    updateSoundButton();
    if(state.soundEnabled) await warmupSounds();
    if("Notification" in window && Notification.permission!=="granted" && Notification.permission!=="denied"){
      // optional, ask once after a user action
      try{ await Notification.requestPermission(); }catch(e){}
    }
  };

  $('btnAvatar').onclick = ()=> $('avatarFile').click();
  $('avatarFile').onchange = async (e)=>{ if(e.target.files && e.target.files[0]) await uploadAvatar(e.target.files[0]); e.target.value=''; };

  $('remClose').onclick = closeReminder;
  $('remBack').addEventListener('click', (e)=>{ if(e.target.id==='remBack') closeReminder(); });
  document.querySelectorAll('#remBack [data-snooze]').forEach(b=>{
    b.onclick = ()=> snoozeCurrentReminder(Number(b.getAttribute('data-snooze')));
  });
  $('btnDone').onclick = doneCurrentReminder;

  $('onlineCount').textContent = `${state.online.size} online`;
}

async function refreshUnreadCounts(){
  const res = await api('/api/unread_counts').catch(()=>({counts:{}}));
  state.unreadCounts = res.counts || {};
}

async function logout(){ try{ await api('/api/logout',{method:'POST'}); }catch(e){} location.href='/login.html'; }
function updateSoundButton(){ $('btnSound').textContent = state.soundEnabled ? '🔊 Bildirim sesleri açık' : '🔇 Bildirim seslerini etkinleştir'; }

function userById(id){ return state.users.find(u=>u.id===id) || null; }
function userName(id){ return userById(id)?.displayName || 'Bilinmeyen'; }
function avatarUrl(id){ return userById(id)?.avatarUrl || '/default_avatar.svg'; }

function renderDmList(){
  const list = $('dmList'); list.innerHTML='';
  state.users
    .filter(u=>u.id!==state.me.id)
    .sort((a,b)=>a.displayName.localeCompare(b.displayName))
    .forEach(u=>{
      const isOn = state.online.has(u.id);
      const active = (state.selected.type==='dm' && state.selected.id===u.id);
      const unread = state.unreadCounts[u.id] || 0;
      const div = document.createElement('div');
      div.className = 'item'+(active?' active':'');
      div.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;">
          <img class="avatar" src="${escapeHtml(u.avatarUrl||'/default_avatar.svg')}" onerror="this.src='/default_avatar.svg'"/>
          <div>
            <div style="font-weight:600"><span class="dot ${isOn?'on':''}"></span>${escapeHtml(u.displayName)}</div>
            <div class="pill">@${escapeHtml(u.username)}</div>
          </div>
        </div>
        <div class="row">
          ${unread?`<span class="badgeCount new">${unread} yeni</span>`:''}
          <span class="pill">${isOn?'online':'offline'}</span>
        </div>`;
      div.onclick = ()=> selectDm(u.id);
      list.appendChild(div);
    });
}

async function loadGroups(){
  const res = await api('/api/groups').catch(()=>({groups:[]}));
  state.groups = res.groups || [];
}
function renderGroupList(){
  const list = $('groupList'); list.innerHTML='';
  const groups = (state.groups||[]).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  if(groups.length===0){
    const div=document.createElement('div'); div.className='note';
    div.innerHTML = `<div class="smallMuted">Henüz grubun yok. + Grup Kur ile oluştur.</div>`;
    list.appendChild(div);
    return;
  }
  groups.forEach(g=>{
    const active = (state.selected.type==='group' && state.selected.id===g.id);
    const div=document.createElement('div');
    div.className='item'+(active?' active':'');
    div.innerHTML = `
      <div>
        <div style="font-weight:600">👥 ${escapeHtml(g.name)}</div>
        <div class="pill">${escapeHtml((g.members||[]).length)} üye</div>
      </div>
      <div class="row">
        ${(g.ownerId===state.me.id || state.me.role==='admin') ? `<button class="btn small" data-manage="${g.id}">⚙️</button>`:''}
      </div>
    `;
    div.onclick = (e)=>{
      if(e.target && e.target.getAttribute && e.target.getAttribute('data-manage')) return;
      selectGroup(g.id);
    };
    list.appendChild(div);
  });

  list.querySelectorAll('[data-manage]').forEach(btn=>{
    btn.onclick = (e)=>{ e.stopPropagation(); openGroupManage(btn.getAttribute('data-manage')); };
  });
}

function enableComposer(enable){
  $('chatInput').disabled = !enable;
  $('btnSend').disabled = !enable;
  $('btnAttach').disabled = !enable;
  $('btnClearChat').disabled = !enable;
}

async function selectDm(userId){
  state.selected = {type:'dm', id:userId};
  state.attachQueue = [];
  updateAttachHint();
  renderDmList(); renderGroupList();
  updateChatStatus();

  const u = userById(userId);
  $('chatTitle').innerHTML = `<img class="avatar sm" src="${escapeHtml(avatarUrl(userId))}" onerror="this.src='/default_avatar.svg'"/> ${escapeHtml(u?u.displayName:'DM')}`;
  $('chatSub').textContent = u ? `@${u.username}` : '';
  enableComposer(true);

  $('chatLog').innerHTML='';
  const {messages} = await api('/api/messages/'+userId);
  (messages||[]).forEach(appendMessage);
  scrollChatBottom();

  state.socket.emit('dm_mark_read',{otherId:userId});
  await refreshUnreadCounts();
  renderDmList();
  updateAllMessageReadBadges();
}

async function selectGroup(groupId){
  state.selected = {type:'group', id:groupId};
  state.attachQueue = [];
  updateAttachHint();
  renderDmList(); renderGroupList();
  updateChatStatus();

  const g = state.groups.find(x=>x.id===groupId);
  $('chatTitle').innerHTML = `👥 ${escapeHtml(g?g.name:'Grup')}`;
  $('chatSub').textContent = g ? `${(g.members||[]).length} üye` : '';
  enableComposer(true);

  $('chatLog').innerHTML='';
  const {messages} = await api('/api/group_messages/'+groupId);
  (messages||[]).forEach(appendGroupMessage);
  scrollChatBottom();

  state.socket.emit('group_mark_seen',{groupId});
}

function updateChatStatus(){
  const st = $('chatStatus');
  if(!state.selected.type){ st.textContent='-'; return; }
  if(state.selected.type==='dm'){
    st.textContent = state.online.has(state.selected.id) ? 'online' : 'offline';
  }else{
    st.textContent = 'grup';
  }
}

function appendAttachmentsHtml(atts){
  if(!atts || !atts.length) return '';
  const parts = atts.map(a=>{
    const url = a.url||'';
    const mime = (a.mime||'').toLowerCase();
    const name = a.name||'dosya';
    const isImg = mime.startsWith('image/');
    if(isImg){
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="${escapeHtml(name)}"/></a>`;
    }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">📎 ${escapeHtml(name)}</a>`;
  });
  return `<div class="attach">${parts.join('')}</div>`;
}

function appendMessage(msg){
  const div = document.createElement('div');
  div.className = 'bubble '+(msg.fromId===state.me.id?'me':'');
  const sender = msg.fromId===state.me.id ? 'Sen' : userName(msg.fromId);
  const readInfo = (msg.fromId===state.me.id)
    ? (msg.readAt ? `✓✓ Görüldü ${fmtTime(msg.readAt)}` : '✓ Gönderildi')
    : '';
  div.dataset.mid = msg.id;
  div.innerHTML = `
    <div>${escapeHtml(msg.text||'')}</div>
    ${appendAttachmentsHtml(msg.attachments||[])}
    <div class="meta">
      <span>${escapeHtml(sender)} • ${fmtTime(msg.createdAt)}</span>
      <span class="pill" data-read>${escapeHtml(readInfo)}</span>
    </div>`;
  $('chatLog').appendChild(div);
}

function appendGroupMessage(msg){
  const div = document.createElement('div');
  div.className = 'bubble '+(msg.fromId===state.me.id?'me':'');
  const sender = msg.fromId===state.me.id ? 'Sen' : userName(msg.fromId);
  div.dataset.gmid = msg.id;
  div.innerHTML = `
    <div>${escapeHtml(msg.text||'')}</div>
    ${appendAttachmentsHtml(msg.attachments||[])}
    <div class="meta">
      <span>${escapeHtml(sender)} • ${fmtTime(msg.createdAt)}</span>
      <span class="pill"></span>
    </div>`;
  $('chatLog').appendChild(div);
}

function updateAllMessageReadBadges(){
  if(state.selected.type!=='dm') return;
  api('/api/messages/'+state.selected.id).then(({messages})=>{
    const byId = new Map((messages||[]).map(m=>[m.id,m]));
    document.querySelectorAll('#chatLog .bubble.me').forEach(b=>{
      const mid=b.dataset.mid;
      const m=byId.get(mid);
      const el=b.querySelector('[data-read]');
      if(el && m){
        el.textContent = m.readAt ? `✓✓ Görüldü ${fmtTime(m.readAt)}` : '✓ Gönderildi';
      }
    });
  }).catch(()=>{});
}

function scrollChatBottom(){ const el=$('chatLog'); el.scrollTop = el.scrollHeight; }

async function sendCurrent(){
  if(!state.selected.type) return;
  const text = $('chatInput').value.trim();
  const atts = state.attachQueue.slice();
  if(!text && atts.length===0) return;

  if(state.selected.type==='dm'){
    state.socket.emit('dm_send',{toId:state.selected.id, text, attachments:atts});
  }else{
    state.socket.emit('group_send',{groupId:state.selected.id, text, attachments:atts});
  }
  $('chatInput').value='';
  state.attachQueue = [];
  updateAttachHint();
}

async function clearCurrentChat(){
  if(!state.selected.type) return;
  if(!confirm('Bu işlem sadece senin ekranında geçmişi gizler. Veritabanından silinmez. Devam?')) return;
  if(state.selected.type==='dm'){
    await api('/api/messages/'+state.selected.id+'/clear',{method:'POST'});
    $('chatLog').innerHTML='';
    toast('Geçmiş temizlendi', 'DM geçmişi senin ekranında sıfırlandı.');
  }else{
    await api('/api/group_messages/'+state.selected.id+'/clear',{method:'POST'});
    $('chatLog').innerHTML='';
    toast('Geçmiş temizlendi', 'Grup geçmişi senin ekranında sıfırlandı.');
  }
}

function updateAttachHint(){
  if(state.attachQueue.length===0){
    $('attachHint').textContent = '';
    return;
  }
  const names = state.attachQueue.map(a=>a.name||'dosya').join(', ');
  $('attachHint').textContent = `Eklendi: ${names}`;
}

async function uploadAttachment(file){
  if(!state.selected.type) return;
  const maxMb = Number(state.settings.maxUploadMb||15);
  if(file.size > maxMb*1024*1024){
    alert(`Dosya çok büyük. Maks: ${maxMb} MB`);
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  try{
    const r = await fetch('/api/upload/dm', {method:'POST', body: fd});
    const j = await r.json();
    if(!r.ok) throw j;
    state.attachQueue.push(j.file);
    updateAttachHint();
  }catch(e){
    alert('Yükleme başarısız.');
  }
}

async function uploadAvatar(file){
  const fd = new FormData();
  fd.append('file', file);
  try{
    const r = await fetch('/api/upload/avatar', {method:'POST', body: fd});
    const j = await r.json();
    if(!r.ok) throw j;
    toast('Profil resmi güncellendi', 'Yeni avatar kaydedildi.');
    state.me = await api('/api/me');
    state.users = (await api('/api/users')).users || state.users;
    renderDmList();
  }catch(e){
    alert('Avatar yükleme başarısız.');
  }
}

function dmNotify(msg){
  const u = userById(msg.fromId);
  const title = u ? u.displayName : 'Yeni mesaj';
  const body = (msg.text||'').slice(0,120) + ((msg.text||'').length>120?'…':'');
  toast('DM: '+title, body || '(Dosya)');
  if(state.soundEnabled) playDMSound();
  if("Notification" in window && Notification.permission==="granted"){
    try{ new Notification('DM: '+title, { body: body || 'Yeni mesaj', silent:true }); }catch(e){}
  }
}
function groupNotify(msg){
  const g = state.groups.find(x=>x.id===msg.groupId);
  const title = g ? g.name : 'Grup';
  const body = `${userName(msg.fromId)}: ${(msg.text||'(Dosya)').slice(0,120)}${(msg.text||'').length>120?'…':''}`;
  toast('Grup: '+title, body);
  if(state.soundEnabled) playDMSound();
}

async function loadNotes(){
  const scope = (state.notesTab==='created') ? 'created' : 'inbox';
  const {notes} = await api('/api/notes?scope='+encodeURIComponent(scope));
  state.notes = notes || [];
  renderNotes();
  const ids = getVisibleNoteIdsForMarkSeen();
  if(ids.length){
    api('/api/notes/mark_seen',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({noteIds:ids})}).catch(()=>{});
  }
}
function getVisibleNoteIdsForMarkSeen(){
  const tab = state.notesTab;
  let items = state.notes.slice();
  if(tab==='done') items = items.filter(n=>n.status==='done');
  else if(tab==='created') items = items.filter(n=>n.creatorId===state.me.id);
  else items = items.filter(n=>n.status==='open');
  return items.map(n=>n.id);
}

function renderNotes(){
  const list = $('notesList'); list.innerHTML='';
  const tab = state.notesTab;

  let items = state.notes.slice();
  if(tab==='done') items = items.filter(n=>n.status==='done');
  else if(tab==='created') items = items.filter(n=>n.creatorId===state.me.id);
  else items = items.filter(n=>n.status==='open');

  if(items.length===0){
    const empty=document.createElement('div'); empty.className='note';
    empty.innerHTML=`<div class="smallMuted">Kayıt yok.</div>`; list.appendChild(empty); return;
  }

  items.sort((a,b)=>(a.dueAt||9e15)-(b.dueAt||9e15)).forEach(n=>{
    const div=document.createElement('div'); div.className='note';
    const creatorName = (n.creatorId===state.me.id) ? state.me.displayName : (userById(n.creatorId)?.displayName || 'Bilinmiyor');
    const assigneesNames = (n.assignees||[]).map(id=> id===state.me.id ? state.me.displayName : (userById(id)?.displayName || '???')).join(', ');
    const due = n.dueAt ? `⏰ ${fmtTime(n.dueAt)}` : `📝 Not`;
    const imp = n.important ? `<span class="star">⭐</span>` : '';
    const doneInfo = n.status==='done' ? `✅ ${fmtTime(n.doneAt||n.updatedAt)}` : '';
    const doneBy = n.status==='done' ? (n.doneById===state.me.id ? state.me.displayName : (userById(n.doneById)?.displayName || 'Bilinmiyor')) : '';

    const mySeenAt = (n.seenBy||{})[state.me.id] || 0;
    const isNewForMe = (n.updatedAt || n.createdAt) > mySeenAt;
    const newBadge = isNewForMe ? `<span class="badgeCount new">Yeni</span>` : '';

    let seenSummary = '';
    if(n.creatorId===state.me.id){
      const seenBy = n.seenBy || {};
      const total = (n.assignees||[]).length;
      const seenCount = (n.assignees||[]).filter(id=>!!seenBy[id]).length;
      seenSummary = `<span class="tag">Okundu: ${seenCount}/${total}</span>`;
    }

    const canDelete = (state.me.role==='admin' || n.creatorId===state.me.id);

    div.innerHTML = `
      <div class="noteTop">
        <div class="row">${imp}${newBadge}<span class="tag">${escapeHtml(due)}</span>${n.snoozeUntil?`<span class="tag">😴 Erteli: ${fmtTime(n.snoozeUntil)}</span>`:''}${doneInfo?`<span class="tag">${escapeHtml(doneInfo)}</span>`:''}${doneBy?`<span class="tag">Bitiren: ${escapeHtml(doneBy)}</span>`:''}${seenSummary}</div>
        <div class="row">
          ${n.status==='open'?`<button class="btn small" data-done="${n.id}">Bitir</button>`:''}
          <button class="btn small" data-edit="${n.id}">Düzenle</button>
          ${canDelete?`<button class="btn small danger" data-del="${n.id}">Sil</button>`:''}
        </div>
      </div>
      <div class="noteText" style="margin-top:8px;">${escapeHtml(n.text)}</div>
      <div class="tag" style="margin-top:8px;">Yazan: ${escapeHtml(creatorName)} • Kime: ${escapeHtml(assigneesNames)}</div>`;
    list.appendChild(div);
  });

  list.querySelectorAll('[data-done]').forEach(b=> b.onclick = async ()=>{
    await api('/api/notes/'+b.getAttribute('data-done')+'/done',{method:'POST'});
    await loadNotes();
  });
  list.querySelectorAll('[data-edit]').forEach(b=> b.onclick = ()=>{
    const id=b.getAttribute('data-edit');
    openNoteModal(state.notes.find(x=>x.id===id));
  });
  list.querySelectorAll('[data-del]').forEach(b=> b.onclick = async ()=>{
    const id=b.getAttribute('data-del');
    if(!confirm('Silinsin mi?')) return;
    await api('/api/notes/'+id,{method:'DELETE'}).catch(()=>{ alert('Silme yetkin yok.'); });
    await loadNotes();
  });
}

function fillAssignees(){
  const sel = $('noteAssignees'); sel.innerHTML='';
  const all = [state.me, ...state.users.filter(u=>u.id!==state.me.id)].sort((a,b)=>a.displayName.localeCompare(b.displayName));
  all.forEach(u=>{
    const opt=document.createElement('option');
    opt.value=u.id; opt.textContent=`${u.displayName} (@${u.username})`;
    sel.appendChild(opt);
  });
}

function fillGroupMemberPickers(){
  const sel = $('groupMembers'); sel.innerHTML='';
  const sel2 = $('groupEditMembers'); sel2.innerHTML='';
  const all = [state.me, ...state.users.filter(u=>u.id!==state.me.id)].sort((a,b)=>a.displayName.localeCompare(b.displayName));
  all.forEach(u=>{
    const o1=document.createElement('option'); o1.value=u.id; o1.textContent=`${u.displayName} (@${u.username})`;
    const o2=o1.cloneNode(true);
    sel.appendChild(o1); sel2.appendChild(o2);
  });
}

function openNoteModal(note){
  state.editingNoteId = note ? note.id : null;
  $('modalTitle').textContent = note ? 'Düzenle' : 'Yeni Not / Hatırlatma';
  $('noteText').value = note ? note.text : '';
  $('noteImportant').checked = note ? !!note.important : false;

  if(note && note.dueAt){
    const d=new Date(note.dueAt); const pad=(n)=>String(n).padStart(2,'0');
    $('noteDue').value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } else $('noteDue').value = '';

  const ids = note ? (note.assignees||[]) : [state.me.id];
  Array.from($('noteAssignees').options).forEach(o=>o.selected = ids.includes(o.value));

  const canDelete = note && (state.me.role==='admin' || note.creatorId===state.me.id);
  $('btnDeleteNote').style.display = canDelete ? 'inline-flex' : 'none';

  $('modalBack').style.display='flex';
}
function closeNoteModal(){ $('modalBack').style.display='none'; state.editingNoteId=null; }

async function saveNote(){
  const text=$('noteText').value.trim();
  const important=$('noteImportant').checked;
  const dueVal=$('noteDue').value;
  const dueAt = dueVal ? new Date(dueVal).getTime() : null;
  const assignees = Array.from($('noteAssignees').selectedOptions).map(o=>o.value);
  if(!text){ alert('Metin boş olamaz.'); return; }
  if(assignees.length===0){ alert('En az 1 kişi seç.'); return; }
  if(state.editingNoteId){
    await api('/api/notes/'+state.editingNoteId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,important,dueAt,assignees})});
  }else{
    await api('/api/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,important,dueAt,assignees})});
  }
  closeNoteModal(); await loadNotes();
}
async function deleteNote(){
  if(!state.editingNoteId) return;
  if(!confirm('Silinsin mi?')) return;
  await api('/api/notes/'+state.editingNoteId,{method:'DELETE'}).catch(()=>{ alert('Silme yetkin yok.'); });
  closeNoteModal(); await loadNotes();
}

let currentReminder=null;
async function showReminder(note){
  currentReminder=note;
  $('remText').textContent = note.text;
  const creator = (note.creatorId===state.me.id) ? state.me.displayName : (userById(note.creatorId)?.displayName || 'Bilinmiyor');
  $('remMeta').textContent = `Yazan: ${creator} • Tarih: ${note.dueAt ? fmtTime(note.dueAt) : '-'}`;
  $('remBack').style.display='flex';
  if(state.soundEnabled) await playReminderSound();
}
function closeReminder(){ $('remBack').style.display='none'; currentReminder=null; stopYouTube(); }
async function doneCurrentReminder(){
  if(!currentReminder) return;
  await api('/api/notes/'+currentReminder.id+'/done',{method:'POST'});
  closeReminder(); await loadNotes();
}
async function snoozeCurrentReminder(mins){
  if(!currentReminder) return;
  await api('/api/notes/'+currentReminder.id+'/snooze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:mins})});
  closeReminder(); await loadNotes();
}

function openGroupCreate(){
  $('groupName').value='';
  Array.from($('groupMembers').options).forEach(o=>o.selected = false);
  $('groupBack').style.display='flex';
}
function closeGroupCreate(){ $('groupBack').style.display='none'; }
async function createGroup(){
  const name = $('groupName').value.trim();
  const members = Array.from($('groupMembers').selectedOptions).map(o=>o.value);
  try{
    await api('/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name, members})});
    closeGroupCreate();
    await loadGroups();
    renderGroupList();
    toast('Grup oluşturuldu', name||'Grup');
  }catch(e){ alert('Grup oluşturulamadı.'); }
}

let managingGroupId=null;
function openGroupManage(groupId){
  const g = state.groups.find(x=>x.id===groupId);
  if(!g) return;
  managingGroupId = groupId;
  $('groupEditName').value = g.name;
  const mem = new Set(g.members||[]);
  Array.from($('groupEditMembers').options).forEach(o=>o.selected = mem.has(o.value));
  $('groupManageBack').style.display='flex';
}
function closeGroupManage(){ $('groupManageBack').style.display='none'; managingGroupId=null; }
async function saveGroupManage(){
  if(!managingGroupId) return;
  const name = $('groupEditName').value.trim();
  const selected = Array.from($('groupEditMembers').selectedOptions).map(o=>o.value);
  const g = state.groups.find(x=>x.id===managingGroupId);
  const old = new Set((g?.members)||[]);
  const now = new Set(selected);
  const add = selected.filter(x=>!old.has(x));
  const rem = Array.from(old).filter(x=>!now.has(x));
  try{
    await api('/api/groups/'+managingGroupId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name, addMembers:add, removeMembers:rem})});
    closeGroupManage();
    await loadGroups();
    renderGroupList();
    toast('Grup güncellendi', name||'Grup');
  }catch(e){
    alert('Yetkin yok veya güncelleme başarısız.');
  }
}

async function warmupSounds(){
  await warmupSoundUrl(state.settings.dmSoundUrl || '/sounds/dm.wav');
  await warmupSoundUrl(state.settings.reminderSoundUrl || '/sounds/notify.wav');
}
async function warmupSoundUrl(url){
  try{
    if(isYouTubeUrl(url)){
      await ensureYouTubeReady(url);
      try{ state.yt.player.playVideo(); setTimeout(()=>{ try{ state.yt.player.stopVideo(); }catch(e){} }, 200); }catch(e){}
    }else{
      const a=new Audio(url); a.volume=1.0;
      await a.play().catch(()=>{}); a.pause();
    }
  }catch(e){}
}
async function playDMSound(){ await playSoundUrl(state.settings.dmSoundUrl || '/sounds/dm.wav'); }
async function playReminderSound(){ await playSoundUrl(state.settings.reminderSoundUrl || '/sounds/notify.wav'); }

function isYouTubeUrl(url){ return /youtube\.com|youtu\.be/.test(String(url||'')); }
function extractYouTubeId(url){
  url=String(url||'');
  let m=url.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/); if(m) return m[1];
  m=url.match(/[?&]v=([a-zA-Z0-9_-]{6,})/); if(m) return m[1];
  m=url.match(/shorts\/([a-zA-Z0-9_-]{6,})/); if(m) return m[1];
  return null;
}
function stopYouTube(){ try{ if(state.yt.player) state.yt.player.stopVideo(); }catch(e){} }

async function playSoundUrl(url){
  if(isYouTubeUrl(url)){ await ensureYouTubeReady(url); try{ state.yt.player.playVideo(); }catch(e){}; return; }
  try{ const a=new Audio(url); a.volume=1.0; await a.play(); }catch(e){}
}
async function ensureYouTubeReady(url){
  const vid = extractYouTubeId(url) || 'dQw4w9WgXcQ';
  if(state.yt.player){ try{ state.yt.player.loadVideoById(vid); }catch(e){}; return; }
  await loadYouTubeApi();
  if(!document.getElementById('ytPlayer')){
    const div=document.createElement('div'); div.id='ytPlayer';
    div.style.position='fixed'; div.style.left='-9999px'; div.style.top='-9999px';
    document.body.appendChild(div);
  }
  return new Promise((resolve)=>{
    window.onYouTubeIframeAPIReady = ()=>{
      state.yt.player = new YT.Player('ytPlayer',{height:'0',width:'0',videoId:vid,playerVars:{autoplay:0,controls:0,rel:0},events:{onReady:()=>resolve()}});
    };
    if(window.YT && window.YT.Player) window.onYouTubeIframeAPIReady();
  });
}
function loadYouTubeApi(){
  return new Promise((resolve)=>{
    if(document.getElementById('ytApi')){ resolve(); return; }
    const s=document.createElement('script'); s.id='ytApi'; s.src='https://www.youtube.com/iframe_api'; s.onload=()=>resolve();
    document.head.appendChild(s);
  });
}

init();