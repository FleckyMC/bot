'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SESSION_MS = 7 * 24 * 3600 * 1000;
let usersFile = null;
const sessions = new Map();
const attempts = new Map();
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a,b) => crypto.timingSafeEqual(sha(a),sha(b));
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}
function verifyPassword(password, entry) {
  if (!entry || !entry.salt || !entry.hash) return false;
  const got = crypto.scryptSync(String(password), entry.salt, 64);
  const want = Buffer.from(entry.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function configure(file, adminUser, adminPassword) {
  usersFile = file;
  fs.mkdirSync(path.dirname(file), {recursive:true});
  let data = {users:[]};
  try { data = JSON.parse(fs.readFileSync(file,'utf8')); } catch {}
  if (!Array.isArray(data.users)) data.users = [];
  let admin = data.users.find(u => u.username === adminUser);
  if (!admin) {
    const hp = hashPassword(adminPassword);
    admin = {id:crypto.randomUUID(),username:adminUser,role:'admin',...hp,createdAt:Date.now(),expiresAt:null,botLimit:0,botNames:[]};
    data.users.push(admin);
  } else if (admin.role !== 'admin') admin.role = 'admin';
  saveUsers(data.users);
}
function getUsers() { try { return JSON.parse(fs.readFileSync(usersFile,'utf8')).users || []; } catch { return []; } }
function saveUsers(users) { const tmp=usersFile+'.tmp'; fs.writeFileSync(tmp,JSON.stringify({users},null,2),{mode:0o600}); fs.renameSync(tmp,usersFile); }
function publicUser(u) { return {id:u.id,username:u.username,role:u.role,createdAt:u.createdAt,expiresAt:u.expiresAt||null,botLimit:u.botLimit||0,botNames:Array.isArray(u.botNames)?u.botNames:[]}; }
function createUser({username,password,role='user',expiresAt=null,botLimit=0,botNames=[]}) {
  username=String(username||'').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new Error('Username must be 3–32 letters, numbers, dots, dashes or underscores.');
  if (String(password||'').length < 10) throw new Error('Password must contain at least 10 characters.');
  const users=getUsers(); if(users.some(u=>u.username.toLowerCase()===username.toLowerCase())) throw new Error('Username already exists.');
  const hp=hashPassword(password);
  const limit=Math.max(0,Math.floor(Number(botLimit)||0));
  const assigned=Array.isArray(botNames)?[...new Set(botNames.map(String).map(x=>x.trim()).filter(Boolean))]:[];
  if(limit>0&&assigned.length>limit) throw new Error('Assigned bot count exceeds the account bot limit.');
  const user={id:crypto.randomUUID(),username,role:role==='admin'?'admin':'user',...hp,createdAt:Date.now(),expiresAt:expiresAt?Number(expiresAt):null,botLimit:limit,botNames:assigned};
  users.push(user); saveUsers(users); return publicUser(user);
}
function updateUser(id, patch={}) {
  const users=getUsers(), u=users.find(x=>x.id===id); if(!u) throw new Error('User not found.');
  if(patch.expiresAt !== undefined) u.expiresAt=patch.expiresAt===null||patch.expiresAt===''?null:Number(patch.expiresAt);
  if(patch.botLimit !== undefined) u.botLimit=Math.max(0,Math.floor(Number(patch.botLimit)||0));
  if(patch.botNames !== undefined) u.botNames=Array.isArray(patch.botNames)?[...new Set(patch.botNames.map(String).map(x=>x.trim()).filter(Boolean))]:[];
  if(u.botLimit>0&&u.botNames.length>u.botLimit) throw new Error('Assigned bot count exceeds the account bot limit.');
  saveUsers(users); return publicUser(u);
}
function deleteUser(id) { const users=getUsers(), u=users.find(x=>x.id===id); if(!u) throw new Error('User not found.'); if(u.role==='admin') throw new Error('Admin accounts cannot be deleted here.'); saveUsers(users.filter(x=>x.id!==id)); for(const [t,s] of sessions) if(s.userId===id) sessions.delete(t); }
function changePassword(userId,currentPassword,newPassword) {
  if(String(newPassword||'').length<10) throw new Error('New password must contain at least 10 characters.');
  const users=getUsers(),u=users.find(x=>x.id===userId); if(!u||!verifyPassword(currentPassword,u)) throw new Error('Current password is incorrect.');
  Object.assign(u,hashPassword(newPassword)); saveUsers(users);
}
function parseCookies(header) { const out={}; for(const part of String(header||'').split(';')) {const i=part.indexOf('=');if(i>0){try{out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}catch{}}} return out; }
function tokenFrom(req) { return parseCookies(req.headers.cookie).session; }
function sessionUser(token) { if(!token)return null; const s=sessions.get(token); if(!s)return null; if(s.expiresAt<Date.now()){sessions.delete(token);return null;} const u=getUsers().find(x=>x.id===s.userId); if(!u||(u.expiresAt&&u.expiresAt<Date.now())){sessions.delete(token);return null;} return u; }
function isValid(token) { return !!sessionUser(token); }
function tooManyAttempts(ip) {const e=attempts.get(ip);return !!e&&e.resetAt>Date.now()&&e.count>=8;}
function noteFailure(ip) {const now=Date.now(),e=attempts.get(ip);if(!e||e.resetAt<now)attempts.set(ip,{count:1,resetAt:now+600000});else e.count++;}
function login(username,password,ip) {
 if(tooManyAttempts(ip))return {error:'rate'};
 const u=getUsers().find(x=>x.username.toLowerCase()===String(username||'').toLowerCase());
 const ok=verifyPassword(password,u);
 if(!ok){noteFailure(ip);return {error:'invalid'};}
 if(u.expiresAt&&u.expiresAt<Date.now()){noteFailure(ip);return {error:'expired'};}
 attempts.delete(ip); const token=crypto.randomBytes(32).toString('hex');
 sessions.set(token,{userId:u.id,expiresAt:Date.now()+SESSION_MS}); return {token,user:publicUser(u)};
}
function logout(token){sessions.delete(token);}
function cookieHeader(token,secure,clear=false){const p=[`session=${clear?'':token}`,'HttpOnly','SameSite=Strict','Path=/',`Max-Age=${clear?0:Math.floor(SESSION_MS/1000)}`];if(secure)p.push('Secure');return p.join('; ');}
setInterval(()=>{const now=Date.now();for(const [t,s] of sessions)if(s.expiresAt<now)sessions.delete(t);for(const [ip,e] of attempts)if(e.resetAt<now)attempts.delete(ip);},600000).unref();
module.exports={configure,getUsers,publicUser,createUser,updateUser,deleteUser,changePassword,sessionUser,login,logout,isValid,tokenFrom,parseCookies,cookieHeader};
