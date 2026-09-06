const { kv } = require('@vercel/kv');
const apps = require('../../lib/applications');
const settingsLib = require('../../lib/settings');
const { getSettings, activeRecipients, recipientName } = settingsLib;
const outbox = require('../../lib/outbox');
const mailer = require('../../lib/mailer');

// Daily sweep of every open board poll:
//   day 5  -> remind whoever has not voted
//   day 12 -> remind them again
//   day 14 -> close the poll and send the result to the ticked recipients
//
// Every stage goes out on whichever channels each recipient has ticked: email
// leaves from here, WhatsApp and LINE are queued for the senders on Mark's Mac.
//
// Every send is recorded on the application before the next run, so a stage
// never fires twice, and a run that is missed entirely is picked up by the
// next one rather than skipped.
module.exports = async (req, res) => {
  const authorised =
    req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` ||
    (process.env.ADMIN_PASSWORD && req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD);

  if (!authorised) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  const now = Date.now();
  const actions = [];
  const errors = [];

  let settings;
  let ticked;
  let list;
  try {
    settings = await getSettings();
    ticked = activeRecipients(settings);
    list = await apps.getApplications();
  } catch (err) {
    console.error('Poll cron could not read state:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }

  // Upstash drops a database that sees no traffic for 14 days. This runs daily
  // and already reads KV; one write makes that explicit, which is all the
  // separate keepalive cron did - weekly, and at the cost of a function slot.
  try {
    await kv.set('keepalive:last', Date.now());
  } catch (err) {
    console.error('keepalive write failed:', err);
  }

  const transporter = mailer.createTransporter();

  for (const app of list) {
    // Applications submitted before the poll feature existed have no
    // pollOpenedAt; leave them alone rather than mailing about old records.
    if (!app.pollOpenedAt || app.pollStatus === 'closed' || app.archived) continue;

    const age = apps.daysSince(app.pollOpenedAt, now);
    if (age === null) continue;

    try {
      const votes = await apps.getVotes(app.id);
      const t = apps.tally(app, votes);

      // Somebody who was asked but is no longer on the recipients list still
      // gets their email, exactly as before. The only person skipped is one
      // who is on the list with email deliberately unticked.
      const emailOff = (email) => {
        const r = settingsLib.recipientByEmail(settings, email);
        return !!r && !settingsLib.channelsOf(r).includes('email');
      };

      if (age >= apps.CLOSE_DAYS) {
        const result = apps.outcome(t);
        const html = mailer.wrap(
          `Application Result: ${app.name}`,
          mailer.resultBody(app.name, result, t, apps.CLOSE_DAYS)
        );
        const subject = `Result: Membership Application - ${app.name} - ${result.label}`;

        const sent = [];
        if (!dryRun) {
          for (const email of ticked) {
            try {
              await transporter.sendMail(mailer.message({ to: email, subject, html }));
              sent.push(email);
            } catch (err) {
              console.error(`Result email to ${email} failed for ${app.id}:`, err);
              errors.push({ app: app.id, stage: 'result', email, error: err.message });
            }
          }
          await apps.updateApplication(app.id, {
            pollStatus: 'closed',
            pollClosedAt: new Date().toISOString(),
            pollResult: result.label,
            pollTally: {
              approved: t.approved.length,
              rejected: t.rejected.length,
              noResponse: t.pending.length,
            },
            resultSentTo: sent,
          });
        }

        // The board members on WhatsApp or LINE hear the result where they
        // were asked. Queued, not sent - the senders on the Mac deliver it.
        const told = dryRun
          ? { entries: [] }
          : await outbox.askBoard(settings, app, { kind: 'result', result, tally: t });

        actions.push({
          app: app.id,
          name: app.name,
          ageDays: Math.floor(age),
          stage: 'closed',
          result: result.label,
          notified: dryRun ? ticked : sent,
          queued: told.entries.map(e => `${e.name} (${e.channel})`),
        });
        continue;
      }

      // Reminder stages. Take the latest stage that is due but unsent so a
      // gap in cron runs cannot produce two reminders on the same day.
      const already = Array.isArray(app.remindersSent) ? app.remindersSent : [];
      const due = apps.REMINDER_DAYS.filter(d => age >= d && !already.includes(d));
      if (!due.length) continue;

      if (!t.pending.length) {
        // Everyone has voted - record the stages so they do not fire later.
        if (!dryRun) {
          await apps.updateApplication(app.id, { remindersSent: already.concat(due) });
        }
        actions.push({ app: app.id, name: app.name, stage: 'reminder-skipped', reason: 'all voted' });
        continue;
      }

      const stage = Math.max(...due);
      const daysLeft = apps.CLOSE_DAYS - age;
      const attachments = await apps.getAttachments(app);
      const subject = `Reminder: Membership Application - ${app.name}`;

      const sent = [];
      let queued = [];
      if (!dryRun) {
        for (const { email } of t.pending) {
          if (emailOff(email)) continue;
          try {
            const html =
              mailer.wrap(
                `Reminder: Application from ${app.name}`,
                mailer.reminderBody(app.name, daysLeft, apps.CLOSE_DAYS)
              ) +
              mailer.voteSection(
                app.id,
                email,
                recipientName(settings, email),
                'Your Vote Is Still Outstanding'
              );
            await transporter.sendMail(mailer.message({ to: email, subject, html, attachments }));
            sent.push(email);
          } catch (err) {
            console.error(`Reminder to ${email} failed for ${app.id}:`, err);
            errors.push({ app: app.id, stage: `day-${stage}`, email, error: err.message });
          }
        }

        // The same nudge on WhatsApp and LINE, to the same people - whoever
        // has not voted and has one of those ticked.
        const nudged = await outbox.askBoard(settings, app, {
          kind: `reminder-${stage}`,
          only: t.pending.map(pv => pv.email),
          closeDays: apps.CLOSE_DAYS,
          daysLeft,
        });
        queued = nudged.entries.map(e => `${e.name} (${e.channel})`);

        await apps.updateApplication(app.id, {
          remindersSent: already.concat(due),
          lastReminderAt: new Date().toISOString(),
        });
      }

      actions.push({
        app: app.id,
        name: app.name,
        ageDays: Math.floor(age),
        stage: `reminder-day-${stage}`,
        notified: dryRun ? t.pending.map(pv => pv.email) : sent,
        queued,
      });
    } catch (err) {
      console.error(`Poll cron failed for ${app.id}:`, err);
      errors.push({ app: app.id, stage: 'unexpected', error: err.message });
    }
  }

  return res.json({
    ok: true,
    dryRun: !!dryRun,
    checked: list.length,
    actions,
    errors,
  });
};
