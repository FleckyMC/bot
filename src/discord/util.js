'use strict';
/** Pure helpers for the Discord bot: pricing, placeholders, star ratings, channel names. */

const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

/** Highest active discount that applies to the plan (an empty planIds list means "all plans"). */
function bestDiscount(discounts, planId) {
  let best = null;
  for (const d of discounts || []) {
    if (!d || !d.active) continue;
    if (Array.isArray(d.planIds) && d.planIds.length && !d.planIds.includes(planId)) continue;
    if (!best || d.percent > best.percent) best = d;
  }
  return best;
}

/** Price of a plan, optionally with a manual percent override (set by an admin inside a ticket). */
function quote(plan, discounts, override) {
  const base = Number(plan.price) || 0;
  let percent = 0, label = '';
  if (override && Number.isFinite(override.percent)) { percent = override.percent; label = override.label || 'Admin discount'; }
  else { const d = bestDiscount(discounts, plan.id); if (d) { percent = d.percent; label = d.label || `${d.percent}% off`; } }
  percent = Math.min(100, Math.max(0, percent));
  const total = Math.round(base * (100 - percent)) / 100;
  return { base, percent, discountLabel: percent ? label : '', total };
}

const stars = (n) => '⭐'.repeat(Math.max(0, Math.min(5, n | 0)));

/** "4", "4/5", "⭐⭐⭐" … -> 1..5 or null */
function parseStars(text) {
  const t = String(text || '').trim();
  const emoji = (t.match(/⭐/g) || []).length;
  if (emoji && /^(⭐|\s)+$/.test(t)) return emoji >= 1 && emoji <= 5 ? emoji : null;
  const m = t.match(/^([1-5])(?:\s*\/\s*5)?$/);
  return m ? Number(m[1]) : null;
}

/** {user} {username} {server} {count} placeholders for welcome/leave messages. */
function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(user|username|server|count)\}/g, (_, k) => String(vars[k] ?? ''));
}

/** Discord channel names: lowercase letters, digits, '-' and '_'. */
function ticketChannelName(username) {
  const slug = String(username || 'user').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'user';
  return `ticket-from-${slug}`;
}

const durationLabel = (days) => {
  if (days % 365 === 0) return `${days / 365} year${days / 365 > 1 ? 's' : ''}`;
  if (days % 30 === 0) return `${days / 30} month${days / 30 > 1 ? 's' : ''}`;
  if (days % 7 === 0) return `${days / 7} week${days / 7 > 1 ? 's' : ''}`;
  return `${days} day${days > 1 ? 's' : ''}`;
};

/** "week" x 5 -> "5 weeks"; a unit that already ends in "s" is left alone. */
const unitText = (label, qty) => `${qty} ${qty === 1 || /s$/i.test(label) ? label : label + 's'}`;

module.exports = { unitText, money, bestDiscount, quote, stars, parseStars, fillTemplate, ticketChannelName, durationLabel };
