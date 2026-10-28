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
  let users=[];
  async function loadUsers(){
    try { const d=await api('/api/admin/users'); users=d.users||[]; drawUsers(); }
    catch(e){ message(e.message,true); }
  }
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
      const limit=document.createElement('div');limit.className='detail';limit.textContent='Bot limit: '+(u.botLimit||'Unlimited');card.append(limit);
      const bots=document.createElement('div');bots.className='detail';bots.textContent='Assigned bots: '+((u.botNames||[]).join(', ')||'None');card.append(bots);
      const actions=document.createElement('div');actions.className='row wrap';
      const edit=document.createElement('button');edit.className='ghost';edit.textContent='Edit access / lifetime';
      edit.onclick=async()=>{
        const botText=prompt('Assigned bot names, comma-separated', (u.botNames||[]).join(', '));if(botText===null)return;
        const daysText=prompt('Lifetime in days (blank = permanent)',u.expiresAt?String(Math.max(1,Math.ceil((u.expiresAt-Date.now())/86400000))):'');if(daysText===null)return;
        const limitText=prompt('Bot limit (0 = unlimited)',String(u.botLimit||0));if(limitText===null)return;
        const expiresAt=daysText.trim()?Date.now()+Math.max(1,Number(daysText))*86400000:null;
        try{await api('/api/admin/users/'+encodeURIComponent(u.id),{method:'PATCH',body:JSON.stringify({botNames:botText.split(',').map(x=>x.trim()).filter(Boolean),expiresAt,botLimit:Number(limitText)||0})});await loadUsers();message('Account updated.');}catch(e){message(e.message,true);}
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
    const payload={username:f.get('username'),password:f.get('password'),botLimit:Number(f.get('botLimit'))||0,botNames:String(f.get('botNames')||'').split(',').map(x=>x.trim()).filter(Boolean),expiresAt:days?Date.now()+Math.max(1,Number(days))*86400000:null};
    try{await api('/api/admin/users',{method:'POST',body:JSON.stringify(payload)});e.currentTarget.reset();e.currentTarget.elements.botLimit.value='0';await loadUsers();message('Account created.');}catch(err){message(err.message,true);}
  });
  $('refreshAccounts')?.addEventListener('click',loadUsers);
  $('exitViewAs')?.addEventListener('click',()=>{window.dispatchEvent(new CustomEvent('dashboard:exit-view-as'));message('Returned to admin view.');});
  $('accountSearch')?.addEventListener('input',drawUsers);
  $('changePassword')?.addEventListener('submit',async e=>{
    e.preventDefault();const f=new FormData(e.currentTarget);
    try{await api('/api/password',{method:'POST',body:JSON.stringify({currentPassword:f.get('currentPassword'),newPassword:f.get('newPassword')})});e.currentTarget.reset();message('Password updated.');}
    catch(err){message(err.message,true);}
  });
  api('/api/me').then(({user})=>{if(user?.role==='admin'){$('accountPanel').hidden=false;loadUsers();}}).catch(()=>{});
})();
