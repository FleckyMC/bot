'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const message = (text, bad=false) => { const e=$('accountMessage'); if(e){e.textContent=text;e.style.color=bad?'var(--danger)':'';} };
  async function api(url, options={}) {
    const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
    if(r.status===204)return null;
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||'Request failed');
    return data;
  }
  let users=[], bots=[];
  async function loadBots(){ const d=await api('/api/admin/bots'); bots=d.bots||[]; }
  function assignedElsewhere(bot, user) {
    if (!bot.assignedTo) return false;
    return !user || bot.assignedTo !== user.username;
  }
  function makeBotSelect(select, selected=[], user=null) {
    if(!select)return;
    const chosen=new Set(selected.map(String));
    select.replaceChildren();
    const available=bots.filter(b=>!assignedElsewhere(b,user)||chosen.has(b.name)||chosen.has(b.accountName));
    for(const b of available){
      const opt=document.createElement('option');
      opt.value=b.accountName||b.name;
      opt.textContent=(b.accountName||'Minecraft account')+(b.assignedTo?' · assigned to '+b.assignedTo:'');
      opt.selected=chosen.has(b.name)||chosen.has(b.accountName);
      select.append(opt);
    }
    select.multiple=true;
    select.hidden=true;
    select.setAttribute('aria-hidden','true');
    select.tabIndex=-1;
    const old=select.nextElementSibling;
    if(old&&old.classList.contains('bot-picker'))old.remove();
    const picker=document.createElement('details');picker.className='bot-picker';
    const summary=document.createElement('summary');
    const updateSummary=()=>{
      const values=[...select.selectedOptions].map(o=>o.textContent.split(' · assigned to ')[0]);
      summary.textContent=values.length?values.join(', '):'Choose bots…';
      if(values.length>2)summary.textContent=values.slice(0,2).join(', ')+` +${values.length-2} more`;
    };
    const menu=document.createElement('div');menu.className='bot-picker-menu';
    if(!available.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='No available bots yet.';menu.append(empty);}
    for(const opt of [...select.options]){
      const label=document.createElement('label');label.className='bot-picker-option';
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=opt.selected;
      checkbox.addEventListener('change',()=>{opt.selected=checkbox.checked;updateSummary();});
      const text=document.createElement('span');text.textContent=opt.textContent;
      label.append(checkbox,text);menu.append(label);
    }
    picker.append(summary,menu);
    select.insertAdjacentElement('afterend',picker);
    updateSummary();
  }

  async function loadUsers(){
    try { await loadBots(); const d=await api('/api/admin/users'); users=d.users||[]; drawUsers(); makeBotSelect($('createBotNames')); }
    catch(e){ message(e.message,true); }
  }
  function selectedBots(select){return select?[...select.selectedOptions].map(o=>o.value):[];}
  function drawUsers(){
    const root=$('accountList'); if(!root)return; root.replaceChildren();
    const q=($('accountSearch').value||'').toLowerCase();
    const shown=users.filter(u=>u.username.toLowerCase().includes(q));
    if(!shown.length){root.textContent='No matching accounts.';return;}
    for(const u of shown){
      const card=document.createElement('div');card.className='bot';
      const top=document.createElement('div');top.className='top';
      const name=document.createElement('span');name.className='name';name.textContent=u.username;
      const role=document.createElement('span');role.className='chip';role.textContent=u.role==='admin'?'Admin':'User';
      top.append(name,role);card.append(top);
      const expiry=document.createElement('div');expiry.className='detail';expiry.textContent='Lifetime: '+(u.expiresAt?new Date(u.expiresAt).toLocaleString():'Permanent');card.append(expiry);
      const assigned=document.createElement('div');assigned.className='detail';assigned.textContent='Assigned bots: '+((u.botNames||[]).join(', ')||'None');card.append(assigned);
      const actions=document.createElement('div');actions.className='row wrap';
      const edit=document.createElement('button');edit.className='ghost';edit.textContent='Edit access / lifetime';
      edit.onclick=async()=>{
        try {
          const wrapper=document.createElement('div');wrapper.className='account-bot-editor';
          const label=document.createElement('label');label.textContent='Assigned bots (only unassigned bots or this account)';
          const select=document.createElement('select');select.multiple=true;select.size=5;
          makeBotSelect(select,u.botNames||[],u);label.append(select);wrapper.append(label);
          const daysLabel=document.createElement('label');daysLabel.textContent='Lifetime in days (blank = permanent)';
          const days=document.createElement('input');days.type='number';days.min='1';days.placeholder='Permanent';days.value=u.expiresAt?String(Math.max(1,Math.ceil((u.expiresAt-Date.now())/86400000))):'';daysLabel.append(days);wrapper.append(daysLabel);
          const dlg=document.createElement('dialog');dlg.className='account-edit-dialog';dlg.append(wrapper);
          const save=document.createElement('button');save.className='primary';save.textContent='Save changes';
          const cancel=document.createElement('button');cancel.className='ghost';cancel.textContent='Cancel';
          const row=document.createElement('div');row.className='row wrap';row.append(save,cancel);dlg.append(row);document.body.append(dlg);
          cancel.onclick=()=>dlg.close();
          save.onclick=async()=>{try{const daysText=days.value.trim();const expiresAt=daysText?Date.now()+Math.max(1,Number(daysText))*86400000:null;await api('/api/admin/users/'+encodeURIComponent(u.id),{method:'PATCH',body:JSON.stringify({botNames:selectedBots(select),expiresAt})});dlg.close();dlg.remove();await loadUsers();message('Account updated.');}catch(e){message(e.message,true);}};
          dlg.addEventListener('close',()=>dlg.remove(),{once:true});dlg.showModal();
        } catch(e){message(e.message,true);}
      };
      actions.append(edit);
      const view=document.createElement('button');view.className='ghost';view.textContent='View as account';view.onclick=()=>{window.dispatchEvent(new CustomEvent('dashboard:view-as',{detail:{userId:u.id,username:u.username}}));message('Viewing account: '+u.username);};
      actions.append(view);
      if(u.role!=='admin'){
        const del=document.createElement('button');del.className='danger-ghost';del.textContent='Delete account';
        del.onclick=async()=>{if(!confirm('Delete account '+u.username+'?'))return;try{await api('/api/admin/users/'+encodeURIComponent(u.id),{method:'DELETE'});await loadUsers();message('Account deleted.');}catch(e){message(e.message,true);}};
        actions.append(del);
      }
      card.append(actions);root.append(card);
    }
  }
  $('createAccount')?.addEventListener('submit',async e=>{
    e.preventDefault();const f=new FormData(e.currentTarget);const days=String(f.get('days')||'').trim();
    const payload={username:f.get('username'),password:f.get('password'),botNames:selectedBots($('createBotNames')),expiresAt:days?Date.now()+Math.max(1,Number(days))*86400000:null};
    try{await api('/api/admin/users',{method:'POST',body:JSON.stringify(payload)});e.currentTarget.reset();await loadUsers();message('Account created.');}catch(err){message(err.message,true);}
  });
  $('refreshAccounts')?.addEventListener('click',loadUsers);
  $('accountSearch')?.addEventListener('input',drawUsers);
  $('changePassword')?.addEventListener('submit',async e=>{
    e.preventDefault();const f=new FormData(e.currentTarget);
    try{await api('/api/password',{method:'POST',body:JSON.stringify({currentPassword:f.get('currentPassword'),newPassword:f.get('newPassword')})});e.currentTarget.reset();message('Password updated.');}
    catch(err){message(err.message,true);}
  });
  $('exitViewAs')?.addEventListener('click',()=>{window.dispatchEvent(new CustomEvent('dashboard:exit-view-as'));message('Returned to admin view.');});
  api('/api/me').then(async({user})=>{if(user?.role==='admin'){$('accountPanel').hidden=false;const nav=$('adminNav');if(nav)nav.hidden=false;await loadUsers();}}).catch(()=>{});
})();
