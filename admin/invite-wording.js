// The invitation wordings and the rules for filling them in, shared by the
// Invite page and the invite inside each meeting of the planner. Kept in one
// place so both send the same words, and a guest's name and language are
// worked out the same way whichever page sent it.

// Ten wordings so repeat invitations do not read like a mail merge.
const VARIANTS = [
  { label: 'Warm and short',
    en: 'Hello {name}, our next Rotary meeting is coming up and I would really like to have you there. Are you free that evening?\nBest regards, Mark',
    de: 'Hallo {name}, unser nächstes Rotary-Treffen steht an und ich hätte Dich sehr gerne dabei. Hast Du an dem Abend Zeit?\nHerzliche Grüße, Mark' },
  { label: 'Good to see you',
    en: 'Hi {name}, we meet again at Rotary soon and it would be really good to see you there.\nAll the best, Mark',
    de: 'Hallo {name}, wir treffen uns bald wieder bei Rotary und es wäre wirklich schön, Dich dort zu sehen.\nViele Grüße, Mark' },
  { label: 'As my guest',
    en: 'Hello {name}, I would be delighted to bring you along as my guest to our next Rotary meeting. Does that work for you?\nWarm regards, Mark',
    de: 'Hallo {name}, ich würde Dich sehr gerne als meinen Gast zum nächsten Rotary-Treffen mitnehmen. Passt Dir das?\nGanz herzliche Grüße, Mark' },
  { label: 'Thought of you',
    en: 'Hi {name}, I thought of you when I saw the programme for our next Rotary meeting. Would you like to come along with me?\nHope to see you there, Mark',
    de: 'Hallo {name}, beim Programm für unser nächstes Rotary-Treffen musste ich an Dich denken. Magst Du mitkommen?\nSchöne Grüße, Mark' },
  { label: 'Direct invitation',
    en: 'Hello {name}, I would like to invite you to our next Rotary meeting. It would be lovely to have you with us.\nBest wishes, Mark',
    de: 'Hallo {name}, ich möchte Dich herzlich zu unserem nächsten Rotary-Treffen einladen. Es wäre schön, Dich dabeizuhaben.\nBeste Grüße, Mark' },
  { label: 'Casual',
    en: 'Hi {name}, any chance you are free for our next Rotary meeting? Would be good to have you along.\nCheers, Mark',
    de: 'Hallo {name}, hast Du beim nächsten Rotary-Treffen zufällig Zeit? Wäre schön, Dich dabeizuhaben.\nLiebe Grüße, Mark' },
  { label: 'A good evening',
    en: 'Hello {name}, our next Rotary meeting is coming up - good company and an interesting talk. I would love to have you there.\nWarm wishes, Mark',
    de: 'Hallo {name}, unser nächstes Rotary-Treffen steht an - nette Leute und ein interessanter Vortrag. Ich hätte Dich gerne dabei.\nHerzlichst, Mark' },
  { label: 'Go together',
    en: 'Hi {name}, I am going to our next Rotary meeting - shall we go together? I would enjoy the company.\nTake care, Mark',
    de: 'Hallo {name}, ich gehe zu unserem nächsten Rotary-Treffen - wollen wir zusammen hin? Ich würde mich über Deine Begleitung freuen.\nAlles Gute, Mark' },
  { label: 'Been a while',
    en: 'Hello {name}, it has been far too long. Our next Rotary meeting would be a good chance to catch up - will you come?\nSee you soon, Mark',
    de: 'Hallo {name}, es ist viel zu lange her. Unser nächstes Rotary-Treffen wäre eine gute Gelegenheit, sich wiederzusehen - kommst Du?\nBis bald, Mark' },
  { label: 'A little formal',
    en: 'Dear {name}, I would like to invite you to our next meeting of the Rotary Club Bangkok DACH. It would be a pleasure to welcome you.\nKindest regards, Mark',
    de: 'Hallo {name}, ich möchte Dich sehr gerne zu unserem nächsten Treffen des Rotary Club Bangkok DACH einladen. Es wäre mir eine Freude, Dich dort zu begrüßen.\nMit besten Grüßen, Mark' },
];

// What to call them: the nickname when there is one, the stored first name
// otherwise. Never the display name - WhatsApp names are surname-first, so
// the first word is often the surname, which is the bug we fixed on the
// guests page. Neither on file means "not invitable yet", and must stay
// that way.
const firstNameOf = (p) => ((p.nickname || '').trim() || (p.firstName || '').trim());

// Thai guests are addressed "Khun Somchai" - the title sits in front of the
// first name, it does not replace it.
function greetingName(p) {
  const first = firstNameOf(p);
  if (!first) return '';
  return [(p.honorific || '').trim(), first].filter(Boolean).join(' ');
}

// Language comes from the guest record, nothing else.
const langOf = (p) => (p.language === 'de' ? 'de' : 'en');

// The closing line is the last line of a wording ("Best regards, Mark").
// Anything added to it - the programme, a meeting's details, a website link -
// belongs above it, not trailing after the signature. A long last line is
// prose rather than a sign-off, so it is left where it is.
// A closing line is short, has a comma before the name and is not a
// sentence or a programme bullet. When a hand-written message has none,
// the additions simply go at the end, as they always did.
const isSignoff = (line) =>
  line.length <= 60 && line.includes(',') && !/[.!?]/.test(line)
  && !/^[-*\d]/.test(line) && !/\s-\s/.test(line);

function splitSignoff(text) {
  const s = String(text || '');
  const i = s.lastIndexOf('\n');
  const last = i === -1 ? '' : s.slice(i + 1).trim();
  if (!isSignoff(last)) return { body: s, signoff: '' };
  return { body: s.slice(0, i).replace(/\s+$/, ''), signoff: last };
}

function insertBeforeSignoff(text, blocks) {
  const parts = blocks.map(b => (b || '').trim()).filter(Boolean);
  if (!parts.length) return text;              // nothing to add, leave it exactly as typed
  const { body, signoff } = splitSignoff(text);
  return [body, ...parts, signoff].filter(Boolean).join('\n\n');
}

// One evening, written out: the day, the time, where, and what it is about.
// The meeting's own details go in the message rather than behind a link - the
// flyer page needs an admin password, so a guest could not open it anyway.
function meetingDetails(date, m, lang) {
  const de = lang === 'de';
  const day = new Date(date).toLocaleDateString(de ? 'de-DE' : 'en-GB',
    { weekday: 'long', day: '2-digit', month: 'long', timeZone: 'UTC' });
  const venue = (m && m.venue) || 'Grand Hyatt Erawan';
  const what = (m && (m.topic || m.presenter)) || '';
  return `${day}, 18:30${de ? ' Uhr' : ''} - ${venue}` + (what ? `\n${what}` : '');
}
