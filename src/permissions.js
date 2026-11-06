'use strict';
/**
 * Who may do what with whom. Pure functions so the rules stay easy to test.
 *
 *   founder  – owns the dashboard. Creates and deletes admins, configures Discord, webhooks and the bot.
 *              Invisible to admins.
 *   admin    – manages regular users (limits, time, rename, delete). Cannot touch other admins or the founder.
 *   user     – uses their own bots.
 */
const ROLES = ['founder', 'admin', 'user'];
const isStaff = (u) => !!u && (u.role === 'admin' || u.role === 'founder');
const isFounder = (u) => !!u && u.role === 'founder';

/** Can the actor see this account in the account list? */
function canSee(actor, target) {
  if (!isStaff(actor) || !target) return false;
  if (target.role === 'founder') return actor.role === 'founder';
  return true;
}

/** Edit limit/lifetime, add time, rename, reset. Founder: everyone else; admin: regular users only. */
function canManage(actor, target) {
  if (!isStaff(actor) || !target || actor.id === target.id) return false;
  if (actor.role === 'founder') return target.role !== 'founder';
  return target.role === 'user';
}

/** Deleting follows the same rule: admins can never delete admins or the founder. */
const canDelete = canManage;

function canCreate(actor, role) {
  if (!isStaff(actor)) return false;
  if (role === 'user') return true;
  if (role === 'admin') return actor.role === 'founder';
  return false;
}

/** "View as" only makes sense for regular users. */
function canViewAs(actor, target) {
  return isStaff(actor) && !!target && target.role === 'user';
}

module.exports = { ROLES, isStaff, isFounder, canSee, canManage, canDelete, canCreate, canViewAs };
